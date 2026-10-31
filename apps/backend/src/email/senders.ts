import { withTenantTx, type DatabaseClient, type TenantTransaction } from '@gt-sales/db';

import { hashContact } from './hash.js';
import type { EmailBranding } from './layout.js';
import { readEmailSettings } from './settings-store.js';
import type { Scope } from '../tenant-scope.js';

/**
 * Each site's own sender for mail to its customers: Get Canada Sim writes to
 * its customers as Get Canada Sim, from its own verified domain, never as the
 * CRM. A site's saved email settings (Settings → Email) name it; a site that
 * has not saved them cannot email its customers. Every site's domain must be
 * verified in the one Resend account `RESEND_API_KEY` belongs to.
 *
 * `ResolvedSender` is who a site's customer mail comes from, how it looks, and
 * the site's address for links back.
 */
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
  };
}

/**
 * The site's sender: its saved settings, else none. The site's name in a mail
 * is the name it sends from.
 */
export async function resolveSiteSender(
  tx: TenantTransaction,
  workspaceId: string,
): Promise<ResolvedSender | undefined> {
  const settings = await readEmailSettings(tx, workspaceId);
  if (!settings) return undefined;
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

/** What a staff route needs to know about mailing a site's customers. */
export interface CustomerEmail {
  readonly environment: CustomerEmailEnvironment;
  /** The deployment can send and the site has a sender (one tenant transaction). */
  available(ctx: Scope): Promise<boolean>;
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
        resolveSiteSender(tx, ctx.workspaceId),
      );
      return sender !== undefined;
    },
  };
}
