import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Customer replies. A mail to a lead's customer goes out with its own
 * reply-to address, `<site tag>-<lead id>-<signature>@<inbound domain>`, on a
 * domain the mail provider receives for. A reply to it comes back through the
 * provider's "email received" webhook, and the address alone says which site
 * and lead it belongs to. The signature (an HMAC over the site and the lead)
 * is what stops anyone who can guess a lead id from writing into a lead's
 * conversation: an address this deployment did not make is ignored.
 *
 * Configured by `EMAIL_INBOUND_DOMAIN` and `EMAIL_INBOUND_SITES` (JSON
 * `[{"workspaceId":"…","tag":"cw"}]`), signed with `EMAIL_CONTACT_HASH_SECRET`.
 * Unset or invalid, mail keeps the site's own reply-to and nothing is received.
 */
export interface ReplyAddressing {
  /** The reply-to address for a mail to this lead; undefined for a site with no tag. */
  addressFor(workspaceId: string, leadId: string): string | undefined;
  /** The site and lead an address was made for; undefined for any other address. */
  resolve(address: string): { workspaceId: string; leadId: string } | undefined;
  /** Whether replies to this site's mail come back to the CRM. */
  enabledFor(workspaceId: string): boolean;
}

const SIGNATURE_HEX = 16;
const sitesSchema = z
  .array(z.object({ workspaceId: z.uuid(), tag: z.string().regex(/^[a-z][a-z0-9]{1,11}$/) }))
  .min(1)
  .max(50);
const domainSchema = z
  .string()
  .max(190)
  .regex(/^(?=.{4,190}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/);

function sign(secret: string, workspaceId: string, leadId: string): string {
  return createHmac('sha256', secret)
    .update(`customer-reply:v1:${workspaceId}:${leadId}`)
    .digest('hex')
    .slice(0, SIGNATURE_HEX);
}

const hexOf = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
const uuidOf = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** Reply addressing from the environment, or undefined when it is not (validly) configured. */
export function loadReplyAddressing(
  env: NodeJS.ProcessEnv = process.env,
): ReplyAddressing | undefined {
  const domain = domainSchema.safeParse(env['EMAIL_INBOUND_DOMAIN']?.trim().toLowerCase());
  const secret = env['EMAIL_CONTACT_HASH_SECRET'] ?? '';
  let rawSites: unknown;
  try {
    rawSites = JSON.parse(env['EMAIL_INBOUND_SITES']?.trim() || 'null');
  } catch {
    return undefined;
  }
  const sites = sitesSchema.safeParse(rawSites);
  if (!domain.success || !sites.success || secret.length < 16) return undefined;
  const tagBySite = new Map(sites.data.map((site) => [site.workspaceId, site.tag]));
  const siteByTag = new Map(sites.data.map((site) => [site.tag, site.workspaceId]));
  // Two sites under one tag could not be told apart: refuse the whole setting.
  if (tagBySite.size !== sites.data.length || siteByTag.size !== sites.data.length)
    return undefined;

  return {
    enabledFor: (workspaceId) => tagBySite.has(workspaceId),
    addressFor(workspaceId, leadId) {
      const tag = tagBySite.get(workspaceId);
      if (!tag || !z.uuid().safeParse(leadId).success) return undefined;
      return `${tag}-${hexOf(leadId)}-${sign(secret, workspaceId, leadId)}@${domain.data}`;
    },
    resolve(address) {
      // Mail servers and clients may change an address's case; nothing here depends on it.
      const match = /^([a-z][a-z0-9]{1,11})-([0-9a-f]{32})-([0-9a-f]{16})@(.+)$/.exec(
        address.trim().toLowerCase(),
      );
      if (!match || match[4] !== domain.data) return undefined;
      const workspaceId = siteByTag.get(match[1] ?? '');
      if (!workspaceId) return undefined;
      const leadId = uuidOf(match[2] ?? '');
      const expected = Buffer.from(sign(secret, workspaceId, leadId));
      const given = Buffer.from(match[3] ?? '');
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
      return { workspaceId, leadId };
    },
  };
}

/**
 * What the customer wrote, without the mail they answered underneath it: mail
 * programs quote the earlier message below a line such as "On … wrote:".
 * Cut there, at the first quoted line, or at a forwarded-message rule,
 * whichever comes first. A reply that is only a quote keeps its text.
 */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const end = lines.findIndex(
    (line, index) =>
      /^\s*>/.test(line) ||
      /^\s*On .{1,200}wrote:\s*$/i.test(line) ||
      // The "On … wrote:" line is often wrapped over two lines.
      (/^\s*On .{1,200}$/i.test(line) && /wrote:\s*$/i.test(lines[index + 1] ?? '')) ||
      /^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}\s*$/i.test(line) ||
      /^\s*_{10,}\s*$/.test(line) ||
      (/^\s*From:\s.+$/i.test(line) && /^\s*(Sent|Date):\s/i.test(lines[index + 1] ?? '')),
  );
  const own = (end === -1 ? lines : lines.slice(0, end)).join('\n').trim();
  return own === '' ? text.trim() : own;
}

/** A mail's HTML as plain text, for a reply that came with no text part. */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>(\s*)/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      // Last, so that "&amp;lt;" stays the "&lt;" the customer typed.
      .replace(/&amp;/gi, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
