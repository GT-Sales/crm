import type { Attribution } from '@gt-sales/contracts';

/**
 * A short, human-readable source label for the admin list's source column
 * (e.g. `utm:google/cpc`, `referrer:facebook.com`, `partner:MAPLE10`, `direct`).
 * Shared by the leads list and the orders list so both derive the same label
 * from the same sanitized attribution snapshot (REQ 20/35).
 */
export function deriveSource(attribution: Attribution): string {
  if (attribution.partnerCode) {
    return attribution.partnerCodeMatched
      ? `partner:${attribution.partnerCode}`
      : `partner:${attribution.partnerCode} (unmatched)`;
  }
  if (attribution.utmSource) {
    return attribution.utmMedium
      ? `utm:${attribution.utmSource}/${attribution.utmMedium}`
      : `utm:${attribution.utmSource}`;
  }
  if (attribution.referrerHost) return `referrer:${attribution.referrerHost}`;
  return 'direct';
}
