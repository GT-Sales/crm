> Delivered by PR #1 and superseded by
> [docs/superpowers/plans/2026-10-29-phase-2-properties-layout-views.md](../superpowers/plans/2026-10-29-phase-2-properties-layout-views.md).

# Brief: shared lead properties, with filter, sort and columns on the leads list

You are working in the GT Sales CRM monorepo (GitHub `GT-Sales/crm`). Read
`AGENTS.md`, then `docs/HANDOFF.md` §2 (architecture) before touching code. This
brief is the whole task; do it in the order below and do not widen it.

## 1. Goal

Today every lead type (CanadaWide `internet` and `mobility`, Get Canada Sim
`sim_order` and `partner_application`) defines its own form fields in
`packages/contracts/src/lead-fields.ts` (`leadFieldCatalog`). The same fields
(city, street address, postal code, plan, current provider…) are defined
twice, and the staff leads list can only filter by type, stage, assignee, free
search and follow-ups due — never by a form field.

Deliver three things:

1. **One shared property catalogue.** Each property (`city`, `arrivalDate`,
   `permitType`…) is defined once (key, label, kind, options). A lead type
   lists which properties it uses and how (editable, staff-only, required-when,
   countdown). `leadFields(leadType)` keeps returning exactly what it returns
   today, so nothing that uses it changes behaviour.
2. **Filter and sort by any property** on `GET /api/v1/staff/workspaces/:workspaceId/leads`
   (and filter on the board), typed by the property's kind, validated
   server-side, allowed only to roles that may see contact details.
3. **Admin UI**: a filter builder, sortable columns and up to six optional
   property columns on the leads table, all held in the URL so a view can be
   bookmarked.

Out of scope (do not build): staff-defined custom properties, saved views,
automations, exports, bulk actions, database migrations, website changes.

## 2. Facts you can rely on (checked in production on 2026-10-27)

- One table holds every lead: `app.leads` (19 columns: id, workspace_id,
  lead_type, status, stage, full_name, email, phone, country_code, contact_id,
  assigned_actor_id, external_ref, payload, attribution, consent_version,
  customer_data_restricted_at, deleted_at, created_at, updated_at).
- The form lives in `payload` as `{ "schemaVersion": 1, "payload": { …fields } }`.
  In SQL a field is `l.payload -> 'payload' ->> 'city'`. No database
  constraint limits the keys; the code's lists do.
- Leads in production: internet 687, mobility 40, sim_order 138,
  partner_application 5. Small enough that **no index or migration is needed**.
- Keys stored today, per type:
  - internet: aptUnit, city, consent, consentedAt, currentProvider, dateOfBirth,
    landingCity, planId, planLabel, postalCode, preferredInstallationTime, streetAddress
  - mobility: aptUnit, city, currentProvider, firstName, keepNumber, lastName,
    lineCount, planId, planLabel, postalCode, simType, streetAddress
  - sim_order: arrivalDate, canadaAddress, delivery, flightBooked, gotVisa,
    permitType, planId, planLabel, reference, shippingAddress, simNumber
    (the catalogue also defines customerNotes and commissionStatus; not yet stored)
  - partner_application: businessType, company, country, message, volume, website
- Field kinds already in use: `text`, `longText`, `date`, `dateTime`, `count`,
  `yesNo`, `choice` (`LeadFieldKind`).
- Express 5 uses the **simple** query parser: nested `a[b]=c` is NOT parsed.
  Use flat string parameters.
- The typed client (`packages/contracts/src/client.ts`) serialises a query
  object as flat `key=value` pairs (see the loop near line 337), so a string
  parameter is the safe shape.
- `packages/ui` has `dialog`, `sheet`, `dropdown-menu`, `select`,
  `native-select`, `input`, `badge`, `button`, `table`, `tooltip`. There is no
  popover; use `dropdown-menu`, `sheet` or `dialog`.

## 3. Rules you must not break

