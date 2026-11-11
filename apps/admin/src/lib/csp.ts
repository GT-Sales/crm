/**
 * The staff admin's Content-Security-Policy (REQ 37, audit M-1). The staff
 * session lives in localStorage (supabase-js), so an injected script could
 * read it; `script-src` therefore allows only scripts carrying this request's
 * nonce, and whatever those load (`'strict-dynamic'`). No `'unsafe-inline'`
 * for scripts: Next.js puts the nonce on its own scripts and on the theme
 * bootstrap in the root layout (it reads it from this request's header).
 * Built per request by `src/proxy.ts`; origins come from the public env.
 */
export interface CspEnvironment {
  isProduction: boolean;
  apiBaseUrl?: string | undefined;
  supabaseUrl?: string | undefined;
  sentryDsn?: string | undefined;
}

export function originOf(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function dedupe(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * Where signed document links point: Supabase Storage's own host,
 * `<ref>.storage.supabase.co`, next to the project's `<ref>.supabase.co`.
 * Previews show a document in an <img> or a PDF <iframe> from there.
 */
export function storageOriginOf(supabaseUrl: string | undefined): string | undefined {
  const origin = originOf(supabaseUrl);
  if (!origin) return undefined;
  const url = new URL(origin);
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);
  return match ? `https://${match[1]}.storage.supabase.co` : undefined;
}

/** A fresh, unguessable nonce for one response. */
export function createNonce(): string {
  return btoa(crypto.randomUUID());
}

export function buildContentSecurityPolicy(nonce: string, env: CspEnvironment): string {
  const apiOrigin = originOf(env.apiBaseUrl);
  const supabaseOrigin = originOf(env.supabaseUrl);
  const sentryOrigin = originOf(env.sentryDsn);
  const storageOrigin = storageOriginOf(env.supabaseUrl);
  // React's development build needs eval for its debugging aids; production never does.
  const scriptExtra = env.isProduction ? [] : ["'unsafe-eval'"];
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    // Its own icon, data:/blob: previews, and document previews from Storage.
    'img-src': dedupe(["'self'", 'data:', 'blob:', storageOrigin]),
    // A PDF document preview embeds the signed Storage link; nothing else frames.
    'frame-src': dedupe(["'self'", storageOrigin]),
    'font-src': ["'self'", 'data:'],
    // Styles stay inline-able: style attributes are everywhere (charts,
    // canvas) and a style cannot read the session.
    'style-src': ["'self'", "'unsafe-inline'"],
    'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...scriptExtra],
    // Backend API, Supabase Auth (token verification + refresh), and Sentry only:
    // a bare https: would let an injected script post the localStorage session
    // anywhere. Signed document links open in a new tab, not via fetch.
    'connect-src': dedupe(["'self'", apiOrigin, supabaseOrigin, sentryOrigin]),
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}
