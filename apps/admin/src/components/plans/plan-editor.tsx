'use client';

import { useState, type JSX } from 'react';
import {
  PLAN_COMMISSION_RATE_MAX_BPS,
  PLAN_NAME_MAX,
  createPlanRequestSchema,
  type PlanCommission,
  updatePlanRequestSchema,
  type CreatePlanRequest,
  type Plan,
  type PropertyCatalog,
  type PropertyValue,
  type UpdatePlanRequest,
} from '@gt-sales/contracts';
import { billingPeriods, type BillingPeriod } from '@gt-sales/types';
import { Button, Checkbox, FormField, Input, Label, NativeSelect } from '@gt-sales/ui';

import { dollarsToCents, PropertyValueControl } from '../properties/property-value';
import { documentTypeLabel } from './document-types';
import { describeInvalid } from '../../lib/error-text';

/** The editor's fields by their key in the plan schemas, for `describeInvalid`. */
const PLAN_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: 'The name',
  priceMinor: 'The price',
  billingPeriod: 'The billing period',
  requiredDocuments: 'The required documents',
  customValues: 'A plan property',
  commission: 'The commission',
};

/** How staff read each billing period, for the selector and the plan list. */
export const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = {
  one_time: 'One-time',
  month: 'Monthly',
  '30_days': '30 days',
  '90_days': '90 days',
  year: 'Yearly',
};

function billingPeriodFromValue(value: string): BillingPeriod | undefined {
  return billingPeriods.find((entry) => entry === value);
}

const PRICE_HELP = 'Enter the price in dollars, such as 19.99.';

type CommissionType = PlanCommission['type'];
const COMMISSION_LABELS: Record<CommissionType, string> = {
  none: 'None',
  percent: 'Percent of price',
  fixed: 'Fixed amount',
};

/** A plan's commission in words, for the plan list: "12.5 % of price", "$25.00 fixed". */
export function commissionLabel(commission: PlanCommission): string {
  if (commission.type === 'none') return 'No commission';
  if (commission.type === 'percent') return `${commission.rateBps / 100}% of price commission`;
  return `${(commission.amountMinor / 100).toLocaleString('en-CA', {
    style: 'currency',
    currency: 'CAD',
  })} commission`;
}

function commissionText(commission: PlanCommission | undefined): string {
  if (commission?.type === 'percent') return String(commission.rateBps / 100);
  if (commission?.type === 'fixed') return (commission.amountMinor / 100).toFixed(2);
  return '';
}

/** The typed value as a commission, or an error message. */
function parseCommission(type: CommissionType, text: string): PlanCommission | string {
  if (type === 'none') return { type: 'none' };
  const trimmed = text.trim();
  if (type === 'fixed') {
    const amountMinor = trimmed === '' ? undefined : dollarsToCents(trimmed);
    if (amountMinor === undefined || amountMinor < 0)
      return 'Enter the commission in dollars, such as 25.00.';
    return { type: 'fixed', amountMinor };
  }
  const percent = /^\d{1,3}(\.\d{1,2})?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const rateBps = Math.round(percent * 100);
  if (!Number.isFinite(percent) || rateBps > PLAN_COMMISSION_RATE_MAX_BPS)
    return 'Enter a percent from 0 to 100, such as 12.5.';
  return { type: 'percent', rateBps };
}

function sameCommission(a: PlanCommission, b: PlanCommission | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b ?? { type: 'none' });
}

type Values = Readonly<Record<string, PropertyValue | undefined>>;

function sameDocuments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

/**
 * Adds a plan for one order lead type, or edits one. The price is typed in
 * dollars and sent as whole cents; an edit sends only what changed, with the
 * version it read. `onSave` answers the reason a save was refused, or nothing
 * when it worked. The commission is money: the control shows only when
 * `canSetCommission` (the owner; the backend refuses anyone else), and a
 * save by anyone else never names one.
 */