1. **Do not change the database**: no migration, no schema edit, no new index.
2. **Do not change website intake**: leave `internetLeadPayloadSchema`,
   `mobilityLeadPayloadSchema` and the other intake schemas in
   `packages/contracts/src/lead-types.ts`, the backend registry
   `apps/backend/src/leads/types.ts` and `apps/backend/src/routes/website.ts`
   exactly as they are. Websites must never be able to send a property the
   type does not allow.
3. **Do not change what is stored**: same payload keys, same value shapes. Do
   not touch `packages/db/sql/*-legacy-import.sql`.
4. **`leadFields(leadType)` output must stay byte-for-byte identical** for all
   four types (order, labels, kinds, options, flags). Prove it with a test (§5).
5. **Access**: filtering, sorting or showing columns by a property reveals form
   details. Accept `where`, a property `sort` and `columns` only when the
   caller's `access.contacts` is true; otherwise answer
   `403 permission_denied`, exactly like the existing `q` check in
   `apps/backend/src/routes/staff.ts` (the `GET /workspaces/:workspaceId/leads`
   handler). Strip `properties` in `withoutContact` as well.
6. **Sensitive properties are never filterable, sortable or shown as a
   column**: mark `dateOfBirth` `sensitive: true` (and anything identity-like
   added later). The SIN and licence never become properties; they stay in
   `app.lead_identities`.
7. **SQL safety**: keep the style of `apps/backend/src/leads/staff-queries.ts`
   (explicit `l.` aliases, see its header comment). Bind every value AND every
   property key as a parameter (`sql\`l.payload -> 'payload' ->> ${key}\``);
never build SQL text from user input with `sql.raw`. The only `sql.raw`allowed for this feature is the sort direction chosen from the literal enum`asc`/`desc`. Keep `l.customer_data_restricted_at is null`and the
workspace condition in every read (they live in`leadConditions`).
8. **No type assertions** (`as`) anywhere, tests included: the repo's ESLint
   bans them (`@typescript-eslint/consistent-type-assertions`). Parse with Zod.
9. **Backwards compatible**: every existing query parameter, URL and response
   field keeps working. New response fields are optional.
10. Match the surrounding code: comment density, naming, plain-English UI copy
    in sentence case, accessible markup (`aria-sort`, labels on every control,
    keyboard-usable menus).
11. Never commit secrets or customer data; treat the repo as public. Test data
    is synthetic.

## 4. Work, in order

### Step A — the shared catalogue (contracts only)

1. Create `packages/contracts/src/lead-properties.ts`:
   - `LeadPropertyDefinition`: `key`, `label`, `kind` (`LeadFieldKind`),
     optional `options`, `maxLength`, `sensitive`.
   - `leadPropertyCatalog: Readonly<Record<string, LeadPropertyDefinition>>`
     holding every key listed in §2 once (plus customerNotes and
     commissionStatus), with keys matching `^[a-z][A-Za-z0-9]{0,63}$`.
   - `LeadTypePropertyUse`: `key` plus the per-type settings that exist today
     (`label` override, `kind` override, `options`, `labelKey`, `editable`,
     `staffOnly`, `maxLength`, `requiredWhen`, `countdown`).
   - `leadTypeProperties: Readonly<Record<string, readonly LeadTypePropertyUse[]>>`,
     one ordered list per type, in today's order.
2. Known differences you must preserve:
   - `planId` is `text` labelled "Plan id" for internet and mobility, but a
     `choice` labelled "Plan" with Get Canada Sim's plans and
     `labelKey: 'planLabel'` for sim_order. Allow a type to override `label`,
     and to override `kind` **only from `text` to `choice`** (with its
     `options`). Add a test that rejects any other kind override.
   - `planLabel` is a field for internet and mobility, but not for sim_order
     (there it is only written through `labelKey`). Keep that.
   - Per-type options (plans, permit types, SIM types) stay per type.
