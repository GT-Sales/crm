# Admin UI review (5 Nov 2026)

Status: items 1 to 5 and the quick fixes are implemented (see the HANDOFF
entries "Admin UI review, first batch" and "second batch"). The General settings email finding was
a false positive: production reads the address from the Supabase sign-in
token, and only the local test session had none. Item 5's "humanize Source"
applies to the leads list and lead page; Reports → Sources still shows labels
as received, by design.

Method: the real backend (e2e harness, synthetic Get Canada Sim and CanadaWide
data) and the production admin build, driven with Playwright at 1440 px and
390 px, light and dark, plus a read of the relevant components. Every screen
loaded with no console errors and no horizontal overflow at either width.

The foundations are good: consistent cards and spacing, clear stage badges,
a lead side panel that keeps the list in view, honest empty states, a careful
Ask AI panel. The suggestions below are about putting the right work in front
of staff sooner and removing friction. Each is marked **Impact** (H/M/L) and
**Effort** (S/M/L).

## 1. Highest value

1. **Lead page: show what needs action first** (H, S).
   Nadia Khan has a pending change request and an unreviewed passport. On
   desktop both sit mid-page; on a phone the change request is the ninth card,
   below Source. Add an attention strip under the header ("Change request #1
   waiting · Passport not reviewed · Arrives in 15 days") with jump links, and
   order the phone layout attention → tasks → contact → order → the rest.

2. **Stage as a guided path, not a dropdown** (H, M).
   A SIM order has a fixed path (Incomplete → Pending → Verified → Delivered →
   Activated → Completed), but the header shows a plain select. Show the path
   as a stepper with the next step as one primary button ("Mark verified"),
   and state a gate before the click ("Delivered needs a courier and an
   approved passport"). The backend already computes this (`planStageMove`,
   the documents check, and the new per-choice `needs` from phase A).

3. **Make Documents a review queue** (H, M).
   The Documents page is a static explanation with an "Open leads" button.
   Nadia's passport is waiting, but nothing on that page says so. List every
   file not yet reviewed (and rejected ones awaiting a new upload) with the
   lead, the document type, and Approve, Reject and View inline. Add a count
   badge to the Documents nav item.

4. **Ctrl/Cmd K should find leads, not only pages** (H, M).
   `quick-navigation.tsx` filters eight page names. Staff on the phone with a
   customer need "MS-4", a name, an email or a phone number. The inbox search
   already exists server-side; reuse it in the palette, with pages as a
   second group.

5. **Leads inbox toolbar and columns** (M, S).
   - Search, filter, columns and saved views are four unlabeled round icons;
     search is hidden behind one. Show a visible search field and label
     Filter and Views.
   - "All leads 6" and "SIM order 6" are identical on a one-type site. Hide
     the type tabs when a site has one type.
   - Source shows raw monospace `utm:google/cpc`. Show "Google · paid" with the
     raw value in a tooltip.
   - Every new row carries a blue NEW pill, which turns the table into a wall
     of badges. Use a small dot or bold name instead.
   - The sidebar's "6" beside Leads has no label. Add "6 unopened" as its
     accessible name and tooltip.

6. **Phone inbox as cards** (M, M).
   At 390 px the table keeps Lead, Type and Stage. Type is redundant on a
   one-type site, and the arrival countdown and next task, which matter most
   for SIM orders, are cut. Use a card per lead: name, stage, "Arrives in 15
   days", next task.

## 2. Worth doing next

7. **Flow editor header is overloaded** (M, S).
   One row holds Flow/Runs, Canvas/List, a version select, Test run, Save
   draft, Activate and Reset to default, while the On/Off switch sits apart
   under the title. On a phone these wrap into a cluster with "Reset to
   default" orphaned on its own line. Put On/Off and Activate together as the
   primary pair, move Reset to default and version history into a "More"
   menu, and keep Canvas/List beside the canvas. Also fix "1 steps
   configured" in `flow-setup.tsx`.

8. **Automations list repeats itself** (M, S).
   For built-ins, Name and When say the same thing twice ("When a SIM order
   moves to Delivered → send the Dispatched email" next to "A SIM order moves
   to Delivered"). The Status column is empty on every row. Give built-ins
   short names ("Dispatched email"), keep the trigger in When, and show the
   Status column only for "Needs attention" or "Draft not published".

9. **Dashboard** (M, S).
   - The Follow-ups card stretches to the chart's height and is mostly
     empty. Let it size to content, or list the next five tasks.
   - "Top partners" appears on a site with no partner programme. Hide it when
     there are no partner leads.
   - "(UTC days)" in the chart caption is jargon. Say "per day".
   - Pipeline bars are grey while stage badges are coloured. Reuse the badge
     colours so the two read as one system.
   - Add a "Needs attention" tile: change requests waiting, documents to
     review, arrivals within three days that are not yet verified.

10. **Lead page details** (M, S).
    - The Tasks card shows an always-open empty form under "0 open". Collapse
      it to an "Add task" button.
    - Country shows "IN". Show "India" (`Intl.DisplayNames`).
    - "Staff details" is an empty card with only Edit. Hide it when empty or
      say "Nothing recorded".
    - "You opened this" entries add noise to the timeline. Fold them into a
      single "Viewed by" line or filter them out by default.

11. **Ask AI** (M, S).
    - Source cards print raw ISO instants: "1970-01-01T00:00:00.000Z ≤ created
      < 2026-11-05T14:11:13.959Z". Format them as "All time, up to Nov 5,
      2:11 PM". This text comes from `SourceRegistry` scope strings on the
      backend.
    - The panel floats over the table, so staff cannot see the rows the
      answer talks about. Offer a docked mode that narrows the page, as the
      lead side panel already does.

12. **Identity and theme** (M, S).
    - "Sign out" is a bare top-level link and nothing shows who is signed
      in. Replace it with an account menu (name, email, theme, sign out). The
      sidebar footer, which repeats the site name already shown at the top,
      is a natural home for it.
    - The theme ignores the operating system's dark preference
      (`app/layout.tsx` only reads the stored choice). Default to the system
      and offer Light, Dark and System.
    - In dark mode, primary buttons turn pale blue with low-contrast text
      ("Approve changes"). In both themes, disabled primary buttons ("Add
      task", "Add note", "Save name") look like enabled light buttons. Give
      disabled a clearly muted style and check contrast for the dark primary.

## 3. Quick fixes

- **Plans:** the intro says the same thing twice, once from the page and once
  from `plans-settings.tsx`. Internet and Mobility sections show on a
  SIM-only site; collapse types with no plans behind "Add a plan for another
  order type". The inline Active checkbox hides a plan from the website in
  one click; ask for confirmation or move it into Edit.
- **General settings:** the email field shows the placeholder "Signed-in
  staff account" instead of the actual address.
- **Board:** seven columns need a custom slider to scroll. Collapse empty
  columns to narrow strips. Cards show the phone while the table shows the
  email; pick one.
- **My tasks:** group by Overdue, Today and Upcoming, and give owners an
  "All team" filter.

## 4. Suggested order

| Batch | Items                     | Why first                              |
| ----- | ------------------------- | -------------------------------------- |
| 1     | 1, 5, 10, 11, quick fixes | Small changes, visible every day       |
| 2     | 2, 3, 4                   | Biggest time savings in order handling |
| 3     | 6, 7, 8, 9, 12            | Polish and phone use                   |

Screenshots were taken locally for this review and are not committed.
