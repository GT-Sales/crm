'use client';

import { useId, type JSX } from 'react';
import {
  AUTOMATION_MAX_GROUP_ITEMS,
  leadPropertyOperators,
  leadTypeCatalog,
  type Condition,
  type ConditionGroup,
  type FlowCatalogResponse,
  type LeadPropertyFilter,
  type LeadPropertyOperator,
} from '@gt-sales/contracts';
import { Button, Input, Label } from '@gt-sales/ui';

type InnerConditionGroup = {
  match: 'all' | 'any';
  items: Condition[];
};

const OPERATOR_LABELS: Readonly<Record<LeadPropertyOperator, string>> = {
  eq: 'is',
  contains: 'contains',
  in: 'is one of',
  lte: 'is at most',
  gte: 'is at least',
  empty: 'is empty',
  notEmpty: 'is filled in',
};

function defaultLeadTypes(catalog: FlowCatalogResponse | undefined): string[] {
  const first = catalog?.leadTypes[0]?.key ?? Object.keys(leadTypeCatalog)[0] ?? 'sim_order';
  return [first];
}

function defaultStage(
  catalog: FlowCatalogResponse | undefined,
  triggerLeadTypes: readonly string[],
): string {
  const types = catalog?.leadTypes ?? [];
  const matching =
    triggerLeadTypes.length > 0
      ? types.filter((entry) => triggerLeadTypes.includes(entry.key))
      : types;
  return matching[0]?.stages[0]?.key ?? types[0]?.stages[0]?.key ?? 'pending';
}