export function PlanEditor({
  leadType,
  initial,
  catalog,
  documentTypes,
  canSetCommission = false,
  onSave,
}: {
  leadType: string;
  initial?: Plan;
  /** The site's plan properties (object `plan`). */
  catalog: PropertyCatalog;
  documentTypes: readonly string[];
  /** The viewer is the owner (`revenue.view`), who sees and sets a plan's commission. */
  canSetCommission?: boolean;
  onSave(input: CreatePlanRequest | UpdatePlanRequest): Promise<string | undefined>;
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [price, setPrice] = useState(initial ? (initial.priceMinor / 100).toFixed(2) : '');
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>(
    initial?.billingPeriod ?? 'month',
  );
  const [paymentRequired, setPaymentRequired] = useState(initial?.paymentRequired ?? false);
  const [active, setActive] = useState(initial?.active ?? true);
  const [documents, setDocuments] = useState<readonly string[]>(initial?.requiredDocuments ?? []);
  const [values, setValues] = useState<Values>(initial?.customValues ?? {});
  const [commissionType, setCommissionType] = useState<CommissionType>(
    initial?.commission?.type ?? 'none',
  );
  const [commissionValue, setCommissionValue] = useState(commissionText(initial?.commission));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // A document the plan already requires stays listed even if the standard list dropped it.
  const offered = [
    ...documentTypes,
    ...(initial?.requiredDocuments ?? []).filter((key) => !documentTypes.includes(key)),
  ];
  const properties = catalog.forType(leadType);

  const toggleDocument = (key: string, checked: boolean) =>
    setDocuments((current) =>
      checked
        ? current.includes(key)
          ? current
          : [...current, key]
        : current.filter((entry) => entry !== key),
    );

  async function save() {
    setError(undefined);
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Enter a name.');
      return;
    }
    if (trimmed.length > PLAN_NAME_MAX) {
      setError(`Keep the name to ${PLAN_NAME_MAX} characters or fewer.`);
      return;
    }
    if (price.trim() === '') {
      setError('Enter a price.');
      return;
    }
    const priceMinor = dollarsToCents(price);
    if (priceMinor === undefined || priceMinor < 0) {
      setError(PRICE_HELP);
      return;
    }
    const commission = canSetCommission
      ? parseCommission(commissionType, commissionValue)
      : undefined;
    if (typeof commission === 'string') {
      setError(commission);
      return;
    }
    // Documents go in the order the list offers them, whatever order they were ticked in.
    const requiredDocuments = offered.filter((key) => documents.includes(key));

    let input: CreatePlanRequest | UpdatePlanRequest;
    if (initial) {
      const customValues: Record<string, PropertyValue | null> = {};
      for (const property of properties) {
        const next = values[property.key];
        const before = initial.customValues[property.key];
        if (next === undefined && before !== undefined) customValues[property.key] = null;
        else if (next !== undefined && next !== before) customValues[property.key] = next;
      }
      const changes = {
        ...(trimmed !== initial.name ? { name: trimmed } : {}),
        ...(priceMinor !== initial.priceMinor ? { priceMinor } : {}),
        ...(billingPeriod !== initial.billingPeriod ? { billingPeriod } : {}),
        ...(paymentRequired !== initial.paymentRequired ? { paymentRequired } : {}),
        ...(active !== initial.active ? { active } : {}),
        ...(!sameDocuments(requiredDocuments, initial.requiredDocuments)
          ? { requiredDocuments }
          : {}),
        ...(Object.keys(customValues).length > 0 ? { customValues } : {}),
        ...(commission && !sameCommission(commission, initial.commission) ? { commission } : {}),
      };
      if (Object.keys(changes).length === 0) {
        setError('Nothing has changed.');
        return;
      }
      const parsed = updatePlanRequestSchema.safeParse({
        expectedVersion: initial.version,
        ...changes,
      });
      if (!parsed.success) {
        setError(describeInvalid(parsed.error, PLAN_FIELD_LABELS));
        return;
      }
      input = parsed.data;
    } else {
      const customValues: Record<string, PropertyValue> = {};
      for (const property of properties) {
        const value = values[property.key];
        if (value !== undefined) customValues[property.key] = value;
      }
      const parsed = createPlanRequestSchema.safeParse({
        leadType,
        name: trimmed,
        priceMinor,
        billingPeriod,
        paymentRequired,
        active,
        requiredDocuments,
        customValues,
        ...(commission ? { commission } : {}),
      });
      if (!parsed.success) {
        setError(describeInvalid(parsed.error, PLAN_FIELD_LABELS));
        return;
      }
      // The schema defaults the commission to none; only the owner may send one.
      const { commission: _defaulted, ...rest } = parsed.data;
      input = commission ? parsed.data : rest;
    }
    setBusy(true);
    try {
      setError(await onSave(input));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FormField id="plan-name" label="Name">
        <Input
          maxLength={PLAN_NAME_MAX}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </FormField>

      <FormField id="plan-price" label="Price (CAD)" hint="In dollars, such as 19.99.">
        <Input
          inputMode="decimal"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </FormField>

      <FormField id="plan-billing-period" label="Billing period">
        <NativeSelect
          value={billingPeriod}
          onChange={(event) => {
            const next = billingPeriodFromValue(event.target.value);
            if (next) setBillingPeriod(next);
          }}
        >
          {billingPeriods.map((entry) => (
            <option key={entry} value={entry}>
              {BILLING_PERIOD_LABELS[entry]}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      <div className="flex items-center gap-2">
        <Checkbox
          id="plan-payment-required"
          checked={paymentRequired}
          onCheckedChange={(checked) => setPaymentRequired(checked === true)}
        />
        <Label htmlFor="plan-payment-required">Payment required</Label>
      </div>
      <p className="-mt-3 text-sm text-muted-foreground">
        An order for this plan starts with its payment pending.
      </p>

      <div className="flex items-center gap-2">
        <Checkbox
          id="plan-active"
          checked={active}
          onCheckedChange={(checked) => setActive(checked === true)}
        />
        <Label htmlFor="plan-active">Active</Label>
      </div>
      <p className="-mt-3 text-sm text-muted-foreground">
        Only active plans are offered on the website.
      </p>

      {canSetCommission ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Commission</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2" role="radiogroup" aria-label="Commission">
            {(['none', 'percent', 'fixed'] as const).map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="plan-commission-type"
                  value={type}
                  checked={commissionType === type}
                  onChange={() => setCommissionType(type)}
                  className="size-4 accent-primary"
                />
                {COMMISSION_LABELS[type]}
              </label>
            ))}
          </div>
          {commissionType === 'none' ? null : (
            <FormField
              id="plan-commission-value"
              label={commissionType === 'percent' ? 'Commission (%)' : 'Commission (CAD)'}
              hint={
                commissionType === 'percent'
                  ? 'Percent of the plan price per unit sold, such as 12.5.'
                  : 'In dollars per unit sold, such as 25.00.'
              }
            >
              <Input
                inputMode="decimal"
                value={commissionValue}
                onChange={(event) => setCommissionValue(event.target.value)}
              />
            </FormField>
          )}
          <p className="text-sm text-muted-foreground">
            What the site earns on each order of this plan. Only the owner sees it; it is never
            shown on the website.
          </p>
        </fieldset>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Required documents</legend>
        {offered.map((key) => (
          <div key={key} className="flex items-center gap-2">
            <Checkbox
              id={`plan-document-${key}`}
              checked={documents.includes(key)}
              onCheckedChange={(checked) => toggleDocument(key, checked === true)}
            />
            <Label htmlFor={`plan-document-${key}`}>{documentTypeLabel(key)}</Label>
          </div>
        ))}
        <p className="text-sm text-muted-foreground">
          Documents the customer is asked to provide with an order for this plan.
        </p>
      </fieldset>

      {properties.length > 0 ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">Plan properties</legend>
          {properties.map((property) => {
            const id = `plan-property-${property.key}`;
            return (
              <div key={property.key} className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{property.label}</Label>
                <PropertyValueControl
                  id={id}
                  property={property}
                  value={values[property.key]}
                  onChange={(value) =>
                    setValues((current) => ({ ...current, [property.key]: value ?? undefined }))
                  }
                />
              </div>
            );
          })}
        </fieldset>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save plan'}
        </Button>
      </div>
    </form>
  );
}
