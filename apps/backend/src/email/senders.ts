import type { SenderIdentity } from '@gt-sales/adapters';
import { withTenantTx, type DatabaseClient, type TenantTransaction } from '@gt-sales/db';
import { DEFAULT_EMAIL_BRAND_COLOR } from '@gt-sales/contracts';
import { z } from 'zod';

import { hashContact } from './hash.js';
import type { EmailBranding } from './layout.js';
import { readEmailSettings } from './settings-store.js';
import type { Scope } from '../tenant-scope.js';

/**
 * Each site's own sender for mail to its customers: Get Canada Sim writes to
 * its customers as Get Canada Sim, from its own verified domain, never as the
 * CRM. A site's saved email settings (Settings → Email) name it; until an
 * owner saves them, the deployment's configuration (`EMAIL_SENDERS_JSON`,
 * addresses and names only, no secrets) is the fallback. Every site's domain
 * must be verified in the one Resend account `RESEND_API_KEY` belongs to.
 */
const siteSenderSchema = z
  .object({
    workspaceId: z.uuid(),
    fromAddress: z.email(),
    fromName: z.string().trim().min(1).max(100),
    replyToAddress: z.email().optional(),
    /** The site's public address, for links back to it (Get Canada Sim's `/track`). */
    siteUrl: z.url().optional(),
  })
  .strict();

export interface SiteSender extends SenderIdentity {
  siteUrl?: string;
}

export interface EmailSenders {
  forWorkspace(workspaceId: string): SiteSender | undefined;
}

/** The configured senders; none at all (so no customer mail) when unset or malformed. */
export function loadEmailSenders(env: NodeJS.ProcessEnv = process.env): EmailSenders {
  const raw = env.EMAIL_SENDERS_JSON?.trim();
  let entries: unknown = [];
  if (raw) {
    try {
      entries = JSON.parse(raw);
    } catch {
      entries = [];
    }
  }
  const parsed = z.array(siteSenderSchema).safeParse(entries);
  const byWorkspace = new Map<string, SiteSender>();
  // One sender per site; a site listed twice gets none rather than a guess.
  const duplicates = new Set<string>();
  for (const entry of parsed.success ? parsed.data : []) {
    if (byWorkspace.has(entry.workspaceId)) duplicates.add(entry.workspaceId);
    byWorkspace.set(entry.workspaceId, {
      fromAddress: entry.fromAddress,
      fromName: entry.fromName,
      replyToAddress: entry.replyToAddress,
      siteUrl: entry.siteUrl?.replace(/\/+$/, ''),
    });
  }
  for (const workspaceId of duplicates) byWorkspace.delete(workspaceId);
  return { forWorkspace: (workspaceId) => byWorkspace.get(workspaceId) };
}

/** Who a site's customer mail comes from, how it looks, and the site's address for links back. */
export interface ResolvedSender {
  sender: { fromName: string; fromAddress: string; replyToAddress?: string };
  branding: EmailBranding;
  siteUrl: string | null;
}

/** What the deployment brings to customer mail, whichever site sends. */
export interface CustomerEmailEnvironment {
  /**
   * The deployment can send customer mail: a selected provider that can send
   * (Resend with its key, or the fake outside production) and the
   * contact-hash secret every queued mail is recorded by.
   */
  readonly providerReady: boolean;
  /** The keyed digest suppression and delivery records match the address by. */
  contactHash(email: string): string;
  /** `EMAIL_SENDERS_JSON`: each site's sender until its owner saves settings. */
  readonly fallbackSenders: EmailSenders;
}

export function customerEmailEnvironmentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CustomerEmailEnvironment {
  const providerReady =
    env.EMAIL_PROVIDER === 'resend'
      ? Boolean(env.RESEND_API_KEY)
      : env.EMAIL_PROVIDER === 'fake' && env.NODE_ENV !== 'production';
  const secret = env.EMAIL_CONTACT_HASH_SECRET;
  const secretReady = typeof secret === 'string' && secret.length >= 16;
  return {
    providerReady: providerReady && secretReady,
    contactHash: (email) => {
      if (!secretReady || !secret) throw new Error('EMAIL_CONTACT_HASH_SECRET is not configured');
      return hashContact(email, secret);
    },
    fallbackSenders: loadEmailSenders(env),
  };
}

/**
 * The site's sender: its saved settings, else its `EMAIL_SENDERS_JSON` entry
 * in the default look (the default colour, no logo, no footer), else none.
 * The site's name in a mail is the name it sends from.
 */
export async function resolveSiteSender(
  tx: TenantTransaction,
  environment: CustomerEmailEnvironment,
  workspaceId: string,
): Promise<ResolvedSender | undefined> {
  const settings = await readEmailSettings(tx, workspaceId);
  if (settings) {
    return {
      sender: {
        fromName: settings.fromName,
        fromAddress: settings.fromAddress,
        ...(settings.replyTo ? { replyToAddress: settings.replyTo } : {}),
      },
      branding: {
        siteName: settings.fromName,
        logoUrl: settings.logoUrl,
        brandColor: settings.brandColor,
        footerText: settings.footerText,
      },
      siteUrl: settings.siteUrl,
    };
  }
  const fallback = environment.fallbackSenders.forWorkspace(workspaceId);
  if (!fallback) return undefined;
  return {
    sender: {
      fromName: fallback.fromName,
      fromAddress: fallback.fromAddress,
      ...(fallback.replyToAddress ? { replyToAddress: fallback.replyToAddress } : {}),
    },
    branding: {
      siteName: fallback.fromName,
      logoUrl: null,
      brandColor: DEFAULT_EMAIL_BRAND_COLOR,
      footerText: '',
    },
    siteUrl: fallback.siteUrl ?? null,
  };
}

/** What a staff route needs to know about mailing a site's customers. */
export interface CustomerEmail {
  readonly environment: CustomerEmailEnvironment;
  /** The deployment can send and the site has a sender (one tenant transaction). */
  available(ctx: Scope): Promise<boolean>;
  /** The site's `EMAIL_SENDERS_JSON` sender, which its mail uses until settings are saved. */
  fallback(workspaceId: string): SiteSender | undefined;
}

/** Customer mail from the environment; missing the provider, the secret or a sender, a site cannot send. */
export function customerEmailFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  database: Pick<DatabaseClient, 'withTenantTx'> = { withTenantTx },
): CustomerEmail {
  const environment = customerEmailEnvironmentFromEnv(env);
  return {
    environment,
    available: async (ctx) => {
      if (!environment.providerReady) return false;
      const sender = await database.withTenantTx(ctx, (tx) =>
        resolveSiteSender(tx, environment, ctx.workspaceId),
      );
      return sender !== undefined;
    },
    fallback: (workspaceId) => environment.fallbackSenders.forWorkspace(workspaceId),
  };
}
