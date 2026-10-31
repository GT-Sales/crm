import { describe, expect, it } from 'vitest';
import { sourceReportRowSchema } from '@gt-sales/contracts';

import { shapeSourceReport, type SourceGroupRow } from '../src/reports/store.js';

const group = (
  source: string,
  received: number,
  options: Partial<Omit<SourceGroupRow, 'source' | 'received'>> = {},
): SourceGroupRow => ({
  source,
  kind: options.kind ?? 'utm',
  campaign: options.campaign ?? null,
  received,
  submitted: options.submitted ?? received,
  madeIt: options.madeIt ?? 0,
});

const pad = (n: number) => String(n).padStart(2, '0');

describe('shapeSourceReport', () => {
  it('lists the 50 sources with the most leads and sums the rest into Other', () => {
    const groups = Array.from({ length: 55 }, (_, index) =>
      group(`utm:s${pad(index + 1)}`, index === 0 ? 5 : 1),
    );
    const rows = shapeSourceReport(groups);
    expect(rows).toHaveLength(51);
    expect(rows[0]).toMatchObject({ source: 'utm:s01', received: 5 });
    expect(rows.slice(1, 50).map((row) => row.source)).toEqual(
      Array.from({ length: 49 }, (_, index) => `utm:s${pad(index + 2)}`),
    );
    expect(rows[50]).toEqual({
      source: 'other',
      kind: 'other',
      received: 5,
      submitted: 5,
      madeIt: 0,
      campaigns: [],
    });
    for (const row of rows) expect(sourceReportRowSchema.safeParse(row).success).toBe(true);
  });

  it('lists exactly 50 sources with no Other row', () => {
    const rows = shapeSourceReport(
      Array.from({ length: 50 }, (_, index) => group(`utm:s${pad(index + 1)}`, 1)),
    );
    expect(rows).toHaveLength(50);
    expect(rows.some((row) => row.kind === 'other')).toBe(false);
  });

  it('orders ties by code point', () => {
    const rows = shapeSourceReport([
      group('utm:a', 1),
      group('utm:B', 1),
      group('direct', 1, { kind: 'direct' }),
    ]);
    expect(rows.map((row) => row.source)).toEqual(['direct', 'utm:B', 'utm:a']);
  });

  it('lists 20 campaigns per source and sums the rest into an Other campaign', () => {
    // c01 has 25 leads, c25 has 1: the five smallest are c21…c25 (5+4+3+2+1).
    const groups = Array.from({ length: 25 }, (_, index) =>
      group('utm:google/cpc', 25 - index, { campaign: `c${pad(index + 1)}`, madeIt: 1 }),
    );
    const [row] = shapeSourceReport(groups);
    expect(row?.campaigns).toHaveLength(21);
    expect(row?.campaigns.slice(0, 20).map((campaign) => campaign.campaign)).toEqual(
      Array.from({ length: 20 }, (_, index) => `c${pad(index + 1)}`),
    );
    expect(row?.campaigns[20]).toEqual({
      campaign: null,
      other: true,
      received: 15,
      submitted: 15,
      madeIt: 5,
    });
    expect(row?.received).toBe(325);
    expect(row?.madeIt).toBe(25);
  });

  it('puts no campaign after a named one with the same count', () => {
    const [row] = shapeSourceReport([
      group('utm:g', 2, { campaign: null }),
      group('utm:g', 2, { campaign: 'zeta' }),
      group('utm:g', 3, { campaign: 'alpha' }),
    ]);
    expect(row?.campaigns.map((campaign) => campaign.campaign)).toEqual(['alpha', 'zeta', null]);
    expect(row?.campaigns.every((campaign) => !campaign.other)).toBe(true);
  });

  it('sums one source split over campaign groups into one row', () => {
    const rows = shapeSourceReport([
      group('utm:g', 1, { campaign: 'a', submitted: 1, madeIt: 1 }),
      group('utm:g', 2, { campaign: 'b', submitted: 1, madeIt: 0 }),
      group('utm:g', 3, { campaign: null, submitted: 2, madeIt: 1 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'utm:g',
      kind: 'utm',
      received: 6,
      submitted: 4,
      madeIt: 2,
    });
    expect(rows[0]?.campaigns).toHaveLength(3);
  });

  it('gives partner, referrer and direct rows no campaigns', () => {
    const rows = shapeSourceReport([
      group('partner:PT-7', 3, { kind: 'partner' }),
      group('referrer:bing.com', 2, { kind: 'referrer' }),
      group('direct', 1, { kind: 'direct' }),
    ]);
    expect(rows.map((row) => [row.source, row.kind, row.campaigns])).toEqual([
      ['partner:PT-7', 'partner', []],
      ['referrer:bing.com', 'referrer', []],
      ['direct', 'direct', []],
    ]);
  });

  it('returns no rows for no groups', () => {
    expect(shapeSourceReport([])).toEqual([]);
  });
});
