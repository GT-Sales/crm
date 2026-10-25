'use client';

import { createClient } from '@supabase/supabase-js';

let cachedAuth: ReturnType<typeof createAuth> | undefined;

function createAuth() {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const publishableKey = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
  if (!url || !publishableKey) throw new Error('Staff authentication is not configured.');

  const { auth } = createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  });
  return auth;
}

export function isStaffAuthConfigured(): boolean {
  return Boolean(
    process.env['NEXT_PUBLIC_SUPABASE_URL'] && process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
  );
}

export function getStaffAuth(): ReturnType<typeof createAuth> {
  cachedAuth ??= createAuth();
  return cachedAuth;
}
