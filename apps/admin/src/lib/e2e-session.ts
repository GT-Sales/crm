/**
 * CQ-01 browser-test seam. Next.js inlines NEXT_PUBLIC_* values at build time,
 * so this returns a bearer token only in the separate e2e build made by
 * scripts/test-e2e-orders.mjs (output `.next-e2e`), and only on 127.0.0.1,
 * where the e2e backend harness accepts that token for its seeded owner. A
 * normal or Vercel build has `undefined` here (next.config.ts refuses to build
 * with the variable on Vercel), so the seam cannot exist in a deployment.
 */
export function e2eStaffBearer(): string | undefined {
  const bearer = process.env['NEXT_PUBLIC_E2E_STAFF_BEARER'];
  if (!bearer) return undefined;
  if (typeof window === 'undefined' || window.location.hostname !== '127.0.0.1') return undefined;
  return bearer;
}
