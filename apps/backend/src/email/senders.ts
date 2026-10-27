import type { SenderIdentity } from '@gt-sales/adapters';
import { z } from 'zod';

import { hashContact } from './hash.js';

/**
 * Each site's own sender for mail to its customers: Get Canada Sim writes to
 * its customers as Get Canada Sim, from its own verified domain, never as the
 * CRM. Deployment configuration (`EMAIL_SENDERS_JSON`), like the Umami site
 * mapping: addresses and names only, no secrets. Every site's domain must be
 * verified in the one Resend account `RESEND_API_KEY` belongs to.
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

/** What a staff route needs to mail a lead's customer. */
export interface CustomerEmail {
  /** The deployment sends mail and this site has its own sender. */
  available(workspaceId: string): boolean;
  sender(workspaceId: string): SiteSender | undefined;
  /** The keyed digest suppression and delivery records match the address by. */
  contactHash(email: string): string;
}

/**
 * Customer mail from the environment: a selected provider that can send
 * (Resend with its key, or the fake outside production), the contact-hash
 * secret, and the site's sender. Missing any one, no site can send.
 */
export function customerEmailFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  senders: EmailSenders = loadEmailSenders(env),
): CustomerEmail {
  const providerReady =
    env.EMAIL_PROVIDER === 'resend'
      ? Boolean(env.RESEND_API_KEY)
      : env.EMAIL_PROVIDER === 'fake' && env.NODE_ENV !== 'production';
  const secret = env.EMAIL_CONTACT_HASH_SECRET;
  const secretReady = typeof secret === 'string' && secret.length >= 16;
  return {
    available: (workspaceId) =>
      providerReady && secretReady && senders.forWorkspace(workspaceId) !== undefined,
    sender: (workspaceId) => senders.forWorkspace(workspaceId),
    contactHash: (email) => {
      if (!secretReady || !secret) throw new Error('EMAIL_CONTACT_HASH_SECRET is not configured');
      return hashContact(email, secret);
    },
  };
}
