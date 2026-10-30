import { describe, expect, it } from 'vitest';
import { buildPropertyCatalog, codePropertyCatalog, type PlanOption } from '@gt-sales/contracts';

import { catalogFromModel } from './use-property-model';

const plans: PlanOption[] = [
  {
    id: '70000000-0000-4000-8000-000000000001',
    name: 'Prepaid SIM',
    active: true,
    leadType: 'sim_order',
  },
  { id: '70000000-0000-4000-8000-000000000002', name: 'Basic', active: true, leadType: 'mobility' },
];

describe('catalogFromModel', () => {
  it('scopes the plan options to the lead type from the model’s plans', () => {
    const properties = buildPropertyCatalog([], 'lead', { plans }).all;
    const catalog = catalogFromModel(properties, 'lead', plans);
    const offered = (type: string) =>
      (catalog.forType(type).find((property) => property.key === 'plan')?.options ?? [])
        .filter((option) => !option.hidden)
        .map((option) => option.label);
    expect(offered('mobility')).toEqual(['Basic']);
    expect(offered('sim_order')).toEqual(['Prepaid SIM']);
    expect(offered('internet')).toEqual([]);
  });

  it('reads as the code catalogue for a site that changed nothing and sells no plans', () => {
    expect(catalogFromModel(codePropertyCatalog.all)).toBe(codePropertyCatalog);
  });
});
