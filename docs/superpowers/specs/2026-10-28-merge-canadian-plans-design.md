# Merging Canadian Plans into the CRM — design

**Status:** written for the owner's review · **Date:** 2026-10-28 · **Owner:** Md
Takibuddin · Written by an AI session after a one-question-at-a-time interview
with the owner on the same day.

This is a proposal. Nothing in [PLAN.md](../../PLAN.md), [HANDOFF.md](../../HANDOFF.md)
or the code changes until the owner approves it; §14 lists what is updated then.

## 1. Purpose

The owner runs two projects with the same purpose: **Canadian Plans**
(`Canadian-Plans/canadianplans-web-app`, the owner's own business) and this CRM
(built for GT Sales). The CRM was copied from Canadian Plans on 2026-10-25 and
pruned; both then grew different features in parallel. The owner owns both
codebases.

Goal: **one product, built from this repository**, deployed once per business
with its own database. GT Sales is the first deployment and keeps its live
database; Canadian Plans becomes the second; later clients follow the same way.
Only Canadian Plans features that earn their place move across; the rest are
dropped or deferred (§4).

Success looks like: GT Sales staff keep working throughout, Canadian Plans runs
on this product with a fresh database, and a new feature is built once.

## 2. Owner decisions (2026-10-28)

| #   | Question                                     | Decision                                                                                                                                                         |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Code ownership                               | The owner owns everything. No ownership constraint on reuse.                                                                                                     |
| 2   | Long-term shape                              | A **reusable product**: one codebase, one deployment and database per business, each configured for its own modules, rules and branding.                         |
| 3   | Order flow across businesses                 | **Basically the same** (lead → sale → dispatch → activation → commission). One set of order tools, configured per business.                                      |
| 4   | Websites                                     | **Outside the product**, each in its own repository, calling the API with a site key. Canadian Plans' storefront (`apps/site-1`) moves out too.                  |
| 5   | Multi-factor sign-in                         | **Off in every deployment** (the CRM's 2026-10-25 decision, now product-wide). Can be added back as an option if a client asks.                                  |
| 6   | Same person on several sites of one business | **Merged by email** (the CRM's `contacts`). Businesses never share customers: each has its own database.                                                         |
| 7   | Which data is live                           | **Only GT Sales'.** Canadian Plans holds test orders and is rebuilt from this product's migrations.                                                              |
| 8   | Base                                         | **This repository and its migration history.** Canadian Plans features are ported in with additive migrations.                                                   |
| 9   | Plans and prices                             | **A plans object managed in the admin.** No Sanity sync.                                                                                                         |
| 10  | Plan structure                               | Built on the **shared property engine** (§5): built-in properties plus custom ones per site, hide/show per site. No staff-created object types.                  |
| 11  | Plans across sites                           | **Each plan belongs to one site.** Admins add similar plans by hand; nothing is shared or copied automatically.                                                  |
| 12  | Quotes                                       | **No quote step and no offer versions.** The backend looks up the plan's current price at submission, ignores any browser price, and freezes a copy on the lead. |
| 13  | Order record                                 | **An order is a lead.** Each website form is a lead type; order lead types carry the order tools.                                                                |
| 14  | Order state                                  | **Separate properties:** stage (progress only), payment status, carrier commission. "Invoiced" and "Paid" leave the stages.                                      |
| 15  | Partners                                     | **Later.** Leave room now (partner code kept on leads, Partner object and partner commission planned); build no screens or payouts.                              |
| 16  | Lead history                                 | Every change is on the lead's **timeline**: who, when, which field. Customer actions too.                                                                        |
| 17  | Customer tracking                            | **Get Canada Sim's flow:** email → one-time code → see orders → request changes; staff approve. Canadian Plans' "ask the customer for…" is left out.             |
| 18  | Deleting customer data                       | **No admin feature.** Requests come through the website contact page; a developer deletes in the database. Staff can only **archive**.                           |
| 19  | Backups                                      | **Import Canadian Plans' backup system** (database + documents, encrypted, to Backblaze B2, practised restore). First step.                                      |
| 20  | Source report                                | Move.                                                                                                                                                            |
| 21  | Province waitlist                            | Skip.                                                                                                                                                            |
| 22  | Synthetic check                              | Move, simplified: a test lead to a hidden test site every 15 minutes, alert on failure, the robot cleans up after itself.                                        |
| 23  | Admin look                                   | **Hybrid:** the CRM's colours and fonts with Twenty's layout (compact tables, view bar, side panel, board). No Twenty code copied.                               |
| 24  | Saved views                                  | **Private only.**                                                                                                                                                |
| 25  | Automations                                  | A **full builder** is wanted, built **last**. Canadian Plans' automation spec stays as it is for reference; the feature is re-evaluated before it starts.        |
| 26  | Analytics                                    | **Read-only from the self-hosted Umami:** basic numbers on the dashboard, "Open in Umami" for detail. The CRM sends nothing to Umami.                            |
| 27  | Repository                                   | **Stays at `GT-Sales/crm`** with the `@gt-sales/*` package names for now. The owner moves and renames it later, in one step.                                     |
| 28  | Order tools                                  | As recommended in §6.                                                                                                                                            |
| 29  | Several lines on one application             | **One lead = one sale**, with a quantity.                                                                                                                        |
| 30  | When Canadian Plans moves                    | **After the main pieces are in** (phases 1–6). Until then the old repository gets bug fixes only.                                                                |
| 31  | Blog editor, partner portal                  | **Not in the CRM.** Website content gets its own CMS approach; the portal waits for partners.                                                                    |
| 32  | Customer email templates                     | **Shared layout + site branding + editable text** (§7).                                                                                                          |

## 3. Architecture

Unchanged from [PLAN.md](../../PLAN.md) §3 and [AGENTS.md](../../../AGENTS.md):
backend (Express, Railway) is the only database client; admin (Next.js, Vercel)
calls the API; every tenant table carries `workspace_id` with forced RLS; side
effects go through the outbox; no PII in logs.

What changes:

- **One deployment per business.** Each has its own Railway service, Vercel
  project, Supabase project (database, Auth, Storage), Resend domain and secrets.
  Same repository, same `main`, different environment variables. Migrations run
  per database, deliberately, as today.
- **Per-deployment settings** (environment) say which modules are on (for
  example the synthetic check). **Per-site settings** (database, edited in the
  admin) hold everything staff change: properties, layouts, plans, stage
  labels, email branding and texts, the Umami website id.
- **`packages/contracts` is published privately** so website repositories get
  the request/response types and the typed client.

## 4. What moves from Canadian Plans

| Moves (adapted to leads)                                                              | Skipped                          | Later                                   |
| ------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------- |
| Property engine: built-in and custom properties, per-site layouts (ADR 0007's design) | Sanity catalogue sync            | Partners, partner commission, invoices  |
| Plans (as an object, not Canadian Plans' catalogue tables)                            | Quotes and offer versions        | Partner portal                          |
| Order tools (§6)                                                                      | Separate order tables            | Automation builder (re-evaluated first) |
| Customer tracking backend: email code, attempt limits, change requests                | Customer-data deletion workflow  |                                         |
| Backup, restore, monitor and retention jobs + workflows + runbooks                    | Province waitlist                |                                         |
| Source report; synthetic check (simplified)                                           | Umami event sink (sending)       |                                         |
| Twenty-style table, view bar, side panel, private saved views (restyled)              | Multi-factor sign-in, dark theme |                                         |

Most Canadian Plans code was written for a separate `orders` table, so it is
**adapted, not copied**: logic and tests are reused, storage moves onto leads.

## 5. Data model

### 5.1 Objects

Fixed in code: **Site** (`workspace`), **Contact**, **Lead**, **Plan**, later
**Partner**. Notes, tasks and the timeline stay attached to leads. Staff cannot
create object types.

### 5.2 Property engine (leads and plans)

- A property has a permanent **key** (never reused, deleted custom keys stay
  reserved), a **label**, a **kind** (text, long text, number, money, date,
  yes/no, choice, email, phone, URL), options, and flags: _staff only_,
  _sensitive_ (never in filters, columns, views or the timeline; e.g. SIN).
- **Built-in** properties are defined in code; a site may relabel, hide or
  reorder them, never delete them.
- **Custom** properties are rows per site; values live in a `custom_values`
  JSON column. Staff changes never run DDL.
- A **layout** per site orders sections and properties for each lead type and
  for plans.
- Lists filter, sort and show columns by any property the caller's role may
  see, validated on the server. This absorbs the 2026-10-27 brief
  (`docs/briefs/lead-properties.md`).

### 5.3 Leads

- Lead types stay code-defined, one per website form: `sim_order`, `internet`,
  `mobility` (**order types**), `partner_application`, `contact_message`.
- **Stage** shows progress only, per type. For `sim_order`: Incomplete, Pending,
  Verified, On hold, Delivered, Activated, Completed, Cancelled.
- Order types add these built-ins: **plan** (link to one of the site's plans)
  and a **frozen plan copy** (name, price, billing period and plan properties
  at submission); **quantity**; **payment status** (Not needed / Pending /
  Paid, starting from the plan's _payment required_); **carrier commission**
  (Not yet / Invoiced / Received / Clawback, the existing `commissionStatus`);
  **dispatch** (courier, tracking number, date); **activation** (date, number,
  account); **documents check**.
- The **partner code** in attribution stays; a _partner commission_ property is
  planned for the partners phase.
- **Archive** replaces Trash (same soft delete, new name). There is no
  permanent delete in the admin.

### 5.4 Plans

- Each plan belongs to **one site** and one order lead type.
- Built-ins: name, price, billing period, payment required, active, required
  documents. Custom properties per site, each with a **show on website**
  switch.
- A website route (`GET /api/v1/website/plans`) returns the site's active plans with visible properties
  only. Editing a plan never changes a past lead (the frozen copy).

### 5.5 Existing data

- Get Canada Sim's `sim_order` leads in the stages `invoiced` or `paid` get a
  progress stage plus payment status and carrier commission values. **The
  mapping is decided from the real rows** (counts per stage and existing
  `commissionStatus`) before any migration, rehearsed on a copy and reconciled.
- Existing leads keep their plan **name** (`planId`/`planLabel` in the form);
  there was no plans table, so they get no plan link.

## 6. Order tools

| Tool                      | Decision                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Plan + frozen price       | Move.                                                                                             |
| Dispatch details          | Move; shown on the customer's tracking page.                                                      |
| Activation details        | Move; the activation date is the date commission is counted from.                                 |
| Documents check           | Move: Delivered/Activated need approved documents; the owner may override with a recorded reason. |
| Double-submit protection  | Move (scoped idempotency key + request fingerprint; a retry returns the existing lead).           |
| Corrections with history  | Keep the CRM's.                                                                                   |
| Notes and reminders       | Keep the CRM's notes and tasks; drop Canadian Plans' order notes and reminders.                   |
| Automatic customer emails | Move, per site and per email, **off until switched on** so no customer gets two emails (§7).      |

Stage moves are checked by the backend (allowed moves per type). Status
dimensions stay independent.

## 7. Customer email

Templates live in the CRM, never in the websites: most mail is sent by the
backend after a staff action, when no website is involved.

- **Site email settings** (admin): sender name and address (on a domain verified
  in Resend), reply-to, logo, brand colour, footer text (company name and
  address). Replaces `EMAIL_SENDERS_JSON`.
- **One shared layout** (header with logo, body, footer, button in the brand
  colour) used for every email of every site.
- **Per site, per email:** on/off, subject and body. The body is plain text with
  paragraphs, bold, links and one button, and fill-ins such as `{first name}`,
  `{plan}`, `{SIM number}`, `{tracking link}`. Starter texts ship in code.
- **Preview** and **send me a test** before switching on.
- Only known fill-ins; values escaped; a missing value blocks the send and tells
  staff why (as `sim_number_ready` does today). Each edit is a saved version;
  each sent message records the version it used.
- Templates: tracking code, order received, documents/information needed,
  dispatched, activated, cancelled, SIM number ready. The automation builder
  later reuses them.

## 8. Customer tracking

Get Canada Sim's `/track` stays in its own repository and calls the CRM: email →
6-digit code (10-minute lifetime, per-email limits) → the customer's leads on
that site → stage, plan, dispatch and SIM number → **request a change** (fields
and documents). Staff approve or reject in the CRM; both appear on the timeline.
Backend parts come from Canadian Plans' `tracking/` (challenges, cipher, limits,
change requests), adapted to leads.

## 9. Analytics, reports and checks

- **Umami (read-only):** each site stores its Umami website id; the backend
  holds a read-only Umami user's login. A dashboard section shows visitors, page
  views, top sources/UTM, countries, top pages and devices for 7/30/90 days,
  cached for a few minutes, beside the CRM's leads and activations per source,
  with an **Open in Umami** link. Aggregates only, no personal data.
- **Source report:** Canadian Plans' `reports/` counting over the stored,
  sanitized attribution, adapted to leads.
- **Synthetic check:** every 15 minutes the scheduler submits a test lead to a
  hidden test site through the same services the website route uses, deletes
  it, and alerts on failure. Email is off on that site. Cost: negligible on the
  always-on backend.

## 10. Backups

Import `jobs/src/{backup,restore,monitor,retention}`, `.github/workflows/backup*.yml`
and the restore and alert runbooks from Canadian Plans. Adapt the file source to
Supabase Storage's S3 endpoint (the same protocol the backend already uses);
Sanity stays off. The dump includes Get Canada Sim's legacy `public` tables.
Secrets live in GitHub's protected environment; archive-write without
archive-delete. Done when one nightly encrypted archive lands in Backblaze B2
and one restore has been practised on a scratch database.

## 11. Admin

- CRM colours and fonts; Twenty layout: 220 px sidebar, compact rows, view bar
  (filter, sort, columns), records in a side panel, board per type. Canadian
  Plans' table, view bar and side-panel components are moved and restyled. No
  Twenty source enters the repository.
- **Private saved views** per person (Canadian Plans' `saved_views`, adapted to
  leads); the free-text search box is never saved.
- New settings pages: properties and layouts, plans, email.

## 12. Phases

Each phase ships on its own and leaves GT Sales working.

| #   | Phase                                                                                                                                    | Done when                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Backups (§10)                                                                                                                            | A nightly archive lands in B2 and a restore has been practised.                                                  |
| 2   | Property engine for leads + hybrid layout + private saved views (§5.2, §11)                                                              | Staff work leads in the new layout, filter by any property and add a custom property.                            |
| 3   | Plans + stage clean-up: plans object and API, frozen plan, quantity, payment status and carrier commission out of stages (§5.5), Archive | Staff manage plans; a test website reads them; no lead is left in an `invoiced` or `paid` stage.                 |
| 4   | Order tools + customer email (§6, §7)                                                                                                    | A test SIM order goes from submitted to activated with branded emails; an unapproved document blocks activation. |
| 5   | Customer tracking (§8); Get Canada Sim's `/track` switches                                                                               | A real customer's change request is approved in the CRM.                                                         |
| 6   | Source report, Umami dashboard, synthetic check (§9)                                                                                     | The dashboard shows visitors beside leads per source; a broken intake raises an alert.                           |
| 7   | Canadian Plans moves: new deployment and database, `apps/site-1` to its own repository, old backend and admin off                        | A Canadian Plans test order goes through the new deployment.                                                     |
| 8   | Review, then automations                                                                                                                 | Decided then.                                                                                                    |

The CRM's open items (cross-site inbox, contact page, split/merge, the
CanadaWide cutover clean-up; [HANDOFF.md](../../HANDOFF.md) §5) are scheduled
where they touch the same screens, mostly phases 2–3. Each phase gets its own
implementation plan.

## 13. Testing

Every phase follows [AGENTS.md](../../../AGENTS.md): typecheck, lint and format;
unit and integration tests on a disposable Postgres including the isolation
suite; admin browser tests for changed journeys; migrations additive and
applied deliberately by the owner. Every move of existing data is rehearsed on
a copy with counts reconciled before and after. Ported Canadian Plans tests come
with the code they cover.

## 14. Hard-to-change decisions

| Level  | Decision                                                  | Why                                                                                                    |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Hard   | An order is a lead (one lead = one sale, with a quantity) | Commission, tracking, email, reports and automations attach to leads. Revisit if lines activate apart. |
| Hard   | Each plan belongs to one site                             | Every sale points at one site's plan.                                                                  |
| Medium | Contacts merged by email                                  | Undoing means splitting every merged person.                                                           |
| Medium | Stage keys                                                | Labels change freely; reports, emails and automations reference keys. Settle stages before phase 8.    |
| Medium | Repository location and package names                     | Each extra deployment is one more thing to reconnect at the move.                                      |

Easy at any time: multi-factor sign-in, shared views, a deletion button, which
emails go out, sending events to Umami.

## 15. Risks and open items

| Item                                                                | Handling                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Stage mapping for existing SIM orders                               | Decided from the real rows in phase 3, rehearsed on a copy.                                 |
| Duplicate customer emails (the websites may already send their own) | Every email starts off; the owner switches each one on per site after checking the website. |
| Supabase plan of the GT Sales project                               | Owner to confirm; the imported backup covers either plan.                                   |
| Umami read-only user and whether GT Sales' sites use the same Umami | Owner to create the user; one Umami per deployment is supported.                            |
| Drift while porting                                                 | Canadian Plans' repository takes bug fixes only until phase 7.                              |
| Ported code assumes a separate orders table                         | Adapt module by module with its tests; nothing copied blind.                                |

## 16. Documents updated on approval

- [PLAN.md](../../PLAN.md): §1 decision 8 (Get Canada Sim's order rules) is
  replaced by §2 here; §7 phases 3–4 are replaced by §12.
- [HANDOFF.md](../../HANDOFF.md): "what comes next".
- Canadian Plans' `PLATFORM_CONTEXT.md`: a note that new work happens here.
