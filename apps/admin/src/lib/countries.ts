/**
 * A country's English name from its ISO 3166 alpha-2 code ("IN" → "India"),
 * for reading only; the code stays what is stored and sent. An unknown or
 * malformed code is shown as given rather than hidden.
 */
let regionNames: Intl.DisplayNames | null | undefined;

export function countryName(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return code;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    } catch {
      regionNames = null;
    }
  }
  const name = regionNames?.of(normalized);
  // `ZZ` is ISO's own "unknown region": the code says more than that label.
  return name && name !== 'Unknown Region' ? name : code;
}
