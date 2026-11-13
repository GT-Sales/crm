/**
 * The CRM guide's topics: fixed, reviewed product copy that Ask AI reads with
 * `getCrmGuide` (see crm-guide.ts) to answer "where do I…" and "how do I…".
 *
 * Every page, tab, button and permission named here is taken from the admin's
 * own components (apps/admin/src). When the admin's labels change, change the
 * matching topic in the same pull request; the assistant is told never to name
 * a control the guide does not mention.
 */

export interface CrmGuideTopic {
  /** kebab-case id, e.g. 'leads-archive' */
  readonly id: string;
  /** one line, <= 90 chars, what questions this answers (shown to the model in a list) */
  readonly summary: string;
  /** the help text: plain English, short steps, <= ~1200 characters */
  readonly body: string;
}

const text = (...lines: string[]): string => lines.join('\n');

export const CRM_GUIDE_TOPICS: readonly CrmGuideTopic[] = [
  {
    id: 'navigation',
    summary: 'Finding your way: the sidebar pages, top bar search, switching site, signing out',
    body: text(
      'The sidebar lists the pages: Dashboard, Leads, My tasks, Documents, then under Manage: Reports, Automations and Settings.',
      'Leads shows a count of new leads not opened yet; Documents shows how many documents wait for review.',
      'Top bar:',
      '1. "Search leads, pages…" (or Ctrl+K / Cmd+K) finds a lead by name, order number, email or phone, or jumps to a page. Press Enter to open the first result.',
      '2. "Ask AI" opens the assistant (shown only when it is available for you on this site).',
      '3. The theme button switches light and dark mode.',
      '4. "Sign out" signs you out.',
      'To work on another site, open the site menu at the top of the sidebar ("Switch site") and pick it.',
    ),
  },
  {
    id: 'dashboard',
    summary: 'The Dashboard: key figures, period, comparison, filters, charts and follow-ups due',
    body: text(
      'Dashboard shows the site at a glance for a period.',
      '1. Click the date button to pick a period (Today, Last 7 days, Last 30 days, This month, Last month, This quarter, This year, or Custom range) and "Compare with" (Previous period, Same period last year, No comparison).',
      '2. "Filters" narrows by Lead type, Source, Partner, Assigned to, Payment status, Plan and Delivery. Remove a filter from its chip, or "Clear filters".',
      '3. Day / Week / Month sets how the charts group time.',
      'Key figures include New leads (or New orders), Won, Conversion rate, Paid, Open follow-ups, Carrier commission and Documents to review. Commission earned and Expected commission are shown to the owner only.',
      'Charts: New leads over time, Funnel by stage (choose a lead type to see it), Sources and partners, plans, and Payment and commission status.',
      'The "Follow-ups due" card lists open tasks due today or earlier across the team; "Open the follow-ups in Leads" shows them all.',
    ),
  },
  {
    id: 'leads-list',
    summary:
      'The Leads page: lead type tabs, the Archive tab, search, opening a lead from the list',
    body: text(
      'Leads lists the site’s leads.',
      '1. Tabs across the top: "All leads" (when the site has more than one lead type), one tab per lead type with its count, and "Archive" (shown once something is archived).',
      '2. The search box ("Search name, email, phone…") searches the open tab. It needs contact access; other roles see "Search needs contact access".',
      '3. The toolbar buttons beside it: Filters, View options, Export (round download icon, for roles that may export) and Saved views (bookmark icon).',
      '4. Click a lead’s name to open it in a side panel; Ctrl/Cmd-click opens it in a new tab.',
      'A small dot beside the name ("New: not opened yet") marks a lead nobody has opened yet.',
      'Related topics: leads-filters, leads-views, lead-record, leads-archive, leads-export.',
    ),
  },
  {
    id: 'leads-filters',
    summary: 'Filtering leads: stage, assignee, follow-ups due, property filters, clearing filters',
    body: text(
      'Leads → Filters (funnel icon in the toolbar). A dot on the icon means a filter is on.',
      '1. Stage: pick one stage (table layout only), or "All stages".',
      '2. Assignee: Anyone, Assigned to me, Unassigned, or a teammate.',
      '3. "Follow-ups due": leads with an open task due today or earlier (shown while there are any).',
      '4. Property filter: choose a Property, an operator and a value, then "Apply filter". Needs contact access; not in the Archive tab.',
      'Property filters show as chips above the list; remove one with its chip, or "Clear filters". "Reset filters" in the menu clears stage, assignee, follow-ups and property filters.',
      'To keep a set of filters, save it as a view (see leads-views).',
    ),
  },
  {
    id: 'leads-views',
    summary: 'Table vs board, sorting, showing columns, saved views (save, rename, delete)',
    body: text(
      'Leads → View options (sliders icon):',
      '1. Layout: Table or Board. Board works on one lead type’s tab, not on All leads or the Archive.',
      '2. Ordering: "Sort by" (Name, Created, Last activity) and Direction (table only).',
      '3. Table columns: tick the columns to show. "Property columns (up to 6)" adds site properties.',
      '4. On the board: "Display properties" picks what cards show, "Board columns" hides or shows stages. Each column’s menu has Move left, Move right, Move to the end and Hide column; columns can also be collapsed.',
      '5. "Reset view" goes back to the default table.',
      'Saved views (bookmark icon): pick "All leads" or one of your views. After changing filters, sort or columns, choose "Save" to update the open view or "Save as new view" to name a new one. Each view has Rename and Delete buttons. Only you can see your views.',
    ),
  },
  {
    id: 'lead-record',
    summary:
      'Opening a lead: side panel tabs, Open full page, Copy info, editing contact or details',
    body: text(
      'Click a lead’s name in Leads to open the side panel. Its tabs are Home, Tasks, Notes, Files and Activity. "Open full page" opens the lead page itself, where everything is on one page with a back link to the lead type’s list.',
      'The header card shows the name, lead type, reference and when it was received, with Stage and Assignee menus (for those who manage leads) and, at the bottom, "Copy info" and "Archive".',
      'On Home (or the full page) you find Contact, the lead’s detail sections, Source, ID check, Other requests from this person and any change request.',
      'To edit: click "Edit" on the Contact card or on a details section, change the fields, then save. Editing needs the Leads role (or owner), and the lead must not be archived.',
      'Roles without contact access see only the stage and source, not the customer’s details, notes or tasks.',
    ),
  },
  {
    id: 'lead-stage',
    summary: 'Moving a lead to another stage, moves that ask for details or documents, Move anyway',
    body: text(
      'On the lead (panel or full page) use the Stage menu in the header card. It offers only the stages allowed from the current one. Needs the Leads role (or owner).',
      'On the board you can also drag a card to another column, or use the card’s menu → "Move to".',
      'Some stages ask for details first. A dialog "Move to <stage>" opens, for example Courier, Tracking number and Dispatched on, or Activated on, Activation number and Activation account. Fill them in and press "Move". From the board such a move says to open the lead instead.',
      'A move can need approved documents. If some are missing the dialog lists them. Approve them first (see documents-review). The owner and the Orders role may press "Move anyway" after giving a "Reason for moving anyway".',
      'A move can queue a customer email through an automation; the lead shows a note if an email was not sent.',
    ),
  },
  {
    id: 'lead-assign',
    summary: 'Assigning a lead to yourself or a teammate, unassigning, finding unassigned leads',
    body: text(
      '1. Open the lead (side panel or full page).',
      '2. In the header card, open the Assignee menu and pick a teammate, yourself ("(you)"), or "Unassigned". It saves at once.',
      'Needs the Leads role (or owner). An archived lead must be restored first.',
      'To see who has what: Leads → Filters → Assignee (Assigned to me, Unassigned or a teammate).',
      'Automations can also assign leads with an "Assign lead" step.',
    ),
  },
  {
    id: 'lead-notes',
    summary: 'Adding a note to a lead, reading the timeline and activity history',
    body: text(
      '1. Open the lead. In the side panel go to the Notes tab; on the full page use the Timeline card.',
      '2. Type in "Add a note: what was said, what happens next…".',
      '3. Press "Add note" (or Ctrl/Cmd+Enter).',
      'Adding notes needs the Leads role (or owner) and an active (not archived) lead.',
      'The Activity tab in the side panel (Timeline on the full page) shows the history: stage moves, assignments, emails, notes and changes.',
      'Ask AI can also prepare a note for you to confirm.',
    ),
  },
  {
    id: 'tasks',
    summary: 'Creating follow-up tasks on a lead, completing them, and the My tasks page',
    body: text(
      'Create a task on a lead:',
      '1. Open the lead → Tasks tab (side panel) or the tasks card (full page).',
      '2. Under "New task" write "What needs to be done?", optionally a Due date, and "Assign the task to" (Me, Unassigned or a teammate).',
      '3. Press "Add task".',
      'Tick the round button on a task to complete it (again to reopen); the × cancels it. "Show N closed tasks" lists finished ones. Changing tasks needs the Leads role (or owner).',
      'My tasks (sidebar) lists follow-ups across leads, soonest first. Choose Assigned to me, Unassigned or Everyone, and List or Board. The board groups by Status or Date: drag a card, or use its menu to set the status or due date.',
    ),
  },
  {
    id: 'lead-customer-email',
    summary: 'Emailing a customer from a lead: the SIM number email, and email drafts from Ask AI',
    body: text(
      'From the lead page you can email a SIM order’s customer their number:',
      '1. Open the lead and save the SIM number in its details.',
      '2. When asked "Email the customer this number?", press "Email the customer", or later press "Email it to the customer".',
      'It is queued and the customer gets it within a minute. Needs the Leads role (or owner), a customer email address, and Settings → Email set up; otherwise the lead page says what is missing.',
      'For any other email to a lead’s customer, ask Ask AI to prepare one. Edit the draft card if needed and press "Send" to queue it.',
      'Emails sent on stage moves come from automations (see automations) using the texts in Settings → Email.',
    ),
  },
  {
    id: 'documents-review',
    summary: 'Reviewing customer documents: the Documents page, approve, reject, view, download',
    body: text(
      'Documents (sidebar) is the review queue. Tabs: "To review" and "Rejected".',
      'Each row shows the document and its lead, with buttons:',
      '1. "Approve" or "Reject" — needs the Orders role (or owner).',
      '2. "View" or "Download" — needs the document download permission, which the owner can grant.',
      'The same buttons appear on a lead’s Documents card (Files tab in the side panel).',
      'Approved documents let an order move to stages that require them (see lead-stage).',
    ),
  },
  {
    id: 'change-requests',
    summary: 'Customer change requests on a lead: approving or rejecting them',
    body: text(
      'When a customer asks to change their details, the lead shows a "Change request #N" card with each Field, what it is Now and what was Asked for, plus any documents sent with it.',
      '1. Open the lead (Home tab in the side panel).',
      '2. Press "Approve changes" or "Reject".',
      'Deciding needs the Leads role (or owner). An archived lead must be restored first. When the request was changed or decided by someone else, use "Reload".',
      'The customer is emailed about the decision. Approved documents then wait for an Orders review on the Documents page.',
    ),
  },
  {
    id: 'leads-archive',
    summary: 'Archiving and restoring leads, one at a time or in bulk; where archived leads are',
    body: text(
      'Archiving needs the Leads role (or owner). An archived lead leaves the active list and its automations stop.',
      'One lead: open it (side panel or full page) and press "Archive" at the bottom of the header card. To undo, open it and press "Restore".',
      'Several leads:',
      '1. Leads (table layout) → tick the leads’ checkboxes.',
      '2. The toolbar shows "N selected · Export · Archive · ✕".',
      '3. Press "Archive" and confirm.',
      'Up to 100 ticked leads change at once. Bulk archive works on ticked leads only, not after "Select all".',
      'Archived leads are in the "Archive" tab of Leads. To bring them back, tick them there and press "Restore" (or open one and press "Restore").',
      'Ask AI cannot archive leads.',
    ),
  },
  {
    id: 'leads-export',
    summary: 'Exporting leads to Excel: ticked leads or all matching, choosing fields',
    body: text(
      'Export needs export access: the owner, Leads, Orders and Finance roles have it, or the bulk export permission.',
      '1. Leads → set the tab and filters you want.',
      '2. Press the round download icon ("Export to Excel"), or tick leads and press "Export" in the "N selected" bar.',
      '3. In "Export leads to Excel" choose "Selected leads" or "All leads matching the current filters". Every page of the list is included.',
      '4. Main fields are always included; tick extra fields ("Select all" / "None" per group). "Reset to the table’s columns" restores the default.',
      '5. Press "Export" to download the .xlsx file.',
      'One export has a row limit; narrow the filters if it says there are too many. Ask AI cannot export.',
    ),
  },
  {
    id: 'reports-sources',
    summary: 'Reports: the Sources report, leads per source, received, submitted, made it',
    body: text(
      'Reports opens on its one report, Sources: leads per source, how many came in, were submitted and made it.',
      '1. Pick a period: All time, Last 3 months, Last 30 days or Last 7 days.',
      '2. Pick the lead type.',
      'Columns: Source, Received, Submitted, Made it and Made-it rate. "Made it" means the lead reached Activated, Installed, Completed or Won.',
      'For charts by period and source, see the Dashboard.',
    ),
  },
  {
    id: 'automations',
    summary: 'Automations list: turning a flow on or off, creating, archiving and restoring flows',
    body: text(
      'Automations lists the flows with Name, When, On, Last run, Runs and Status. Managing flows needs the Integrations permission (the owner has it); flows that change leads or create tasks also need the Leads role to activate.',
      'Turn a flow on or off with its switch in the On column. A flow must be activated first ("Activate the flow first."), see automation-editor.',
      'Create: press "New flow", give it a Name and press "Create". It starts empty and off.',
      'Archive: open a custom flow and press "Archive" at the bottom, then confirm. It is switched off, its waiting runs are cancelled, and you return to the Automations list. Built-in flows cannot be archived.',
      'Restore: on the list open "Archived flows" and press "Restore". It comes back off.',
      'Emails are skipped until Settings → Email is saved.',
    ),
  },
  {
    id: 'automation-editor',
    summary: 'Editing a flow: trigger, steps, Save draft, Test run, Activate, versions and Runs',
    body: text(
      'Automations → click a flow’s name.',
      '1. Flow tab: choose "Canvas view" or "List view". Click the trigger to set when the flow starts. Use "+" to add a step: Send email, Create task, Assign lead, Update lead, Notify staff, If/else or Wait.',
      '2. Edits autosave as a draft; "Save draft" saves now. "Discard draft" drops it; built-in flows also have "Reset to default".',
      '3. "Test run" uses sample lead data and changes no real leads.',
      '4. "Activate" publishes the draft. Then switch the flow on to start new runs.',
      'The version menu shows the current draft, the active version and past versions (read only).',
      'Runs tab: recent runs with their status; "Steps" expands what each step did, "Load more" shows older runs.',
      'Editing needs the Integrations permission (the owner has it). Ask AI can draft a flow you save with "Save draft".',
    ),
  },
  {
    id: 'settings-general',
    summary: 'Settings → General: your display name shown to colleagues',
    body: text(
      'Settings → General manages your own profile.',
      '1. Enter the name colleagues see on assignments, tasks and the timeline.',
      '2. Press "Save name". It applies on every site.',
      'Until you set a name, colleagues see your role instead. The page also shows your sign-in email and whether you have full or role-based access.',
    ),
  },
  {
    id: 'settings-team',
    summary: 'Settings → Team: inviting teammates, roles, removing someone (owner only)',
    body: text(
      'Settings → Team lists the members with their roles. Filter by name or "All Team Roles".',
      'Invite (owner only):',
      '1. Under "Invite new members by email address" enter the Staff email and pick a Role. Tick extra roles if needed.',
      '2. "Add more" adds another row (up to 10).',
      '3. Press "Invite". The person accepts from the sign-in page.',
      'Roles: Owner, Leads, Orders, Partners, Finance, Content, Viewer. Leads manages leads (stages, notes, tasks, archive); Orders reviews documents and can move orders without documents; owner has full access.',
      'Remove (owner only): press "Remove" beside the member and confirm; they lose access to this site.',
    ),
  },
  {
    id: 'settings-properties',
    summary: 'Settings → Properties and record layouts: custom properties and lead page sections',
    body: text(
      'Settings → Properties and record layouts. Changing anything is owner only.',
      'Properties tab:',
      '1. Built-in properties can be renamed or hidden.',
      '2. Custom properties: press "Add property", enter a Label, pick the kind (text, number, money, date, yes or no, choice, email, phone…) and the lead types, then "Save property". Options: Show on website, Staff only, Sensitive.',
      '3. Each property has Edit, Hide/Show and Delete. A property still holding values cannot be deleted; hide it instead.',
      'Layouts tab: pick a Lead type, then arrange the sections and properties of its lead page. "Add section", move items up or down, then "Save layout".',
    ),
  },
  {
    id: 'settings-plans',
    summary: 'Settings → Plans: adding or editing plans, price, documents, turning a plan off',
    body: text(
      'Settings → Plans lists the plans per kind of order. Adding and editing needs the Orders role (or owner).',
      '1. Press "Add plan" under the order kind, or "Edit" on a plan.',
      '2. Set the name, "Price (CAD)", "Billing period", "Payment required", "Active" and the "Required documents".',
      '3. Press "Save plan".',
      'Only active plans are offered on the website; turning a plan off asks first. Commission is set and seen by the owner only.',
      '"Plan properties" (top right) manages extra details kept on each plan and which ones the website shows.',
    ),
  },
  {
    id: 'settings-email',
    summary: 'Settings → Email: sender, branding, editing email templates, sending a test',
    body: text(
      'Settings → Email sets who customer emails come from and what they say. Changes need the Integrations permission (the owner has it).',
      'Sender and style: Sender name, Sender address (a verified domain), Reply-to address, Logo URL, Brand colour, Site address, Style (Classic or Website hero), Accent colour and Footer. Press "Save settings".',
      'Emails list:',
      '1. Press "Edit" on an email, change the Subject and body (fill-ins go in braces, such as {first name}), then "Save".',
      '2. "Send me a test" mails it to you.',
      '3. "New template" adds a custom email; custom ones can be archived, and "Archived templates" restores them.',
      'Whether an email is sent is set on the Automations page.',
    ),
  },
  {
    id: 'settings-integrations-jobs',
    summary: 'Settings → Integrations (website credentials) and Background jobs (retry failures)',
    body: text(
      'Settings → Integrations (owner only) manages the website’s connection to the CRM:',
      '1. Under "Website service credentials" tick the Scopes and press "Issue credential".',
      '2. Copy the secret at once: it is shown only once.',
      '3. "Revoke" (then "Revoke credential") stops an existing one.',
      'Settings → Background jobs shows Pending and Failed deliveries, with "Refresh".',
      'For a failed job press "Retry". An uncertain job may already have been delivered: check the provider first, then "Mark delivered" or "Mark not delivered". Retrying needs the Integrations permission (the owner has it).',
    ),
  },
  {
    id: 'ask-ai',
    summary:
      'What Ask AI can and cannot do: questions, prepared notes/tasks/emails, automation drafts',
    body: text(
      'Open it with "Ask AI" in the top bar. With a lead open it knows which lead you mean ("Remove lead context" drops that).',
      'It can read this site’s lead counts, stages, lead and order summaries, assignments, open tasks and source performance, and explain how the CRM works.',
      'For people who manage leads it can prepare a note, a task (for you or unassigned), an email to the lead’s customer, or a change to a lead’s stage, assignee, name or phone. Each is a card: nothing is saved until you press "Confirm" (or "Send" for an email). "Cancel" drops it. Stage rules and documents still apply.',
      'With the Integrations permission it can draft or edit an automation; press "Save draft" on the card. Activating and switching it on stay in Automations.',
      'It cannot archive, export or delete anything, send bulk mail, or show contact details; use the lead page for those.',
    ),
  },
];
