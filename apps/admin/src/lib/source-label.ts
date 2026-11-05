/**
 * A lead's source as staff say it, from the backend's `deriveSource` label:
 * `utm:google/cpc` → `Google · paid`, `referrer:facebook.com` → `facebook.com`,
 * `partner:MAPLE10` → `Partner MAPLE10`, `direct` → `Direct`. The raw label stays
 * available (callers put it in a tooltip). Attribution is customer-influenced
 * text: it is only ever shown as text.
 */
const MEDIUM_WORDS: Readonly<Record<string, string>> = {
  cpc: 'paid',
  ppc: 'paid',
  paid: 'paid',
  paidsearch: 'paid',
  paid_search: 'paid',
  paid_social: 'paid social',
  paidsocial: 'paid social',
  organic: 'organic',
  email: 'email',
  newsletter: 'email',
  social: 'social',
  referral: 'referral',
  display: 'display',
  affiliate: 'affiliate',
};

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  google: 'Google',
  facebook: 'Facebook',
  fb: 'Facebook',
  instagram: 'Instagram',
  ig: 'Instagram',
  tiktok: 'TikTok',
  bing: 'Bing',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  whatsapp: 'WhatsApp',
};

function words(value: string): string {
  const trimmed = value.trim();
  const known = SOURCE_WORDS[trimmed.toLowerCase()];
  if (known) return known;
  return trimmed === '' ? trimmed : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function readableSource(source: string): string {
  if (source === 'direct') return 'Direct';
  if (source.startsWith('utm:')) {
    const [name = '', medium] = source.slice(4).split('/', 2);
    const label = words(name);
    if (!medium) return label;
    return `${label} · ${MEDIUM_WORDS[medium.trim().toLowerCase()] ?? medium.trim()}`;
  }
  if (source.startsWith('referrer:')) return source.slice('referrer:'.length);
  if (source.startsWith('partner:')) {
    const rest = source.slice('partner:'.length);
    return rest.endsWith(' (unmatched)')
      ? `Partner ${rest.slice(0, -' (unmatched)'.length)} (no match)`
      : `Partner ${rest}`;
  }
  return source;
}
