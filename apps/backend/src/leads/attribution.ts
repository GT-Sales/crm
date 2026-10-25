import { attributionSchema, type Attribution, type RawAttribution } from '@gt-sales/contracts';

const UTM_MAX = 120;
const PARTNER_CODE_MAX = 64;
const REFERRER_HOST_MAX = 253;
const LANDING_PATH_MAX = 512;

/**
 * Referrer origins whose traffic is attributed by hostname (REQ 35 "approved
 * referrer origins"). Anything else — including the raw URL, its query
 * string or any embedded token — is reduced to its hostname. Extend this list
 * as new paid/organic channels are added; it is intentionally small at launch.
 */
const APPROVED_REFERRER_HOSTS = new Set([
  'google.com',
  'www.google.com',
  'bing.com',
  'www.bing.com',
  'facebook.com',
  'm.facebook.com',
  'l.facebook.com',
  'instagram.com',
  'tiktok.com',
  'youtube.com',
  't.co',
]);

/**
 * Known landing-route templates (REQ 35 "known landing-route templates").
 * A submitted path is reduced to its bare path (query string, fragment and
 * any token stripped first) and must fully match one of these before it is
 * stored; anything else — an arbitrary raw path — is dropped. Extend this
 * list alongside the site's real routes.
 */
const LANDING_ROUTE_TEMPLATES: readonly RegExp[] = [
  /^\/$/,
  /^\/(?:order|plans|privacy|terms|track)$/,
  /^\/plans\/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/,
];

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return undefined;
  return trimmed;
}

function boundedAttributionValue(value: unknown, maxLength: number): string | undefined {
  const bounded = boundedString(value, maxLength);
  if (!bounded) return undefined;
  if (/[?#&=]/.test(bounded)) return undefined;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(bounded)) return undefined;
  if (/(?:access[_-]?token|auth[_-]?token|session[_-]?token|secret|password)/i.test(bounded)) {
    return undefined;
  }
  if (/^\+?[\d ()-]{7,}$/.test(bounded)) return undefined;
  return bounded;
}

function sanitizeReferrerHost(value: unknown): string | undefined {
  const raw = boundedString(value, LANDING_PATH_MAX);
  if (!raw) return undefined;
  let host: string;
  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    host = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host.length > REFERRER_HOST_MAX) return undefined;
  return host && APPROVED_REFERRER_HOSTS.has(host) ? host : undefined;
}

function sanitizeLandingPath(value: unknown): string | undefined {
  const raw = boundedString(value, LANDING_PATH_MAX);
  if (!raw) return undefined;
  // Strip a query string, fragment, or anything after it (e.g. an embedded
  // token) before matching — only the bare path may be stored.
  const path = raw.split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/')) return undefined;
  return LANDING_ROUTE_TEMPLATES.some((template) => template.test(path)) ? path : undefined;
}

/**
 * Reduces arbitrary submitted attribution to the bounded, allowlisted shape
 * that is ever persisted (REQ 35). Never throws: an unrecognized field,
 * overlong value, unapproved referrer, or unrecognized landing path is
 * silently dropped rather than failing the request. `partnerCode` itself is
 * always kept verbatim when present and bounded — whether it resolves to an
 * active partner is decided separately (see `matchPartnerCode`), so an
 * unknown code is still stored, just not linked.
 */
export function sanitizeAttribution(raw: RawAttribution | undefined): Attribution {
  if (!raw) return {};

  const attribution: Attribution = {};
  const utmSource = boundedAttributionValue(raw['utmSource'], UTM_MAX);
  if (utmSource) attribution.utmSource = utmSource;
  const utmMedium = boundedAttributionValue(raw['utmMedium'], UTM_MAX);
  if (utmMedium) attribution.utmMedium = utmMedium;
  const utmCampaign = boundedAttributionValue(raw['utmCampaign'], UTM_MAX);
  if (utmCampaign) attribution.utmCampaign = utmCampaign;
  const utmTerm = boundedAttributionValue(raw['utmTerm'], UTM_MAX);
  if (utmTerm) attribution.utmTerm = utmTerm;
  const utmContent = boundedAttributionValue(raw['utmContent'], UTM_MAX);
  if (utmContent) attribution.utmContent = utmContent;

  const referrerHost = sanitizeReferrerHost(raw['referrerHost']);
  if (referrerHost) attribution.referrerHost = referrerHost;

  const landingPath = sanitizeLandingPath(raw['landingPath']);
  if (landingPath) attribution.landingPath = landingPath;

  const partnerCode = boundedString(raw['partnerCode'], PARTNER_CODE_MAX);
  if (partnerCode) attribution.partnerCode = partnerCode;

  // Re-parsed through the strict contract schema as a final guarantee that
  // nothing above can ever drift from the stored/returned shape.
  return attributionSchema.parse(attribution);
}