3. Rewrite `lead-fields.ts` so `leadFieldCatalog` and `leadFields()` are
   **derived** from the two new structures (property merged with the type's
   use). Keep `leadCountdownField`, `leadFormEditSchema`, `applyLeadFormEdit`
   and every export unchanged in signature and behaviour.
4. Add helpers, exported from `packages/contracts/src/index.ts`:
   - `leadProperty(key)`: the shared definition or undefined.
   - `leadTypePropertyKeys(leadType)`: the keys a type uses.
   - `filterableLeadProperties(leadType?)`: non-sensitive properties used by
     that type, or by any type when none is given, each with the effective
     kind and options for that type (when no type is given and kinds differ,
     use `text` semantics).
   - `leadPropertyOperators(kind)`: the operators of §4 Step B.

### Step B — backend filter, sort and columns

1. Contracts (`packages/contracts/src/workspace-leads.ts`):
   - `leadPropertyFilterSchema`: `{ key, op, value? }`.
     Operators by kind:

     | Kind           | Operators                                                                         |
     | -------------- | --------------------------------------------------------------------------------- |
     | text, longText | `eq` (case-insensitive, trimmed), `contains`, `empty`, `notEmpty`                 |
     | choice         | `eq`, `in` (1–20 values), `empty`, `notEmpty`                                     |
     | date           | `eq`, `lte`, `gte`, `empty`, `notEmpty` (values `YYYY-MM-DD`, real calendar days) |
     | dateTime       | `lte`, `gte`, `empty`, `notEmpty` (ISO date-time)                                 |
     | count          | `eq`, `lte`, `gte`, `empty`, `notEmpty` (integers 0–10000)                        |
     | yesNo          | `eq` (`true`/`false`), `empty`                                                    |

     `empty`/`notEmpty` take no value; text values are at most 200 characters.

   - `where`: an optional query string holding a JSON array of filters,
     at most 2000 characters and at most 10 filters, combined with AND. Parse
     with `z.string().max(2000)` → safe `JSON.parse` (invalid JSON is a Zod
     issue, never a thrown 500) → `z.array(leadPropertyFilterSchema).max(10)`.
   - `sort`: optional `<field>:<asc|desc>` where field is one of `createdAt`,
     `updatedAt`, `fullName`, `externalRef`, or `prop.<key>`.
   - `columns`: optional comma-separated property keys, at most 6.
   - Add `where`, `sort` and `columns` to `listWorkspaceLeadsQuerySchema`;
     add `where` only to `leadBoardQuerySchema`.
   - Add optional `properties: Record<string, string | number | boolean>` to
     `leadListItemSchema`: only the requested `columns`, only for callers with
     contact access.
   - Regenerate `docs/api/openapi.json` with
     `pnpm --filter @gt-sales/contracts build` (CI diffs it).
2. Validate against the catalogue in the route (`apps/backend/src/routes/staff.ts`),
   before any query runs. Answer `400 invalid_request` when:
   - a key is not a property;
   - a key is sensitive;
   - the operator does not fit the kind;
   - a value does not fit the kind;
   - with `type` given, the key is not used by that type;
   - with no type, no type uses the key;
   - a `choice` value is not one of the type's options (when `type` is given).

   Then apply the access rule of §3.5.

3. Pass the parsed filters, sort and columns through
   `apps/backend/src/leads/store.ts` (`listLeads`, `ListLeadsInput`) and the
   board path in `apps/backend/src/leads/work-store.ts` into `LeadFilters` in
   `staff-queries.ts`. Update every test double that implements these
   interfaces (search `apps/backend/tests` for `listLeads` and `board(`).
