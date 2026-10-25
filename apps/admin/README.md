# Admin console

Next.js staff-facing admin console. Every backend call goes through the shared
typed client in `@gt-sales/contracts` (`src/lib/api.ts`), authorized with
the staff Supabase access token.

## Configuration

`src/lib/api.ts` resolves the backend origin from `NEXT_PUBLIC_API_BASE_URL`
(falling back to `API_BASE_URL`, then `http://localhost:4000` for local dev).
In production this points at the Railway-hosted backend
(`https://backend-production-ebbb6.up.railway.app`). The backend's
`ADMIN_ORIGIN` variable must match this app's public origin so its CORS policy
admits requests from here.

Errors go to the Sentry project `gt-sales-crm-admin` through `NEXT_PUBLIC_SENTRY_DSN`
(set in Vercel production on 22 October 2026; `src/lib/error-tracking.ts` posts scrubbed
events without the Sentry SDK; `src/instrumentation.ts` reports server-side errors). The value is read at build time, so a change needs a new
admin build; a redeploy of the same commit is skipped by the `affected-builds` ignore step.
