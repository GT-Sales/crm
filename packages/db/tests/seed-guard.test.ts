import { describe, expect, it } from 'vitest';

import { assertSyntheticSeedTarget } from '../src/seed.js';

describe('synthetic seed target guard', () => {
  it('refuses hosted Supabase databases (direct and pooler hosts)', () => {
    for (const url of [
      'postgresql://postgres:x@db.ixbhodlvfyxjctpsjibj.supabase.co:5432/postgres',
      'postgresql://postgres.ref:x@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
    ]) {
      expect(() => assertSyntheticSeedTarget(url)).toThrow(/never targets a hosted Supabase/);
    }
  });

  it('allows local databases and explicitly disposable hosted ones', () => {
    expect(() =>
      assertSyntheticSeedTarget('postgresql://postgres:x@localhost:5432/canadian_plans'),
    ).not.toThrow();
    expect(() =>
      assertSyntheticSeedTarget('postgresql://postgres:x@db.example.supabase.co:5432/scratch_test'),
    ).not.toThrow();
  });
});
