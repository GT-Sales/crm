import { describe, expect, it } from 'vitest';

import { countCopyRows } from '../src/backup/copy-rows.js';

describe('countCopyRows', () => {
  it('counts rows per COPY block and ignores everything outside blocks', () => {
    const sql = `SET x;\nCOPY "app"."leads" ("id", "note") FROM stdin;\n1\tline one\\nstill row one\n2\tb\n\\.\n\nCOPY "app"."contacts" ("id") FROM stdin;\n\\.\n`;
    expect(countCopyRows(sql)).toEqual({ 'app.leads': 2, 'app.contacts': 0 });
  });

  it('throws copy_block_unterminated when a block has no terminator', () => {
    const sql = `COPY "app"."leads" ("id") FROM stdin;\n1\n2\n`;
    expect(() => countCopyRows(sql)).toThrow(new Error('copy_block_unterminated:app.leads'));
  });

  it('throws copy_block_unrecognized for a COPY line not in the quoted schema.table shape', () => {
    const line = 'COPY app.leads (id) FROM stdin;';
    expect(() => countCopyRows(`${line}\n1\n\\.\n`)).toThrow(
      new Error(`copy_block_unrecognized:${line}`),
    );
  });

  it('counts the filtered data dump the exporter writes, comments and SET lines included', () => {
    const sql = [
      'SET session_replication_role = replica;',
      '',
      '-- Data for Name: workspaces; Type: TABLE DATA; Schema: app; Owner: postgres',
      'COPY "app"."workspaces" ("id", "slug") FROM stdin;',
      'w1\tget-canada-sim',
      '',
      '\\.',
      'COPY "auth"."users" ("id") FROM stdin;',
      'u1',
      '\\.',
      'COPY "public"."we""ird" ("id") FROM stdin;',
      'x',
      '\\.',
      '',
      'RESET ALL;',
      '',
    ].join('\n');
    expect(countCopyRows(sql)).toEqual({
      'app.workspaces': 2,
      'auth.users': 1,
      'public.we"ird': 1,
    });
  });

  it('returns {} for a dump without COPY blocks', () => {
    expect(countCopyRows('SET session_replication_role = replica;\n\nRESET ALL;\n')).toEqual({});
  });
});
