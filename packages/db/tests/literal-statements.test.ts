import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { rateLimitStatement, tenantContextStatement } from '../src/index.js';

// Unit test: no database. Statements every request runs travel without bind
// parameters (one round trip instead of two), so the guards on what may become
// a literal are the whole of their safety.
const WORKSPACE = '10000000-0000-4000-8000-000000000102';
const ACTOR = 'b8fbfaea-a3a8-4cfd-b609-d9d422fa7b7e';
const HOSTILE = [
  '',
  "x', true); drop table app.leads; --",
  `${WORKSPACE}'`,
  `${WORKSPACE} `,
  `${WORKSPACE}\n`,
  'back\\slash',
  'semi;colon',
];

describe('tenant context statement', () => {
  it('sets both ids for a tenant transaction and only the actor for an actor one', () => {
    expect(tenantContextStatement({ workspaceId: WORKSPACE, actorId: ACTOR })).toBe(
      `select set_config('app.workspace_id', '${WORKSPACE}', true), set_config('app.actor_id', '${ACTOR}', true)`,
    );
    expect(tenantContextStatement({ actorId: ACTOR })).toBe(
      `select set_config('app.actor_id', '${ACTOR}', true)`,
    );
  });

  it('accepts upper-case UUIDs, which Postgres reads the same', () => {
    expect(tenantContextStatement({ actorId: ACTOR.toUpperCase() })).toContain(ACTOR.toUpperCase());
  });

  it('refuses anything that is not a canonical UUID, so nothing can end the literal', () => {
    for (const value of [...HOSTILE, WORKSPACE.replaceAll('-', ''), `{${WORKSPACE}}`]) {
      expect(() => tenantContextStatement({ workspaceId: value, actorId: ACTOR })).toThrow(
        'tenant context ids must be UUIDs',
      );
      expect(() => tenantContextStatement({ actorId: value })).toThrow(
        'tenant context ids must be UUIDs',
      );
    }
  });
});

describe('rate-limit statement', () => {
  const dialect = new PgDialect();
  const render = (bucketKey: string, windowSeconds = 60, maxCount = 300) =>
    dialect.sqlToQuery(rateLimitStatement({ bucketKey, windowSeconds, maxCount }));

  it('sends a plain key and integer limits as literals', () => {
    for (const key of ['staff:ip:203.0.113.7', 'staff:ip:2001:db8::1', 'cred:ab12cd', 'unknown']) {
      const query = render(key);
      expect(query.params).toEqual([]);
      expect(query.sql).toContain(`app.rate_limit_hit('${key}', 60, 300)`);
    }
  });

  it('binds any other key, and non-integer limits, as parameters', () => {
    for (const key of [...HOSTILE, 'staff:ip:fe80::1%eth0', 'x'.repeat(201)]) {
      const query = render(key);
      expect(query.params).toEqual([key, 60, 300]);
      expect(query.sql).not.toContain(key === '' ? "''" : key);
    }
    expect(render('staff:ip:203.0.113.7', 1.5).params).toEqual(['staff:ip:203.0.113.7', 1.5, 300]);
  });
});