function defaultCondition(
  kind: Condition['kind'],
  catalog: FlowCatalogResponse | undefined,
  triggerLeadTypes: readonly string[],
): Condition {
  switch (kind) {
    case 'lead_type':
      return { kind: 'lead_type', in: defaultLeadTypes(catalog) };
    case 'stage':
      return { kind: 'stage', op: 'in', stages: [defaultStage(catalog, triggerLeadTypes)] };
    case 'plan': {
      const plans = catalog?.plans ?? [];
      const matching =
        triggerLeadTypes.length > 0
          ? plans.filter((plan) => triggerLeadTypes.includes(plan.leadType))
          : plans;
      const firstId = matching[0]?.id ?? plans[0]?.id ?? '00000000-0000-4000-8000-000000000001';
      return { kind: 'plan', op: 'in', planIds: [firstId] };
    }
    case 'assignee':
      return { kind: 'assignee', op: 'any' };
    case 'property': {
      const prop = catalog?.properties.find((entry) => entry.condition);
      const key = prop?.key ?? 'carrier';
      return { kind: 'property', filter: { key, op: 'notEmpty' } };
    }
  }
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
  canRemove,
  catalog,
  triggerLeadTypes,
  disabled,
  rowLabel,
}: {
  condition: Condition;
  onChange(next: Condition): void;
  onRemove(): void;
  canRemove: boolean;
  catalog: FlowCatalogResponse | undefined;
  triggerLeadTypes: readonly string[];
  disabled: boolean;
  rowLabel: string;
}): JSX.Element {
  const id = useId();
  const leadTypes =
    catalog?.leadTypes ??
    Object.entries(leadTypeCatalog).map(([key, entry]) => ({
      key,
      label: entry.label,
      stages: entry.stages.map((stage) => ({ key: stage.key, label: stage.label })),
    }));

  const relevantTypes =
    triggerLeadTypes.length > 0
      ? leadTypes.filter((entry) => triggerLeadTypes.includes(entry.key))
      : leadTypes;

  const availableStages = Array.from(
    new Map(
      relevantTypes.flatMap((entry) => entry.stages.map((stage) => [stage.key, stage])),
    ).values(),
  );

  const availablePlans = (catalog?.plans ?? []).filter(
    (plan) => triggerLeadTypes.length === 0 || triggerLeadTypes.includes(plan.leadType),
  );

  const conditionProperties = (catalog?.properties ?? []).filter((prop) => prop.condition);

  function handleKindChange(nextKind: string) {
    if (
      nextKind === 'lead_type' ||
      nextKind === 'stage' ||
      nextKind === 'plan' ||
      nextKind === 'assignee' ||
      nextKind === 'property'
    ) {
      onChange(defaultCondition(nextKind, catalog, triggerLeadTypes));
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-1 items-center gap-2">
          <Label htmlFor={`${id}-kind`} className="sr-only">
            {rowLabel} kind
          </Label>
          <select
            id={`${id}-kind`}
            aria-label={`${rowLabel} kind`}
            disabled={disabled}
            value={condition.kind}
            onChange={(event) => handleKindChange(event.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="plan">Plan</option>
            <option value="stage">Stage</option>
            <option value="lead_type">Lead type</option>
            <option value="assignee">Owner</option>
            <option value="property">Property</option>
          </select>
        </div>
        {canRemove && !disabled ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Remove ${rowLabel.toLowerCase()}`}
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : null}
      </div>

      {condition.kind === 'lead_type' ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label={`${rowLabel} lead types`}>
          {leadTypes.map((type) => {
            const checked = condition.in.includes(type.key);
            return (
              <label key={type.key} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={checked}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...condition.in, type.key]
                      : condition.in.filter((item) => item !== type.key);
                    if (next.length > 0) {
                      onChange({ kind: 'lead_type', in: next });
                    }
                  }}
                />
                {type.label}
              </label>
            );
          })}
        </div>
      ) : null}

      {condition.kind === 'stage' ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={`${id}-stage-op`} className="text-xs text-muted-foreground">
              Comparison
            </Label>
            <select
              id={`${id}-stage-op`}
              aria-label={`${rowLabel} stage comparison`}
              disabled={disabled}
              value={condition.op}
              onChange={(event) =>
                onChange({
                  ...condition,
                  op: event.target.value === 'not_in' ? 'not_in' : 'in',
                })
              }
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="in">is</option>
              <option value="not_in">is not</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label={`${rowLabel} stages`}>
            {availableStages.map((stage) => {
              const checked = condition.stages.includes(stage.key);
              return (
                <label key={stage.key} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={checked}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...condition.stages, stage.key]
                        : condition.stages.filter((item) => item !== stage.key);
                      if (next.length > 0) {
                        onChange({ ...condition, stages: next });
                      }
                    }}
                  />
                  {stage.label}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}

      {condition.kind === 'plan' ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={`${id}-plan-op`} className="text-xs text-muted-foreground">
              Comparison
            </Label>
            <select
              id={`${id}-plan-op`}
              aria-label={`${rowLabel} plan comparison`}
              disabled={disabled}
              value={condition.op}
              onChange={(event) =>
                onChange({
                  ...condition,
                  op: event.target.value === 'not_in' ? 'not_in' : 'in',
                })
              }
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="in">is</option>
              <option value="not_in">is not</option>
            </select>
          </div>
          {availablePlans.length === 0 ? (
            <p className="text-xs text-muted-foreground">No plans for this lead type.</p>
          ) : (
            <div className="flex flex-wrap gap-2" role="group" aria-label={`${rowLabel} plans`}>
              {availablePlans.map((plan) => {
                const checked = condition.planIds.includes(plan.id);
                return (
                  <label key={plan.id} className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={checked}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...condition.planIds, plan.id]
                          : condition.planIds.filter((item) => item !== plan.id);
                        if (next.length > 0) {
                          onChange({ ...condition, planIds: next });
                        }
                      }}
                    />
                    {plan.name}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {condition.kind === 'assignee' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={`${id}-assignee-op`} className="sr-only">
            {rowLabel} owner rule
          </Label>
          <select
            id={`${id}-assignee-op`}
            aria-label={`${rowLabel} owner rule`}
            disabled={disabled}
            value={condition.op}
            onChange={(event) => {
              const op = event.target.value;
              if (op === 'none' || op === 'any') {
                onChange({ kind: 'assignee', op });
              } else if (op === 'is') {
                const firstMember =
                  catalog?.members[0]?.actorId ?? '00000000-0000-4000-8000-000000000001';
                onChange({ kind: 'assignee', op: 'is', actorId: firstMember });
              }
            }}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="any">Someone owns the lead</option>
            <option value="none">No one owns the lead</option>
            <option value="is">Specific member owns the lead</option>
          </select>
          {condition.op === 'is' ? (
            <select
              aria-label={`${rowLabel} owner member`}
              disabled={disabled}
              value={condition.actorId ?? ''}
              onChange={(event) =>
                onChange({ kind: 'assignee', op: 'is', actorId: event.target.value })
              }
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              {(catalog?.members ?? []).map((member) => (
                <option key={member.actorId} value={member.actorId}>
                  {member.displayName ?? member.actorId}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}

      {condition.kind === 'property' ? (
        <PropertyConditionFields
          filter={condition.filter}
          properties={conditionProperties}
          disabled={disabled}
          rowLabel={rowLabel}
          onChange={(filter) => onChange({ kind: 'property', filter })}
        />
      ) : null}
    </div>
  );
}

function PropertyConditionFields({
  filter,
  properties,
  disabled,
  rowLabel,
  onChange,
}: {
  filter: LeadPropertyFilter;
  properties: FlowCatalogResponse['properties'];
  disabled: boolean;
  rowLabel: string;
  onChange(next: LeadPropertyFilter): void;
}): JSX.Element {
  const selected = properties.find((prop) => prop.key === filter.key) ?? properties[0];
  const operators = selected ? leadPropertyOperators(selected.kind) : (['eq', 'notEmpty'] as const);

  function buildFilterForOperator(
    key: string,
    op: LeadPropertyOperator,
    prop: FlowCatalogResponse['properties'][number] | undefined,
  ): LeadPropertyFilter {
    if (op === 'empty' || op === 'notEmpty') {
      return { key, op };
    }
    if (op === 'in') {
      const firstOption = prop?.options?.[0]?.value ?? 'value';
      return { key, op: 'in', value: [firstOption] };
    }
    if (prop?.kind === 'yesNo') {
      return { key, op, value: true };
    }
    if (prop?.kind === 'number' || prop?.kind === 'money') {
      return { key, op, value: 0 };
    }
    if (prop?.kind === 'choice' && prop.options?.[0]) {
      return { key, op, value: prop.options[0].value };
    }
    return { key, op, value: '' };
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label={`${rowLabel} property`}
        disabled={disabled}
        value={filter.key}
        onChange={(event) => {
          const nextKey = event.target.value;
          const nextProp = properties.find((prop) => prop.key === nextKey);
          const nextOps = nextProp ? leadPropertyOperators(nextProp.kind) : (['notEmpty'] as const);
          const nextOp = nextOps.includes(filter.op) ? filter.op : (nextOps[0] ?? 'notEmpty');
          onChange(buildFilterForOperator(nextKey, nextOp, nextProp));
        }}
        className="h-8 rounded-md border bg-background px-2 text-xs"
      >
        {properties.map((prop) => (
          <option key={prop.key} value={prop.key}>
            {prop.label}
          </option>
        ))}
        {!properties.some((prop) => prop.key === filter.key) ? (
          <option value={filter.key}>{filter.key}</option>
        ) : null}
      </select>

      <select
        aria-label={`${rowLabel} operator`}
        disabled={disabled}
        value={filter.op}
        onChange={(event) => {
          const nextOp = operators.find((candidate) => candidate === event.target.value);
          if (nextOp) {
            onChange(buildFilterForOperator(filter.key, nextOp, selected));
          }
        }}
        className="h-8 rounded-md border bg-background px-2 text-xs"
      >
        {operators.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </select>

      {filter.op !== 'empty' && filter.op !== 'notEmpty' ? (
        selected?.kind === 'yesNo' ? (
          <select
            aria-label={`${rowLabel} value`}
            disabled={disabled}
            value={filter.value === true ? 'true' : 'false'}
            onChange={(event) => onChange({ ...filter, value: event.target.value === 'true' })}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        ) : selected?.kind === 'choice' && selected.options ? (
          filter.op === 'in' ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label={`${rowLabel} choices`}>
              {selected.options.map((opt) => {
                const currentArr = Array.isArray(filter.value) ? filter.value : [];
                const checked = currentArr.includes(opt.value);
                return (
                  <label key={opt.value} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={checked}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [...currentArr, opt.value]
                          : currentArr.filter((item) => item !== opt.value);
                        if (next.length > 0) {
                          onChange({ key: filter.key, op: 'in', value: next });
                        }
                      }}
                    />
                    {opt.label}
                  </label>
                );
              })}
            </div>
          ) : (
            <select
              aria-label={`${rowLabel} value`}
              disabled={disabled}
              value={typeof filter.value === 'string' ? filter.value : ''}
              onChange={(event) => onChange({ ...filter, value: event.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              {selected.options.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          )
        ) : selected?.kind === 'number' || selected?.kind === 'money' ? (
          <Input
            type="number"
            aria-label={`${rowLabel} value`}
            disabled={disabled}
            value={typeof filter.value === 'number' ? String(filter.value) : '0'}
            onChange={(event) => onChange({ ...filter, value: Number(event.target.value || '0') })}
            className="h-8 w-32 text-xs"
          />
        ) : (
          <Input
            aria-label={`${rowLabel} value`}
            disabled={disabled}
            value={typeof filter.value === 'string' ? filter.value : ''}
            onChange={(event) => onChange({ ...filter, value: event.target.value })}
            className="h-8 w-44 text-xs"
          />
        )
      ) : null}
    </div>
  );
}

export function ConditionBuilder({
  value,
  onChange,
  allowNull = false,
  catalog,
  triggerLeadTypes = [],
  disabled = false,
  label = 'Conditions',
}: {
  value: ConditionGroup | null;
  onChange(next: ConditionGroup | null): void;
  allowNull?: boolean;
  catalog: FlowCatalogResponse | undefined;
  triggerLeadTypes?: readonly string[];
  disabled?: boolean;
  label?: string;
}): JSX.Element {
  const id = useId();

  if (value === null) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{label}</span>
          {!disabled ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                onChange({
                  match: 'all',
                  items: [defaultCondition('plan', catalog, triggerLeadTypes)],
                })
              }
            >
              Add condition
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">No condition set.</p>
      </div>
    );
  }

  const canAddMore = value.items.length < AUTOMATION_MAX_GROUP_ITEMS;

  function updateItem(index: number, nextItem: Condition | InnerConditionGroup) {
    if (!value) return;
    onChange({
      ...value,
      items: value.items.map((item, idx) => (idx === index ? nextItem : item)),
    });
  }

  function removeItem(index: number) {
    if (!value) return;
    const nextItems = value.items.filter((_, idx) => idx !== index);
    if (nextItems.length === 0) {
      if (allowNull) onChange(null);
      return;
    }
    onChange({ ...value, items: nextItems });
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-match`} className="text-xs font-medium">
            Match
          </Label>
          <select
            id={`${id}-match`}
            aria-label={`${label} match`}
            disabled={disabled}
            value={value.match}
            onChange={(event) =>
              onChange({
                ...value,
                match: event.target.value === 'any' ? 'any' : 'all',
              })
            }
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="all">All of these</option>
            <option value="any">Any of these</option>
          </select>
        </div>
        {allowNull && !disabled ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
            Clear conditions
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {value.items.map((item, index) => {
          if ('match' in item) {
            return (
              <div
                key={index}
                className="flex flex-col gap-2 rounded-md border border-dashed p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`${id}-submatch-${index}`} className="text-xs">
                      Group {index + 1} match
                    </Label>
                    <select
                      id={`${id}-submatch-${index}`}
                      disabled={disabled}
                      value={item.match}
                      onChange={(event) =>
                        updateItem(index, {
                          ...item,
                          match: event.target.value === 'any' ? 'any' : 'all',
                        })
                      }
                      className="h-7 rounded-md border bg-background px-2 text-xs"
                    >
                      <option value="all">All of these</option>
                      <option value="any">Any of these</option>
                    </select>
                  </div>
                  {(value.items.length > 1 || allowNull) && !disabled ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeItem(index)}
                    >
                      Remove group
                    </Button>
                  ) : null}
                </div>
                {item.items.map((subCond, subIndex) => (
                  <ConditionRow
                    key={subIndex}
                    condition={subCond}
                    rowLabel={`Group ${index + 1} condition ${subIndex + 1}`}
                    catalog={catalog}
                    triggerLeadTypes={triggerLeadTypes}
                    disabled={disabled}
                    canRemove={item.items.length > 1}
                    onChange={(nextSub) =>
                      updateItem(index, {
                        ...item,
                        items: item.items.map((entry, idx) => (idx === subIndex ? nextSub : entry)),
                      })
                    }
                    onRemove={() =>
                      updateItem(index, {
                        ...item,
                        items: item.items.filter((_, idx) => idx !== subIndex),
                      })
                    }
                  />
                ))}
                {!disabled && item.items.length < AUTOMATION_MAX_GROUP_ITEMS ? (
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        updateItem(index, {
                          ...item,
                          items: [
                            ...item.items,
                            defaultCondition('plan', catalog, triggerLeadTypes),
                          ],
                        })
                      }
                    >
                      Add to group
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          }

          return (
            <ConditionRow
              key={index}
              condition={item}
              rowLabel={`Condition ${index + 1}`}
              catalog={catalog}
              triggerLeadTypes={triggerLeadTypes}
              disabled={disabled}
              canRemove={value.items.length > 1 || allowNull}
              onChange={(nextCond) => updateItem(index, nextCond)}
              onRemove={() => removeItem(index)}
            />
          );
        })}
      </div>

      {!disabled && canAddMore ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              onChange({
                ...value,
                items: [...value.items, defaultCondition('plan', catalog, triggerLeadTypes)],
              })
            }
          >
            Add condition
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              onChange({
                ...value,
                items: [
                  ...value.items,
                  {
                    match: 'any',
                    items: [defaultCondition('plan', catalog, triggerLeadTypes)],
                  },
                ],
              })
            }
          >
            Add condition group
          </Button>
        </div>
      ) : null}
    </div>
  );
}