4. SQL in `leadConditions` (bind everything; `v` = `l.payload -> 'payload' ->> ${key}`):
   - text `eq`: `lower(btrim(v)) = lower(btrim(${value}))`;
     `contains`: `v ilike ${likePattern(value)}` using the existing escaping helper.
   - choice `eq`: `v = ${value}`; `in`: `v = any(${values}::text[])` (or an
     `in` list of bound values).
   - date: guard `v ~ '^\d{4}-\d{2}-\d{2}$'` then compare as text (ISO days
     sort lexically), so malformed stored values never match and never error.
   - dateTime: guard with a pattern, then compare as `timestamptz` only when
     the guard passes, using `case`, so a bad stored value cannot throw.
   - count: `jsonb_typeof(l.payload -> 'payload' -> ${key}) = 'number'`, then
     `(v)::numeric` comparisons.
   - yesNo `eq`: `l.payload -> 'payload' -> ${key} = to_jsonb(${bool})`.
   - `empty`: `coalesce(btrim(v), '') = ''` (absent key counts as empty);
     `notEmpty`: the negation.
5. Sort in `selectLeadPage`: a given `sort` replaces the default order in all
   views. The CTE (`pageOrder`) and the outer select (`rowOrder`) must use the
   same expression; the CTE selects `l.*`, so the outer query can use
   `l.payload` too. Always end with `l.id` as the tie-breaker, and put
   `nulls last` for both directions. Property sorts order by the kind:
   - `count` numerically, through the same guard as filters;
   - dates and text as text;
   - `yesNo` with `false` before `true`.

   Without `sort`, today's ordering is unchanged, including trash and follow-ups due.

6. Columns: select `l.payload -> 'payload'` only when `columns` is non-empty
   and copy just those keys (non-sensitive, values that are string, number or
   boolean) into `properties`. Never return the whole payload in the list.
7. Keep the page total correct with filters (the existing window count and the
   empty-page fallback both use `leadConditions`).

### Step C — admin UI

Files: `apps/admin/src/components/leads/inbox-query.ts`, `leads-inbox.tsx`,
`leads-table.tsx`, `leads-board.tsx`, `lead-fields.ts`, `apps/admin/src/lib/api.ts`.

1. `InboxQuery` gains `where` (filters), `sort` and `columns`, kept in the URL
   as `where=<json>`, `sort=<field:dir>` and `cols=a,b`. `parseInboxQuery`
   drops anything that does not parse against the contracts' schemas (as it
   does today); `inboxSearch` writes them back. Changing a filter, sort or
   columns resets `page` to 1. Changing the lead type drops filters and
   columns the new type does not use.
