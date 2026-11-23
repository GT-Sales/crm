import { z } from 'zod';

/**
 * Signs a test account in the way the admin does (Supabase Auth email and
 * password, `apps/admin/src/app/login/page.tsx`), over the Auth REST API's
 * password grant with the publishable key. The access token stays in memory;
 * it is never logged or written.
 */

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  user: z.object({ id: z.uuid() }),
});

export interface Session {
  readonly accessToken: string;
  readonly userId: string;
  /** Epoch milliseconds after which the runner signs in again. */
  readonly refreshAfter: number;
}

export class SignInError extends Error {
  constructor(readonly status: number) {
    super(`sign-in failed (HTTP ${status})`);
    this.name = 'SignInError';
  }
}

export async function signIn(options: {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly email: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): Promise<Session> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = new URL('/auth/v1/token?grant_type=password', options.supabaseUrl);
  const response = await doFetch(url, {
    method: 'POST',
    headers: { apikey: options.publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: options.email, password: options.password }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  // Neither the body of a refusal nor the token is ever printed.
  if (!response.ok) throw new SignInError(response.status);
  const body = tokenResponseSchema.parse(await response.json());
  const now = options.now?.() ?? Date.now();
  return {
    accessToken: body.access_token,
    userId: body.user.id,
    // A minute early, and never later than 50 minutes (the default lifetime is an hour).
    refreshAfter: now + Math.min(body.expires_in * 1000 - 60_000, 50 * 60_000),
  };
}

/** A signed-in account that signs in again before its token expires. */
export class Account {
  private session: Session | undefined;

  constructor(
    private readonly options: Omit<Parameters<typeof signIn>[0], 'now'> & {
      readonly now?: () => number;
    },
  ) {}

  async current(): Promise<Session> {
    const now = this.options.now?.() ?? Date.now();
    if (!this.session || now >= this.session.refreshAfter) {
      this.session = await signIn(this.options);
    }
    return this.session;
  }
}
