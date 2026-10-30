import { z } from 'zod';

import { orderLeadTypes } from '@gt-sales/types';

import { isoDateTimeSchema } from './common';
import {
  leadPropertyCatalog,
  leadTypeProperties,
  resolveLeadTypeProperty,
  type FilterableLeadProperty,
  type LeadPropertyDefinition,
  type LeadTypePropertyUse,
} from './lead-properties';
import { leadTypeSchema } from './leads';

/**
 * The site property catalogue (spec §5.2). Built-in properties are defined in
 * code (`leadPropertyCatalog` with each type's `leadTypeProperties`); a site
 * may relabel or hide one through a row of `app.properties`, and adds custom
 * properties as further rows whose values live in `leads.custom_values`.
 * Order lead types (`orderLeadTypes`) also carry the order properties
 * (`orderPropertyCatalog`), stored in `leads.order_details`.
 * `buildPropertyCatalog` merges the three; with no rows it resolves exactly as
 * the code catalogue always has (`codePropertyCatalog`).
 *
 * This module must not import `./lead-fields` (which builds its catalogue
 * when loaded) and builds every catalogue lazily, so the import cycle with
 * `./lead-properties` is safe whichever module loads first.
 */

export const PROPERTY_KINDS = [
  'text',
  'longText',
  'number',
  'money',
  'date',
  'dateTime',
  'count',
  'yesNo',
  'choice',
  'email',
  'phone',
  'url',
] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

/** Kinds staff may give a custom property (spec §5.2); dateTime and count stay built-in only. */
export const CUSTOM_PROPERTY_KINDS = [
  'text',
  'longText',
  'number',
  'money',
  'date',
  'yesNo',
  'choice',
  'email',
  'phone',
  'url',
] as const;

export const PROPERTY_OBJECTS = ['lead', 'plan'] as const;
export type PropertyObject = (typeof PROPERTY_OBJECTS)[number];

/** A built-in key (`planId`) or a generated custom one (`custom_referral_code`). */
export const propertyKeySchema = z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/);

export const CUSTOM_PROPERTY_KEY_PREFIX = 'custom_';

export const propertyOptionSchema = z
  .object({
    value: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    label: z.string().trim().min(1).max(80),
    /** No longer offered for new values; leads that hold it keep it. */
    hidden: z.boolean().default(false),
  })
  .strict();
export type PropertyOption = z.infer<typeof propertyOptionSchema>;

const propertyLabelSchema = z.string().trim().min(1).max(80);
const propertyOptionsSchema = z.array(propertyOptionSchema).max(100);
const propertyLeadTypesSchema = z.array(leadTypeSchema).max(20);