2. Show the new controls only when the response's `access.contacts` is true.
3. **Filter builder** next to the existing filters: "Add filter" opens a menu
   (dropdown-menu or sheet). Steps:
   - choose a property, listed from `filterableLeadProperties(type)`;
   - choose an operator, worded plainly ("is", "is not empty", "on or before"…);
   - enter a value with a control that fits the kind: text input, date input,
     select for a choice (with the type's options), Yes/No select, number input.

   Each active filter shows as a removable chip ("Permit type is Study permit ×").
   Add a "Clear filters" button. Every control has a visible or `aria` label.

4. **Sort**: built-in and shown property columns are sortable from their
   header button. Set `aria-sort` on the `th`; one click sorts ascending, the
   next descending, the third returns to the default.
5. **Columns**: a "Columns" menu adds or removes up to six property columns.
   Values are formatted with the existing `fieldValue` helper in
   `components/leads/lead-fields.ts`, so a date and a choice read exactly as on
   the lead page.
6. Board view: apply `where` only (the board has its own order).
7. Empty result: "No leads match these filters." with a "Clear filters" action.

## 5. Tests (all must pass; add them in the existing style)

Contracts (`packages/contracts/src/*.test.ts`):

- **Equivalence**: paste today's literal `leadFieldCatalog` object into the
  test as the expected value, then assert `leadFields(type)` deep-equals it
  for all four types and `Object.keys(leadFieldCatalog)` are unchanged.
- Every key in each intake payload schema's shape (internet, mobility) is a
  property and is used by that type.
- Every `leadTypeProperties` key exists in `leadPropertyCatalog`; the only
  kind override allowed is `text` → `choice`.
- `where`/`sort`/`columns` parsing: valid cases; invalid JSON, more than 10
  filters, unknown op, value on `empty`, more than 6 columns, bad sort field.

Backend unit (`apps/backend/tests/lead-work-routes.test.ts` or `leads.test.ts`):

- 400 for: unknown key, sensitive key (`dateOfBirth`), wrong op for kind, bad
  date, choice value not in options, key not used by the given type.
- 403 `permission_denied` for a role without contacts sending `where`, a
  property `sort` or `columns`; a built-in sort (`createdAt:asc`) stays allowed.
- The parsed filters reach the store unchanged; `properties` is stripped for
  callers without contact access.

Backend integration, new `apps/backend/tests/lead-property-filters.integration.test.ts`
(real Postgres, as the other `*.integration.test.ts` files):

- Seed synthetic leads of several types in two workspaces with chosen
  payloads, including a missing key, an empty string, a malformed date, a
  string where a number belongs, and values containing `%` and `_`.
- Assert each operator per kind:
  - `empty` / `notEmpty` on missing keys;
  - case-insensitive `eq`;
  - `contains` with escaped wildcards;
  - malformed stored values never match and never raise.
- Sort asc and desc for text, date and count, with nulls last and stable by id.
- Page totals with filters, page 2, the trash view and the board.
- The other workspace's leads never appear, and restricted leads never appear.
- Must be re-runnable on a persistent local database: unique ids, clean what
  you assert on (see rule 9 in `AGENTS.md`).

Admin (`apps/admin/src/components/leads/*.test.ts(x)`):

- URL round-trip of `where`/`sort`/`cols`; invalid values dropped.
- The builder offers operators by kind and the right value control.
- Chips remove filters; the controls are hidden without contact access.
- Header sort cycles and sets `aria-sort`.

Browser journey (`apps/admin/e2e/leads.spec.ts`): filter SIM orders by
"Visa / permit type is Study permit", sort by arrival ascending, add the
"Arrival in Canada" column, reload, and see the same view.

## 6. How to verify before you commit

Local Postgres in the cloud container: `pg_ctlcluster 16 main start` (it stops
on worker restarts). Use the integration environment from
`.github/workflows/ci.yml` (that file is the source of truth for the database
name and variables).

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm run format
pnpm run test                                   # with the integration env set
pnpm --filter @gt-sales/contracts build         # then: git diff docs/api/openapi.json is expected and committed
pnpm --filter admin build
pnpm --filter admin test:e2e:leads
```

Then re-read your diff adversarially:

- Does any SQL text come from input?
- Can a viewer role learn a form value through `where`, `sort` or `columns`?
- Did `leadFields` output change?
- Does an old URL still work?

## 7. Delivery

1. Work on a branch `claude/lead-properties` from the latest `main`. Small
   commits per step (A, B, C), each with passing checks.
2. Update the docs in the same branch:
   - `docs/HANDOFF.md` §2.3: the new list parameters.
   - `docs/HANDOFF.md` §3: a short "Lead properties" item.
   - `AGENTS.md` "Vocabulary": what a property is, and where the catalogue lives.
   - The header comment of `lead-fields.ts`.
3. **Pushing `main` is a release** (Railway builds the backend, Vercel the
   admin). Push to `main` only when the owner says so. Both ship from the same
   push; the backend ignores unknown parameters, so confirm both deploys
   finished before testing.
4. After the release, check in production as the owner. On Get Canada Sim
   SIM orders, filter "Visa / permit type is Study permit" and compare the
   count with:

   ```sql
   select count(*) from app.leads
   where workspace_id = '10000000-0000-4000-8000-000000000101'
     and lead_type = 'sim_order' and deleted_at is null
     and payload -> 'payload' ->> 'permitType' = 'student';
   ```

   Then sort by arrival and confirm the order. Report the numbers.

5. Final report to the owner: what changed, the test results (with counts),
   anything skipped and why, and the production check.
