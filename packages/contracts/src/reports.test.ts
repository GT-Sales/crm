import { describe, expect, it } from 'vitest';

import {
  SOURCE_REPORT_MAX_CAMPAIGNS,
  SOURCE_REPORT_MAX_SOURCES,
  SOURCE_REPORT_OTHER_SOURCE,
  SOURCE_REPORT_SUCCESS_STAGES,
  leadTypeCatalog,
  sourceReportQuerySchema,
  sourceReportResponseSchema,
  sourceReportRowSchema,
} from './index';

const UUID = '00000000-0000-4000-8000-000000000001';

const counts = (received: number, submitted: number, madeIt: number) => ({
  received,
  submitted,
  madeIt,
});

const response = {
  leadType: 'internet',
  days: 30,
  totals: counts(6, 5, 1),
  rows: [
    {
      source: 'utm:google/cpc',
      kind: 'utm',
      ...counts(3, 3, 1),
      campaigns: [
        { campaign: 'fall', other: false, ...counts(1, 1, 1) },
        { campaign: null, other: false, ...counts(2, 2, 0) },
      ],
    },
    { source: 'direct', kind: 'direct', ...counts(2, 1, 0), campaigns: [] },
    { source: SOURCE_REPORT_OTHER_SOURCE, kind: 'other', ...counts(1, 1, 0), campaigns: [] },
  ],
  withSourceData: 4,
  requestId: UUID,
};

describe('source report contracts', () => {
  it('counts a lead as made it at activated, installed, completed or won, all real stages', () => {
    expect(SOURCE_REPORT_SUCCESS_STAGES).toEqual(['activated', 'installed', 'completed', 'won']);
    const stageKeys = new Set(
      Object.values(leadTypeCatalog).flatMap((entry) => entry.stages.map((stage) => stage.key)),
    );
    for (const stage of SOURCE_REPORT_SUCCESS_STAGES) expect(stageKeys.has(stage)).toBe(true);
    expect(SOURCE_REPORT_MAX_SOURCES).toBe(50);
    expect(SOURCE_REPORT_MAX_CAMPAIGNS).toBe(20);
    expect(SOURCE_REPORT_OTHER_SOURCE).toBe('other');
  });

  it('parses the query: a window from the dashboard or none, nothing else', () => {
    expect(sourceReportQuerySchema.parse({ leadType: 'internet', days: '30' })).toEqual({
      leadType: 'internet',
      days: 30,
    });
    expect(sourceReportQuerySchema.parse({ leadType: 'internet' })).toEqual({
      leadType: 'internet',
    });
    expect(sourceReportQuerySchema.safeParse({ leadType: 'internet', days: '14' }).success).toBe(
      false,
    );
    expect(sourceReportQuerySchema.safeParse({ leadType: 'Not A Type!' }).success).toBe(false);
    expect(
      sourceReportQuerySchema.safeParse({ leadType: 'internet', days: '7', extra: '1' }).success,
    ).toBe(false);
  });

  it('round-trips a full response unchanged', () => {
    expect(sourceReportResponseSchema.parse(response)).toEqual(response);
    expect(sourceReportResponseSchema.parse({ ...response, days: null }).days).toBeNull();
  });

  it('refuses out-of-bounds values', () => {
    const [utm, direct] = response.rows;
    const withRow = (row: unknown) => ({ ...response, rows: [row] });
    expect(
      sourceReportResponseSchema.safeParse(withRow({ ...direct, source: 'x'.repeat(301) })).success,
    ).toBe(false);
    expect(
      sourceReportResponseSchema.safeParse(withRow({ ...direct, source: 'x'.repeat(300) })).success,
    ).toBe(true);
    expect(
      sourceReportResponseSchema.safeParse(
        withRow({
          ...utm,
          campaigns: [{ campaign: 'c'.repeat(121), other: false, ...counts(1, 1, 0) }],
        }),
      ).success,
    ).toBe(false);
    expect(sourceReportResponseSchema.safeParse(withRow({ ...direct, received: -1 })).success).toBe(
      false,
    );
    expect(sourceReportResponseSchema.safeParse({ ...response, days: 14 }).success).toBe(false);
    expect(
      sourceReportResponseSchema.safeParse(
        withRow({ ...utm, campaigns: [{ campaign: 'fall', ...counts(1, 1, 0) }] }),
      ).success,
    ).toBe(false);
    const rows = Array.from({ length: 52 }, (_, index) => ({
      ...direct,
      source: `utm:s${String(index)}`,
      kind: 'utm',
    }));
    expect(sourceReportResponseSchema.safeParse({ ...response, rows }).success).toBe(false);
    expect(
      sourceReportResponseSchema.safeParse({ ...response, rows: rows.slice(0, 51) }).success,
    ).toBe(true);
  });

  it('caps campaigns at twenty plus an Other row', () => {
    const campaigns = Array.from({ length: 22 }, (_, index) => ({
      campaign: `c${String(index)}`,
      other: false,
      ...counts(1, 1, 0),
    }));
    const row = { source: 'utm:g', kind: 'utm', ...counts(22, 22, 0), campaigns };
    expect(sourceReportRowSchema.safeParse(row).success).toBe(false);
    expect(
      sourceReportRowSchema.safeParse({ ...row, campaigns: campaigns.slice(0, 21) }).success,
    ).toBe(true);
  });
});
