# Get Canada Sim admin: what staff do there today

A survey of `Get-Canada-Sim/src/app/admin` (2026-10-27), so the CRM can take
these jobs over feature by feature. Only what the code does; file names are
relative to that repo.

## Access

- Sections `orders`, `partners`, `finance`, `blog`, `internet_leads`,
  `mobility_leads`, each `none` / `view` / `edit` (`admins.permissions`);
  `super_admin` sees everything plus Admins and Document audit.
- Email or username + password, 8 tries per 15 minutes, bot check; database
  super admins also need an emailed 6-digit code; an env break-glass super
  admin when the database is down (1-hour session, alert email). Sessions 8
  hours, re-checked against `admins` on every request.

## Dashboard (`/admin`)

Window: all time / 3 months / 30 days / 7 days. Cards: total orders,
completed, pending action (pending + verified, with "N edit requests" and "N
follow-ups due"), cancellations (count and rate). Follow-ups due (6, opens the
drawer). Order volume per day; top 10 partners. Reads the 200 newest
non-archived orders only.

## Orders (`OrdersBoard.tsx`, `lib/orders.ts`, `admin/actions.ts`)

- A paginated table (10–50 rows), not a kanban. Columns: `MS-<order_no>` with
  a "New" badge until someone opens it (`viewed_at`, team-wide), customer,
  plan, SIM type, placed, arrival with "N days left", partner + reference,
  follow-up (due today / overdue / in N days / done), document dots, status
  with commission badge and "Edit" badge for a pending change request.
- Search (id, name, email, phone, reference, partner) and filters (date,
  status, partner, follow-ups due) cover only the 200 loaded rows.
- Row menu: edit (drawer), Copy Info (plain-text summary), Print Delivery
  Letter (`public/delivery-letter.html`, details in the URL), Archive /
  Restore (`archived_at`; archived orders still show on `/track` and the
  portal and can still be invoiced).
- Statuses: `incomplete` (checkout step 1; filter only) and the nine staff
  can set, in order: pending, verified, on_hold, delivered, activated,
  completed, invoiced, paid, cancelled. Commission-earning: activated,
  delivered, completed, invoiced, paid.
- Commission tracker `commission_status`: none / invoiced /
  commission_received / claw_back (the carrier's commission; no side effects).

### Order drawer

- Overview: follow-up reminder (call-back date, note ≤ 300, mark done,
  reschedule, clear: `reminder_at`, `reminder_note`, `reminder_done_at`);
  edit contact (name, phone, email), status, plan (current catalogue), permit
  type, SIM type, arrival, flight booked, got visa, shipping address (physical
  SIM, required, ≤ 400), Canada address, reference. Partner link read-only.
  Saving Cancelled cancels the partner's pending earning; leaving Cancelled
  revives it. No email on status changes.
- Documents: SIM number (≤ 40; on save, "email the customer this number?";
  shown on `/track`), passport and approval letter (image lightbox, PDF via
  `/admin/api/proxy-pdf`, upload/replace ≤ 8 MB, type from bytes), SIM card
  photo and billing contract (staff only). Signed links 1 hour. No document
  approval control.
- Activity: partner note (portal, read-only here), admin note (≤ 2,000, one
  overwritten text, visible to the partner), commission status, IP and
  country. No timeline.
- Customer change requests (`order_edit_requests`, from `/track` while
  pending/incomplete; one pending per order): name, phone, plan, delivery,
  arrival, permit, Canada address, shipping address, flight booked, plus staged
  passport/visa files. Panel shows "current → requested"; Approve & apply
  (writes the order, swaps files, emails the customer) or Reject (deletes
  staged files, emails the customer).

## Partners (`admin/partners`, `lib/partners.ts`)

- Roster of approved partners (orders count, country, licence link; copy
  info, mailto); Applications queue (new/contacted): accept / reject with
  confirmation and an email to the applicant. Nothing sets "contacted".
- Partner page: financial overview from `partner_earnings` (total, pending,
  paid, balance, BDT), orders through the partner (cards, volume chart, table),
  agency info, commission per order (fixed BDT, 0–5,000; changing it needs a
  6-digit code emailed to `ADMIN_OTP_EMAIL`), payout preferences (bKash or
  bank, read-only).
- Referral: `?ref=<partner uuid>` sets `ms_ref` for 30 days (latest wins); the
  order form prefills the partner's email as Reference and requires passport
  and visa; at checkout a Reference matching an approved partner sets
  `partner_id` and, at a rate above 0, a pending `partner_earnings` row.
- Partners edit their own pending orders in the portal without approval.

## Finance (`admin/finance`, `lib/invoices.ts`, `api/cron/invoices`)

- Earnings table (pending / paid / cancelled), summary cards.
- Invoices: "Generate previous month" (and a monthly cron, 00:00 UTC on the
  1st): per approved partner without a live invoice for the month, orders
  whose arrival falls in that month and whose status earns commission; draft
  `INV-YYYYMM-XXXX`. Detail: validate (publishes it to the portal), mark paid
  (marks its earnings paid), cancel; on drafts add bonus / deduction /
  adjustment lines; notes.

## CanadaWide leads (old Internet / Mobility Leads pages)

Tables of the 500 newest rows; search, status filter, show deleted; drawer
edits status, name, email, phone, provider; one admin note; the same
follow-up reminder; delete / restore; mobility ID files (5-minute links,
each view logged). The CRM already covers these (stages, notes with history,
tasks, trash, ID check).

## Blog, team, audit

- Blog: posts with Markdown editor, slug, excerpt, status, authors, cover,
  SEO fields, preview; images in `blog-images`.
- Admins (super admin): per-section access, profile, disable, reset password
  (ends sessions), delete; activity log (when, actor, action, target, details,
  IP) for order, partner, invoice, post, lead and admin actions; document
  audit (unreferenced files in `documents`).

## Automatic behaviour and emails

- Crons: monthly invoices; daily retry of failed order confirmations and
  new-order alerts (`notifications`, 50 per run, 6 attempts).
- Reminders notify no one and belong to no one.
- Emails: SIM number ready (staff choice), change request applied / rejected,
  partner accepted / declined, commission and sign-in codes, break-glass
  alert, order confirmation + internal new-order alert, internal alert for a
  change request.

## Not in the old admin

Assignment, tags, bulk actions, export, kanban, a per-order timeline,
reminder notifications, permanent deletion of orders.