/** A row of app.properties as the API returns it (custom, or a built-in override). */
export const propertyRowSchema = z.object({
  object: z.enum(PROPERTY_OBJECTS),
  key: propertyKeySchema,
  origin: z.enum(['builtin', 'custom']),
  label: z.string().min(1).max(80),
  kind: z.enum(PROPERTY_KINDS),
  options: propertyOptionsSchema,
  staffOnly: z.boolean(),
  sensitive: z.boolean(),
  hidden: z.boolean(),
  leadTypes: propertyLeadTypesSchema,
  /** A plan property whose value the website's plan listing shows; false for anything else. */
  websiteVisible: z.boolean().default(false),
  position: z.number().int().min(0),
  version: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type PropertyRow = z.infer<typeof propertyRowSchema>;

function addDuplicateIssues(
  values: readonly string[] | undefined,
  path: string,
  ctx: z.RefinementCtx,
): void {
  if (!values) return;
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate ${path} "${value}"`,
        path: [path, index],
      });
    }
    seen.add(value);
  });
}

export const createCustomPropertySchema = z
  .object({
    label: propertyLabelSchema,
    kind: z.enum(CUSTOM_PROPERTY_KINDS),
    options: propertyOptionsSchema.default([]),
    staffOnly: z.boolean().default(false),
    sensitive: z.boolean().default(false),
    /** Plan properties only: the website's plan listing shows the value. */
    websiteVisible: z.boolean().default(false),
    /** [] = every lead type. */
    leadTypes: propertyLeadTypesSchema.default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.kind === 'choice' && input.options.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a choice needs at least one option',
        path: ['options'],
      });
    }
    if (input.kind !== 'choice' && input.options.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'only a choice has options', path: ['options'] });
    }
    addDuplicateIssues(
      input.options.map((option) => option.value),
      'options',
      ctx,
    );
    addDuplicateIssues(input.leadTypes, 'leadTypes', ctx);
  });
export type CreateCustomProperty = z.infer<typeof createCustomPropertySchema>;

export const updatePropertySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    label: propertyLabelSchema.optional(),
    options: propertyOptionsSchema.optional(),
    staffOnly: z.boolean().optional(),
    sensitive: z.boolean().optional(),
    hidden: z.boolean().optional(),
    websiteVisible: z.boolean().optional(),
    leadTypes: propertyLeadTypesSchema.optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    addDuplicateIssues(
      input.options?.map((option) => option.value),
      'options',
      ctx,
    );
    addDuplicateIssues(input.leadTypes, 'leadTypes', ctx);
  })
  .refine(
    (input) =>
      Object.entries(input).some(
        ([key, value]) => key !== 'expectedVersion' && value !== undefined,
      ),
    { message: 'nothing to change' },
  );
export type UpdateProperty = z.infer<typeof updatePropertySchema>;

/** The fields a built-in override may carry; anything else on a built-in is `builtin_property_locked`. */
export const BUILTIN_OVERRIDE_FIELDS = ['label', 'hidden', 'expectedVersion'] as const;

/** Custom properties per object per site. */
export const PROPERTY_LIMIT = 100;

/**
 * The `details` of `property_in_use` (and, with `optionValue`, of
 * `property_option_in_use`): every lead of the site holding the value, split
 * by what the owner can do about it (for a plan property, its plans: see
 * `planCount`). `active` leads can be edited; `trashed`
 * ones must be restored first; `restricted` ones (personal data restricted)
 * can never be edited. `leadCount` is their sum.
 */
export const propertyUsageSchema = z.object({
  leadCount: z.number().int().min(0),
  active: z.number().int().min(0),
  trashed: z.number().int().min(0),
  restricted: z.number().int().min(0),
  /**
   * Plan properties only: the site's plans holding the value. Plans are never
   * archived or restricted, so for a plan property `active` equals it and
   * `leadCount`, `trashed` and `restricted` are 0.
   */
  planCount: z.number().int().min(0).optional(),
});
export type PropertyUsage = z.infer<typeof propertyUsageSchema>;

/** Where a property's value lives: the lead's `form.payload`, `leads.custom_values` or `leads.order_details`. */
export const PROPERTY_STORAGES = ['form', 'custom', 'order'] as const;
export type PropertyStorage = (typeof PROPERTY_STORAGES)[number];

export interface SiteProperty {
  readonly key: string;
  readonly label: string;
  readonly kind: PropertyKind;
  readonly options?: readonly PropertyOption[];
  readonly origin: 'builtin' | 'custom';
  /** Where the value lives: the lead's `form.payload`, `leads.custom_values` or `leads.order_details`. */
  readonly storage: PropertyStorage;
  /**
   * The field the value is stored under in its storage, when it is not `key`.
   * Only order properties set it (`plan` is `order_details.planId`, the others
   * their own key), so the order link does not collide with the form's
   * `planId`. Whatever reads or writes a stored value (the backend's filter,
   * sort and column SQL, the admin's record page) reads `storageKey ?? key`.
   */
  readonly storageKey?: string;
  readonly sensitive: boolean;
  readonly staffOnly: boolean;
  readonly hidden: boolean;
  /** A custom plan property the website's plan listing shows; false for every other property. */
  readonly websiteVisible: boolean;
  /** [] = every lead type. */
  readonly leadTypes: readonly string[];
  readonly editable: boolean;
  readonly maxLength?: number;
  readonly labelKey?: string;
  readonly requiredWhen?: { readonly key: string; readonly value: string };
  readonly countdown?: boolean;
  /** The row's version, when the site has a row for the property. */
  readonly version?: number;
}

/** The wire form of `SiteProperty`. */
export const sitePropertySchema = z.object({
  key: propertyKeySchema,
  label: z.string().min(1).max(80),
  kind: z.enum(PROPERTY_KINDS),
  options: propertyOptionsSchema.optional(),
  origin: z.enum(['builtin', 'custom']),
  storage: z.enum(PROPERTY_STORAGES),
  storageKey: propertyKeySchema.optional(),
  sensitive: z.boolean(),
  staffOnly: z.boolean(),
  hidden: z.boolean(),
  websiteVisible: z.boolean(),
  leadTypes: propertyLeadTypesSchema,
  editable: z.boolean(),
  maxLength: z.number().int().positive().optional(),
  labelKey: propertyKeySchema.optional(),
  requiredWhen: z.object({ key: propertyKeySchema, value: z.string() }).optional(),
  countdown: z.boolean().optional(),
  version: z.number().int().positive().optional(),
});

/** A site's plan as the catalogue offers it for the order's `plan` property. */
export interface PlanOption {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
}

export interface BuildCatalogOptions {
  /** The site's plans; without them the order's `plan` property has no options. */
  readonly plans?: readonly PlanOption[];
}

/** The order properties, in record order. */
export const ORDER_PROPERTY_KEYS = [
  'plan',
  'quantity',
  'paymentStatus',
  'carrierCommission',
] as const;
export type OrderPropertyKey = (typeof ORDER_PROPERTY_KEYS)[number];

/**
 * Built-ins of order lead types (`orderLeadTypes`), storage `order`, values in
 * `leads.order_details` (`leadOrderSchema`). `plan` is the order's link to one
 * of the site's plans, stored as `order_details.planId` (see `storageKey`); its
 * options come from the site's plans (`BuildCatalogOptions.plans`).
 */
export const orderPropertyCatalog: Readonly<Record<string, LeadPropertyDefinition>> = {
  plan: { key: 'plan', label: 'Plan', kind: 'choice', options: [] },
  quantity: { key: 'quantity', label: 'Quantity', kind: 'count' },
  paymentStatus: {
    key: 'paymentStatus',
    label: 'Payment status',
    kind: 'choice',
    options: [
      { value: 'not_needed', label: 'Not needed' },
      { value: 'pending', label: 'Pending' },
      { value: 'paid', label: 'Paid' },
    ],
  },
  carrierCommission: {
    key: 'carrierCommission',
    label: 'Carrier commission',
    kind: 'choice',
    options: [
      { value: 'not_yet', label: 'Not yet' },
      { value: 'invoiced', label: 'Invoiced' },
      { value: 'received', label: 'Received' },
      { value: 'clawback', label: 'Clawback' },
    ],
  },
};

/** The `order_details` field of each order property. */
const ORDER_STORAGE_KEYS: Readonly<Record<OrderPropertyKey, string>> = {
  plan: 'planId',
  quantity: 'quantity',
  paymentStatus: 'paymentStatus',
  carrierCommission: 'carrierCommission',
};

const isOrderPropertyKey = (key: string): key is OrderPropertyKey =>
  ORDER_PROPERTY_KEYS.some((entry) => entry === key);

const isOrderType = (leadType: string) => orderLeadTypes.some((entry) => entry === leadType);

export interface PropertyCatalog {
  readonly object: PropertyObject;
  /**
   * Every property, hidden and sensitive included, built-ins first in catalogue order then custom by position.
   * `all` and `get` describe the property across types; per-type values (`editable`, `staffOnly`, label) come from `forType`.
   */
  readonly all: readonly SiteProperty[];
  get(key: string): SiteProperty | undefined;
  /** Visible (not hidden) properties that apply to the type, in the order the record page shows them. */
  forType(leadType: string): readonly SiteProperty[];
  /** Visible, non-sensitive properties for filters, sorts and columns (PR #1 semantics across types when no type). */
  filterable(leadType?: string): readonly FilterableLeadProperty[];
}

interface ResolvedCatalog {
  readonly all: readonly SiteProperty[];
  readonly byKey: ReadonlyMap<string, SiteProperty>;
  readonly order: readonly SiteProperty[];
  readonly custom: readonly SiteProperty[];
  readonly overrides: ReadonlyMap<string, PropertyRow>;
}

const withHidden = (
  options: readonly { readonly value: string; readonly label: string }[] | undefined,
): PropertyOption[] | undefined =>
  options?.map((option) => ({ value: option.value, label: option.label, hidden: false }));

/** The code definition with a site's override applied: only `label` and `hidden`. */
function overriddenDefinition(
  property: LeadPropertyDefinition,
  override: PropertyRow | undefined,
): LeadPropertyDefinition {
  return override ? { ...property, label: override.label } : property;
}

/** A type's label wins unless the site relabelled the property (its row label differs from code). */
function useLabel(
  property: LeadPropertyDefinition,
  use: LeadTypePropertyUse,
  override: PropertyRow | undefined,
): LeadTypePropertyUse {
  return override && override.label !== property.label ? { ...use, label: override.label } : use;
}

function builtinTypesByKey(): Map<string, string[]> {
  const typesByKey = new Map<string, string[]>();
  for (const [leadType, uses] of Object.entries(leadTypeProperties)) {
    for (const use of uses) {
      const list = typesByKey.get(use.key);
      if (list) list.push(leadType);
      else typesByKey.set(use.key, [leadType]);
    }
  }
  return typesByKey;
}

/** Each plan as an option of the order's `plan` property; an inactive plan stays readable as a hidden option. */
const planOptions = (plans: readonly PlanOption[]): PropertyOption[] =>
  plans.map((plan) => ({ value: plan.id, label: plan.name, hidden: !plan.active }));

function orderProperties(
  overrides: ReadonlyMap<string, PropertyRow>,
  plans: readonly PlanOption[],
): SiteProperty[] {
  const result: SiteProperty[] = [];
  for (const key of ORDER_PROPERTY_KEYS) {
    const code = orderPropertyCatalog[key];
    if (!code) continue;
    const override = overrides.get(key);
    const property = overriddenDefinition(code, override);
    const options = key === 'plan' ? planOptions(plans) : withHidden(property.options);
    result.push({
      key,
      label: property.label,
      kind: property.kind,
      ...(options !== undefined ? { options } : {}),
      origin: 'builtin',
      storage: 'order',
      storageKey: ORDER_STORAGE_KEYS[key],
      sensitive: false,
      staffOnly: false,
      hidden: override?.hidden ?? false,
      websiteVisible: false,
      leadTypes: [...orderLeadTypes],
      editable: true,
      ...(override ? { version: override.version } : {}),
    });
  }
  return result;
}

function resolveCatalog(
  rows: readonly PropertyRow[],
  object: PropertyObject,
  options: BuildCatalogOptions,
): ResolvedCatalog {
  const ownRows = rows.filter((entry) => entry.object === object);
  const builtins = object === 'lead' ? leadPropertyCatalog : {};
  const isBuiltin = (key: string) =>
    Object.hasOwn(builtins, key) || (object === 'lead' && isOrderPropertyKey(key));

  const overrides = new Map<string, PropertyRow>();
  for (const entry of ownRows) {
    if (entry.origin === 'builtin' && isBuiltin(entry.key) && !overrides.has(entry.key)) {
      overrides.set(entry.key, entry);
    }
  }

  const typesByKey = object === 'lead' ? builtinTypesByKey() : new Map<string, string[]>();
  const all: SiteProperty[] = [];
  for (const [key, code] of Object.entries(builtins)) {
    const override = overrides.get(key);
    const property = overriddenDefinition(code, override);
    const uses = Object.values(leadTypeProperties).flatMap((list) =>
      list.filter((use) => use.key === key),
    );
    const options = withHidden(property.options);
    all.push({
      key,
      label: property.label,
      kind: property.kind,
      ...(options !== undefined ? { options } : {}),
      origin: 'builtin',
      storage: 'form',
      sensitive: property.sensitive ?? false,
      // Staff-only anywhere means the website never sends it; editability is per type (forType).
      staffOnly: uses.some((use) => use.staffOnly === true),
      hidden: override?.hidden ?? false,
      websiteVisible: false,
      leadTypes: typesByKey.get(key) ?? [],
      editable: false,
      ...(property.maxLength !== undefined ? { maxLength: property.maxLength } : {}),
      ...(override ? { version: override.version } : {}),
    });
  }

  const order = object === 'lead' ? orderProperties(overrides, options.plans ?? []) : [];
  all.push(...order);

  const custom: SiteProperty[] = [];
  const customKeys = new Set<string>();
  const customRows = ownRows
    .filter((entry) => entry.origin === 'custom' && !isBuiltin(entry.key))
    .sort((a, b) => a.position - b.position || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const entry of customRows) {
    if (customKeys.has(entry.key)) continue;
    customKeys.add(entry.key);
    custom.push({
      key: entry.key,
      label: entry.label,
      kind: entry.kind,
      ...(entry.options.length > 0 ? { options: entry.options } : {}),
      origin: 'custom',
      storage: 'custom',
      sensitive: entry.sensitive,
      staffOnly: entry.staffOnly,
      hidden: entry.hidden,
      // Only a plan's values ever reach a website.
      websiteVisible: object === 'plan' && entry.websiteVisible,
      leadTypes: entry.leadTypes,
      editable: true,
      version: entry.version,
    });
  }
  all.push(...custom);

  return { all, byKey: new Map(all.map((entry) => [entry.key, entry])), order, custom, overrides };
}

const appliesTo = (property: SiteProperty, leadType: string) =>
  property.leadTypes.length === 0 || property.leadTypes.includes(leadType);

function typeUses(leadType: string, object: PropertyObject): readonly LeadTypePropertyUse[] {
  if (object !== 'lead' || !Object.hasOwn(leadTypeProperties, leadType)) return [];
  return leadTypeProperties[leadType] ?? [];
}

const toFilterable = (property: {
  readonly key: string;
  readonly label: string;
  readonly kind: PropertyKind;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly maxLength?: number;
}): FilterableLeadProperty => ({
  key: property.key,
  label: property.label,
  kind: property.kind,
  ...(property.options !== undefined ? { options: property.options } : {}),
  ...(property.maxLength !== undefined ? { maxLength: property.maxLength } : {}),
});

/**
 * The site's catalogue from its rows. A built-in row (`origin: 'builtin'`)
 * overrides only the code definition's `label` and `hidden` (order properties
 * included); a custom row is a property stored in `custom_values`. Rows of
 * another object, built-in rows for an unknown key and custom rows reusing a
 * built-in key are ignored. `options.plans` gives the order's `plan` property
 * its options.
 */
export function buildPropertyCatalog(
  rows: readonly PropertyRow[],
  object: PropertyObject = 'lead',
  options: BuildCatalogOptions = {},
): PropertyCatalog {
  let resolved: ResolvedCatalog | undefined;
  const resolve = (): ResolvedCatalog => (resolved ??= resolveCatalog(rows, object, options));

  const builtinForType = (leadType: string) => {
    const { overrides, byKey } = resolve();
    const result: { property: SiteProperty; field: ReturnType<typeof resolveLeadTypeProperty> }[] =
      [];
    for (const use of typeUses(leadType, object)) {
      const code = Object.hasOwn(leadPropertyCatalog, use.key)
        ? leadPropertyCatalog[use.key]
        : undefined;
      const base = byKey.get(use.key);
      if (!code || !base || base.hidden) continue;
      const override = overrides.get(use.key);
      const field = resolveLeadTypeProperty(
        overriddenDefinition(code, override),
        useLabel(code, use, override),
      );
      const options = withHidden(field.options);
      result.push({
        field,
        property: {
          ...base,
          label: field.label,
          kind: field.kind,
          ...(options !== undefined ? { options } : {}),
          staffOnly: field.staffOnly ?? false,
          editable: field.editable ?? false,
          ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
          ...(field.labelKey !== undefined ? { labelKey: field.labelKey } : {}),
          ...(field.requiredWhen !== undefined ? { requiredWhen: field.requiredWhen } : {}),
          ...(field.countdown !== undefined ? { countdown: field.countdown } : {}),
        },
      });
    }
    return result;
  };

  const orderForType = (leadType: string) =>
    isOrderType(leadType) ? resolve().order.filter((property) => !property.hidden) : [];

  const customForType = (leadType: string) =>
    resolve().custom.filter((property) => !property.hidden && appliesTo(property, leadType));

  const filterableAcrossTypes = (): FilterableLeadProperty[] => {
    const { overrides, byKey, order, custom } = resolve();
    const usesByKey = new Map<string, LeadTypePropertyUse[]>();
    if (object === 'lead') {
      for (const uses of Object.values(leadTypeProperties)) {
        for (const use of uses) {
          const list = usesByKey.get(use.key);
          if (list) list.push(use);
          else usesByKey.set(use.key, [use]);
        }
      }
    }

    const result: FilterableLeadProperty[] = [];
    for (const [key, uses] of usesByKey.entries()) {
      const code = Object.hasOwn(leadPropertyCatalog, key) ? leadPropertyCatalog[key] : undefined;
      const base = byKey.get(key);
      if (!code || !base || base.hidden || base.sensitive) continue;
      const override = overrides.get(key);
      const property = overriddenDefinition(code, override);

      const kinds = new Set<PropertyKind>();
      const options: { readonly value: string; readonly label: string }[] = [];
      const seenOptionValues = new Set<string>();
      for (const use of uses) {
        const field = resolveLeadTypeProperty(property, use);
        kinds.add(field.kind);
        for (const option of field.options ?? []) {
          if (!seenOptionValues.has(option.value)) {
            seenOptionValues.add(option.value);
            options.push(option);
          }
        }
      }
      const firstKind = kinds.values().next().value;
      const effectiveKind: PropertyKind = kinds.size === 1 && firstKind ? firstKind : 'text';
      result.push({
        key: property.key,
        label: property.label,
        kind: effectiveKind,
        ...(effectiveKind === 'choice' && options.length > 0 ? { options } : {}),
        ...(property.maxLength !== undefined ? { maxLength: property.maxLength } : {}),
      });
    }
    for (const property of [...order, ...custom]) {
      if (!property.hidden && !property.sensitive) result.push(toFilterable(property));
    }
    return result;
  };

  return {
    object,
    get all() {
      return resolve().all;
    },
    get(key) {
      return resolve().byKey.get(key);
    },
    forType(leadType) {
      return [
        ...builtinForType(leadType).map((entry) => entry.property),
        ...orderForType(leadType),
        ...customForType(leadType),
      ];
    },
    filterable(leadType) {
      if (leadType === undefined) return filterableAcrossTypes();
      return [
        ...builtinForType(leadType)
          .filter((entry) => !entry.property.sensitive)
          .map((entry) => toFilterable(entry.field)),
        ...orderForType(leadType).map(toFilterable),
        ...customForType(leadType)
          .filter((property) => !property.sensitive)
          .map(toFilterable),
      ];
    },
  };
}

/** The catalogue of a site with no rows: PR #1's behaviour plus the order properties, whose `plan` has no options without the site's plans. */
export const codePropertyCatalog: PropertyCatalog = buildPropertyCatalog([]);

const KEY_MAX_LENGTH = 64;

/**
 * A custom property's permanent key from its first label: `custom_` plus the
 * label in snake case (anything but ASCII letters and digits becomes `_`,
 * runs collapse, ends trimmed), at most 64 characters, then `_2`, `_3`… while
 * the key is reserved (built-ins, live rows and tombstones).
 */
export function generatePropertyKey(label: string, reserved: ReadonlySet<string>): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'property';
  const keyWithin = (suffix: string) => {
    const room = KEY_MAX_LENGTH - CUSTOM_PROPERTY_KEY_PREFIX.length - suffix.length;
    const base = slug.slice(0, room).replace(/_+$/, '') || 'property';
    return `${CUSTOM_PROPERTY_KEY_PREFIX}${base}${suffix}`;
  };
  let key = keyWithin('');
  for (let counter = 2; reserved.has(key); counter += 1) {
    key = keyWithin(`_${counter}`);
  }
  return key;
}

export type PropertyValue = string | number | boolean;
export type ParsePropertyValueResult = { ok: true; value: PropertyValue } | { ok: false };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day, `YYYY-MM-DD`, between 1900 and 2200. */
export function isCalendarDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1900 &&
    year <= 2200 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Control characters, bidi overrides and line separators; a long text may keep its newlines. */
function hasControlCharacter(text: string, allowNewline: boolean): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a && allowNewline) continue;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

const MAX_MAGNITUDE = 1e12;
const emailValueSchema = z.email().max(254);
const urlValueSchema = z.url({ protocol: /^https?$/ }).max(2048);
const PHONE = /^\+?[0-9]{5,20}$/;

const accept = (value: PropertyValue): ParsePropertyValueResult => ({ ok: true, value });
const refuse: ParsePropertyValueResult = { ok: false };

/**
 * One value checked against its property's kind, in its stored form. An
 * empty string is refused (callers clear a value with `null`). A hidden
 * choice option is refused here; a caller keeping a lead's current value
 * accepts it before asking.
 */
export function parsePropertyValue(
  property: Pick<SiteProperty, 'kind' | 'options' | 'maxLength'>,
  value: unknown,
): ParsePropertyValueResult {
  switch (property.kind) {
    case 'text':
    case 'longText': {
      if (typeof value !== 'string') return refuse;
      const text = value.replace(/\r\n?/g, '\n').trim();
      const limit = property.maxLength ?? (property.kind === 'text' ? 200 : 4000);
      if (text === '' || text.length > limit) return refuse;
      if (hasControlCharacter(text, property.kind === 'longText')) return refuse;
      return accept(text);
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_MAGNITUDE
        ? accept(value)
        : refuse;
    case 'money':
      return typeof value === 'number' &&
        Number.isInteger(value) &&
        Math.abs(value) <= MAX_MAGNITUDE
        ? accept(value)
        : refuse;
    case 'count':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000
        ? accept(value)
        : refuse;
    case 'date':
      return typeof value === 'string' && isCalendarDate(value) ? accept(value) : refuse;
    case 'dateTime':
      return typeof value === 'string' && isoDateTimeSchema.safeParse(value).success
        ? accept(value)
        : refuse;
    case 'yesNo':
      return typeof value === 'boolean' ? accept(value) : refuse;
    case 'choice':
      return typeof value === 'string' &&
        (property.options ?? []).some((option) => option.value === value && !option.hidden)
        ? accept(value)
        : refuse;
    case 'email': {
      if (typeof value !== 'string') return refuse;
      const email = value.trim().toLowerCase();
      return emailValueSchema.safeParse(email).success ? accept(email) : refuse;
    }
    case 'phone': {
      if (typeof value !== 'string') return refuse;
      const phone = value.replace(/[ ()-]/g, '');
      return PHONE.test(phone) ? accept(phone) : refuse;
    }
    case 'url': {
      if (typeof value !== 'string') return refuse;
      const url = value.trim();
      return urlValueSchema.safeParse(url).success ? accept(url) : refuse;
    }
  }
}

const moneyFormat = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
const dateFormat = new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('en-CA', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** A stored value as staff read it; empty for no value, the value itself when it does not fit the kind. */
export function formatPropertyValue(
  property: Pick<SiteProperty, 'kind' | 'options'>,
  value: unknown,
): string {
  if (value === null || value === undefined) return '';
  switch (property.kind) {
    case 'money':
      if (typeof value === 'number' && Number.isFinite(value))
        return moneyFormat.format(value / 100);
      break;
    case 'yesNo':
      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
      break;
    case 'choice': {
      const option = property.options?.find((entry) => entry.value === value);
      if (option) return option.label;
      break;
    }
    case 'date':
      if (typeof value === 'string' && isCalendarDate(value)) {
        return dateFormat.format(new Date(`${value}T12:00:00Z`));
      }
      break;
    case 'dateTime':
      if (typeof value === 'string' && isoDateTimeSchema.safeParse(value).success) {
        return dateTimeFormat.format(new Date(value));
      }
      break;
    default:
      break;
  }
  return String(value);
}
