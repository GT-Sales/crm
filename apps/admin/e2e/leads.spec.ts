import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Staff working leads in a real browser against the real backend (see
 * playwright.leads.config.ts). The harness seeds CanadaWide with four internet
 * leads (two new, one contacted with an overdue task, one won) and one
 * mobility lead, all through `utm:google/cpc` (the contacted one under the
 * campaign `fall_promo`) except one new internet lead with no source data,
 * which the source report journey counts before any journey moves a lead, plus Get Canada Sim with three SIM orders, two plans
 * ("Rogers 60GB" $40 a month with payment required, "Fido 75GB" $35 a month
 * without) and a fourth SIM order, Nadia Khan's, submitted with Rogers 60GB
 * frozen on it, signed in as the owner "Takib" with a colleague "Sam". The journeys share those seeded sites
 * and run in order. A lead's name in the inbox opens it in the side panel
 * (`?lead=`); "Open full page" goes to its own page. One journey adds a
 * custom property, a saved view and a hidden built-in, and puts them back; the
 * one after it adds a plan, works an order and archives and restores it. The
 * last takes that order to Activated: Rogers 60GB requires a passport, Nadia
 * Khan's is attached and not reviewed, Get Canada Sim's email settings are
 * saved with its Dispatched email at version 1, and every flow is off: the
 * six built-ins and one custom flow, "Verified follow-up" (when a SIM order
 * moves to Verified: if its plan is Rogers 60GB, a task for the lead's owner;
 * else wait two days, then the Activated email), activated through the flow
 * store. Nadia Khan also has a pending change request #1 from the website's
 * tracking (a new phone and arrival date), which the tenth journey approves.
 * Leila Ahmadi, a second Rogers 60GB order on Pending, is the one the custom
 * flow's journey moves; Omar Haddad, an abandoned checkout (Incomplete, the
 * Fido plan, never submitted), is the one the last journey rescues.
 */
test.describe.configure({ mode: 'serial' });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/** Icon menus retain their contents while a setting changes. */
async function openInboxMenu(page: Page, name: 'Filters' | 'View options' | 'Saved views') {
  const button = page.getByRole('button', { name, exact: true });
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
}

test('the inbox shows each lead type with counts and searches as you type', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/leads');
  await expect(page.getByRole('tab', { name: /All leads\s*5/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Internet\s*4/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Mobility\s*1/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ellis Mobile' })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search leads' }).fill('blake');
  await expect(page).toHaveURL(/q=blake/);
  await expect(page.getByRole('link', { name: 'Blake Sample' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Avery Example' })).toHaveCount(0);

  await page.getByRole('searchbox', { name: 'Search leads' }).fill('');
  await page.getByRole('tab', { name: /Mobility/ }).click();
  await expect(page).toHaveURL(/type=mobility/);
  await expect(page.getByRole('link', { name: 'Ellis Mobile' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Avery Example' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Documents lists the files waiting on staff, and the lead flags them', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/getcanadasim/documents');
  // Nadia Khan's passport is attached and not reviewed; Rogers 60GB requires it.
  const queue = page.getByRole('list', { name: 'To review documents' });
  const row = queue.getByRole('listitem').filter({ hasText: 'Nadia Khan' }).first();
  await expect(row.getByText('Required by plan')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Approve Passport for Nadia Khan' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Documents, \d+ to review$/ })).toBeVisible();
  // Her lead says what waits on staff and takes them to it.
  await row.getByRole('link', { name: 'Nadia Khan' }).click();
  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(attention.getByRole('button', { name: 'Change request #1 waiting' })).toBeVisible();
  await expect(attention.getByRole('button', { name: 'Passport not reviewed' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the dashboard lists the follow-ups due, and Leads filters to them', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/dashboard');
  await expect(page.getByRole('heading', { level: 2, name: 'Follow-ups due' })).toBeVisible();
  // The site's busiest type over the last 30 days: CanadaWide's internet leads.
  await expect(page.getByRole('heading', { name: 'New leads', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Funnel by stage' })).toBeVisible();
  // The period lives in the URL, so the view can be shared.
  await page.getByRole('button', { name: /change the period/ }).click();
  await page
    .getByRole('group', { name: 'Period' })
    .getByRole('button', { name: 'This year' })
    .click();
  await expect(page).toHaveURL(/\/dashboard\?period=this_year/);
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Month', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('heading', { name: 'New leads over time' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'New leads over time' })).toBeAttached();
  await page.reload();
  await expect(page.getByRole('button', { name: /change the period/ })).toContainText('This year');
  const followUp = page.getByRole('link', { name: /Casey Demo/ });
  await expect(followUp).toContainText('Confirm the install window');
  await expect(followUp).toContainText(/Overdue by \d+ days/);

  await page.getByRole('link', { name: 'Open the follow-ups in Leads' }).click();
  await expect(page).toHaveURL(/\/leads\?due=1$/);
  await openInboxMenu(page, 'Filters');
  const toggle = page.getByRole('button', { name: /Follow-ups due\s*1/ });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: 'Casey Demo' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Avery Example' })).toHaveCount(0);

  await toggle.click();
  await expect(page.getByRole('link', { name: 'Avery Example' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test("the source report counts CanadaWide's internet leads per source and opens a source's campaigns", async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/dashboard');
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/w\/canadawide\/reports\/sources$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Sources' })).toBeVisible();

  const period = page.getByRole('group', { name: 'Period' });
  await period.getByRole('button', { name: 'All time' }).click();
  await expect(period.getByRole('button', { name: 'All time' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const leadType = page.getByLabel('Lead type');
  await expect(leadType.locator('option:checked')).toHaveText('Internet');

  const table = page.getByRole('table', { name: 'Leads per source, all time' });
  const row = (name: string) =>
    table.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
  const cellsOf = (name: string) => row(name).getByRole('cell');
  await expect(cellsOf('utm:google/cpc')).toHaveText(['3', '3', '1', '33%']);
  await expect(cellsOf('Direct')).toHaveText(['1', '1', '0', '0%']);
  await expect(cellsOf('Total')).toHaveText(['4', '4', '1', '25%']);
  await expect(page.getByText('No source data yet')).toHaveCount(0);

  const source = table.getByRole('button', { name: 'utm:google/cpc' });
  await expect(source).toHaveAttribute('aria-expanded', 'false');
  await source.focus();
  await page.keyboard.press('Enter');
  await expect(source).toHaveAttribute('aria-expanded', 'true');
  await expect(cellsOf('fall_promo')).toHaveText(['1', '1', '0', '0%']);
  await expect(cellsOf('(no campaign)')).toHaveText(['2', '2', '1', '50%']);
  await page.keyboard.press('Enter');
  await expect(source).toHaveAttribute('aria-expanded', 'false');
  await expect(row('fall_promo')).toHaveCount(0);

  await leadType.selectOption({ label: 'Mobility' });
  await expect(cellsOf('utm:google/cpc')).toHaveText(['1', '1', '0', '0%']);
  await expect(cellsOf('Total')).toHaveText(['1', '1', '0', '0%']);
  expect(errors).toEqual([]);
});

test('a card moved on the board stays moved', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/leads?type=internet&layout=board');
  // The board paints its columns from the first page of leads; a cold CI runner
  // can take a few seconds before the New column exists.
  await expect(page.getByRole('region', { name: 'New, 2 leads' })).toBeVisible({ timeout: 15_000 });

  await page
    .getByRole('link', { name: 'Avery Example' })
    .dragTo(page.getByRole('region', { name: /^Qualified, \d+ leads$/ }));
  await expect(
    page.getByRole('region', { name: 'Qualified, 1 leads' }).getByRole('link', {
      name: 'Avery Example',
    }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'New, 1 leads' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('region', { name: 'Qualified, 1 leads' })).toContainText(
    'Avery Example',
  );
  expect(errors).toEqual([]);
});

test('a lead is assigned, noted and given a task, which then shows in My tasks', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/leads?type=internet');
  // The name opens the side panel; this journey works the lead on its own page.
  await page.getByRole('link', { name: 'Avery Example' }).click();
  await page.getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Avery Example' })).toBeVisible();
  await expect(page.getByText('12 Example Street')).toBeVisible();
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(timeline).toContainText('moved this from New to Qualified');

  await page.getByLabel('Assignee').selectOption({ label: 'Sam' });
  await expect(timeline).toContainText('assigned this to Sam');

  await page.getByLabel('Add a note').fill('Called, wants the install next week.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(timeline.getByText('Called, wants the install next week.')).toBeVisible();

  await page.getByRole('textbox', { name: 'New task' }).fill('Book the installer');
  await page.getByLabel('Due date').fill('2026-11-02');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByRole('region', { name: /Tasks/ })).toContainText('Book the installer');

  await page.getByRole('link', { name: 'My tasks' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();
  await expect(page.getByText('Confirm the install window')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Complete “Book the installer”' }).check();
  await expect(page.getByRole('checkbox', { name: 'Reopen “Book the installer”' })).toBeChecked();

  // The lead's own task list agrees after a fresh load.
  await page.goto('/w/canadawide/leads?type=internet');
  await page.getByRole('link', { name: 'Avery Example' }).click();
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show 1 closed task' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the Tasks board moves tasks by status and by date, and remembers the layout', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/tasks');
  await expect(page.getByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const byStatus = page.getByRole('region', { name: 'Tasks board by status' });
  await expect(byStatus).toBeVisible();
  const statusColumn = (name: string) =>
    byStatus.getByRole('region', { name: new RegExp(`^${name},`) });
  // The seeded overdue follow-up waits in To do, under Overdue; the task the
  // last journey completed is in Done.
  await expect(statusColumn('To do')).toContainText('Confirm the install window');
  await expect(statusColumn('Done')).toContainText('Book the installer');

  // The menu: the keyboard and touch path.
  await page.getByRole('button', { name: 'Move “Confirm the install window”' }).click();
  await page.getByRole('menuitem', { name: 'In progress' }).click();
  await expect(statusColumn('In progress')).toContainText('Confirm the install window');

  // The layout and the move both survive a reload.
  await page.reload();
  await expect(statusColumn('In progress')).toContainText('Confirm the install window');

  await page.getByRole('button', { name: 'Date', exact: true }).click();
  const byDate = page.getByRole('region', { name: 'Tasks board by date' });
  const dateColumn = (name: string) =>
    byDate.getByRole('region', { name: new RegExp(`^${name},`) });
  await expect(dateColumn('Overdue')).toContainText('Confirm the install window');
  await expect(dateColumn('Overdue')).toContainText('In progress');

  // A drag from Done to No due date reopens the task with no due date; back to Done closes it.
  await byDate.getByText('Book the installer', { exact: true }).dragTo(dateColumn('No due date'));
  await expect(dateColumn('No due date')).toContainText('Book the installer');
  await expect(dateColumn('No due date')).toContainText('To do');
  await byDate.getByText('Book the installer', { exact: true }).dragTo(dateColumn('Done'));
  await expect(dateColumn('Done')).toContainText('Book the installer');

  // Put the follow-up back as the seed had it for the journeys after this one.
  await page.getByRole('button', { name: 'Move “Confirm the install window”' }).click();
  await page.getByRole('menuitem', { name: 'To do' }).click();
  await expect(dateColumn('Overdue')).not.toContainText('In progress');
  await page.reload();
  await expect(byDate).toBeVisible();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByText('Confirm the install window')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the archive hides a lead and restores it', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/leads?type=internet');
  await page.getByRole('link', { name: 'Blake Sample' }).click();
  await page.getByRole('link', { name: 'Open full page' }).click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText(/This lead is archived/)).toBeVisible();
  await expect(page.getByLabel('Stage')).toHaveCount(0);

  await page.goto('/w/canadawide/leads');
  await expect(page.getByRole('tab', { name: /All leads\s*4/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Blake Sample' })).toHaveCount(0);
  await page.getByRole('tab', { name: /Archive\s*1/ }).click();
  await page.getByRole('link', { name: 'Blake Sample' }).click();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByLabel('Stage')).toBeVisible();

  await page.goto('/w/canadawide/leads');
  await expect(page.getByRole('tab', { name: /All leads\s*5/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('SIM orders filter by permit type, sort by arrival ascending, add the Arrival in Canada column, and survive a reload', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/w/getcanadasim/leads?type=sim_order');
  await expect(page.getByRole('link', { name: 'Priya Sharma' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Arjun Patel' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Marco Rossi' })).toBeVisible();

  await openInboxMenu(page, 'Filters');
  await page.getByLabel('Property').selectOption('permitType');
  await page.getByLabel('Operator').selectOption('eq');
  await page.getByLabel('Value').selectOption('student');
  await page.getByRole('button', { name: 'Apply filter' }).click();

  await expect(page.getByText('is Study permit')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove filter Visa / permit type' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Marco Rossi' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Arjun Patel' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Priya Sharma' })).toBeVisible();

  await openInboxMenu(page, 'View options');
  // The box mirrors the URL, which router.replace updates a moment after the
  // click, so check() (which reads the box straight after clicking) cannot be used.
  const arrivalColumn = page.getByRole('checkbox', { name: 'Arrival in Canada' });
  await arrivalColumn.click();
  await expect(page).toHaveURL(/cols=arrivalDate/);
  await expect(arrivalColumn).toBeChecked();

  await page.getByRole('button', { name: /Arrival in Canada/ }).click();
  await expect(page).toHaveURL(/sort=prop\.arrivalDate%3Aasc/);
  await expect(page.getByRole('columnheader', { name: /Arrival in Canada/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  const rowsBeforeReload = page.locator('tbody tr');
  await expect(rowsBeforeReload.nth(0)).toContainText('Arjun Patel');
  await expect(rowsBeforeReload.nth(1)).toContainText('Priya Sharma');

  await page.reload();
  await expect(page.getByText('is Study permit')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remove filter Visa / permit type' }),
  ).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Arrival in Canada/ })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expect(page.getByRole('link', { name: 'Marco Rossi' })).toHaveCount(0);
  const rowsAfterReload = page.locator('tbody tr');
  await expect(rowsAfterReload.nth(0)).toContainText('Arjun Patel');
  await expect(rowsAfterReload.nth(1)).toContainText('Priya Sharma');
  expect(errors).toEqual([]);
});

test('ticked SIM orders are exported to Excel with the chosen fields, and the choice is remembered', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/w/getcanadasim/leads?type=sim_order');
  await expect(page.getByRole('link', { name: 'Priya Sharma' })).toBeVisible();

  // One row by the mouse, one from the keyboard; neither opens the lead.
  await page.getByRole('checkbox', { name: 'Select Priya Sharma' }).click();
  const arjun = page.getByRole('checkbox', { name: 'Select Arjun Patel' });
  await arjun.focus();
  await page.keyboard.press('Space');
  await expect(arjun).toBeChecked();
  await expect(page).not.toHaveURL(/lead=/);
  const bar = page.getByRole('status', { name: 'Selected leads' });
  await expect(bar).toContainText('2 selected');

  await bar.getByRole('button', { name: 'Export selected' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export leads to Excel' });
  await expect(dialog.getByRole('radio', { name: 'Selected leads (2)' })).toBeChecked();
  await expect(
    dialog.getByRole('radio', { name: /All leads matching the current filters \(\d+\)/ }),
  ).toBeVisible();
  // The main fields are always in; a field of the form is added.
  await expect(dialog.getByText('Always included')).toBeVisible();
  const permit = dialog.getByRole('checkbox', { name: 'Visa / permit type' });
  await expect(permit).not.toBeChecked();
  await permit.click();
  await expect(permit).toBeChecked();

  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    /^getcanadasim-leads-sim-order-\d{4}-\d{2}-\d{2}\.xlsx$/,
  );
  // A real workbook: an .xlsx is a zip, which starts `PK`.
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const file = Buffer.concat(chunks);
  expect(file.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(file.byteLength).toBeGreaterThan(1000);

  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^Exported 2 leads to getcanadasim-leads-sim-order-/)).toBeVisible();
  // The ticks are still there, and the next export starts from the last choice.
  await expect(bar).toContainText('2 selected');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Visa / permit type' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // Clearing the ticks leaves the list as it was.
  await bar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(bar).toHaveCount(0);
  await expect(arjun).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('a custom property is set in the side panel, filtered on, saved as a view, and a hidden built-in leaves the columns', async ({
  page,
}) => {
  const errors = trackErrors(page);

  // Settings → Properties: the owner adds a text property for every lead type.
  await page.goto('/w/canadawide/settings');
  await page.getByRole('link', { name: 'Properties and record layouts' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Properties' })).toBeVisible();
  await page.getByRole('button', { name: 'Add property' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add property' });
  await addDialog.getByLabel('Label').fill('Referral code');
  await expect(addDialog.getByLabel('Kind')).toHaveValue('text');
  await addDialog.getByRole('button', { name: 'Save property' }).click();
  await expect(addDialog).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Custom properties' })).toContainText(
    'Referral code',
  );
  await expect(page.getByRole('list', { name: 'Custom properties' })).toContainText(
    'Text · All lead types',
  );

  // The inbox opens an internet lead in the side panel; the value is set there.
  await page.goto('/w/canadawide/leads?type=internet');
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.getByRole('link', { name: 'Drew Testcase' }).click();
  await expect(page).toHaveURL(/lead=/);
  const panel = page.getByRole('complementary', { name: 'Lead' });
  await expect(panel.getByRole('heading', { name: 'Drew Testcase' })).toBeVisible();
  // Opening the panel leaves the page where it was: the header and the tabs stay in view.
  await expect(panel).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeInViewport();
  await expect(page.getByRole('tablist', { name: 'Lead types' })).toBeInViewport();
  const custom = panel.getByRole('region', { name: 'Custom' });
  await custom.getByRole('button', { name: 'Edit' }).click();
  await custom.getByLabel('Referral code').fill('R-100');
  await custom.getByRole('button', { name: 'Save' }).click();
  await expect(custom.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(custom).toContainText('R-100');
  await panel.getByRole('button', { name: 'Close panel' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/lead=/);

  // City is still offered as a column before it is hidden.
  await openInboxMenu(page, 'View options');
  await expect(page.getByRole('checkbox', { name: 'City', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Referral code', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Filter on the custom property: one row.
  await openInboxMenu(page, 'Filters');
  await page.getByLabel('Property').selectOption({ label: 'Referral code' });
  await page.getByLabel('Operator').selectOption('contains');
  await page.getByLabel('Value').fill('R-1');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByText('contains R-1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove filter Referral code' })).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Drew Testcase');

  // A sortable header says how the list is sorted.
  const leadHeader = page.getByRole('columnheader', { name: 'Lead', exact: true });
  await leadHeader.getByRole('button').click();
  await expect(page).toHaveURL(/sort=fullName%3Aasc/);
  await expect(leadHeader).toHaveAttribute('aria-sort', 'ascending');

  // Save as new view, then reload: the view is selected with its chip and row.
  await openInboxMenu(page, 'Saved views');
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const saveDialog = page.getByRole('dialog', { name: 'Save as new view' });
  await saveDialog.getByLabel('View name').fill('Referrals');
  await saveDialog.getByRole('button', { name: 'Save view' }).click();
  await expect(saveDialog).toHaveCount(0);
  await expect(page).toHaveURL(/view=/);
  await expect(page.getByRole('button', { name: 'Saved views' })).toHaveAttribute(
    'title',
    'Saved views: Referrals',
  );

  await page.reload();
  const switcher = page.getByRole('button', { name: 'Saved views', exact: true });
  await expect(switcher).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as new view' })).toHaveCount(0);
  await expect(page.getByText('contains R-1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove filter Referral code' })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Drew Testcase');
  await expect(leadHeader).toHaveAttribute('aria-sort', 'ascending');
  // The roomy rows: the email sits on its own line under the name.
  const nameBox = await rows.first().getByRole('link', { name: 'Drew Testcase' }).boundingBox();
  const emailBox = await rows.first().getByText('drew@example.test').boundingBox();
  expect(nameBox && emailBox && emailBox.y >= nameBox.y + nameBox.height - 1).toBe(true);
  const rowHeight = await rows.first().evaluate((row) => row.getBoundingClientRect().height);
  expect(rowHeight).toBeGreaterThan(36);
  await switcher.click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Referrals', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  // Settings → hide the built-in City: the inbox columns menu no longer offers it.
  await page.goto('/w/canadawide/settings/properties');
  const builtins = page.getByRole('list', { name: 'Built-in properties' });
  await builtins.getByRole('button', { name: 'Hide City' }).click();
  await expect(builtins.getByRole('button', { name: 'Show City' })).toBeVisible();
  await page.goto('/w/canadawide/leads?type=internet');
  await openInboxMenu(page, 'View options');
  await expect(page.getByRole('checkbox', { name: 'Referral code', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'City', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Clean up: the view, the value, the property and City's visibility as they were.
  // Off a saved view the switcher reads "All leads", with the unsaved-changes dot.
  await openInboxMenu(page, 'Saved views');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete Referrals' }).click();
  await page
    .getByRole('dialog', { name: 'Delete view' })
    .getByRole('button', { name: 'Delete view' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Delete view' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Drew Testcase' }).click();
  const cleanup = panel.getByRole('region', { name: 'Custom' });
  await cleanup.getByRole('button', { name: 'Edit' }).click();
  await cleanup.getByLabel('Referral code').fill('');
  await cleanup.getByRole('button', { name: 'Save' }).click();
  await expect(cleanup.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(cleanup).not.toContainText('R-100');
  await panel.getByRole('button', { name: 'Close panel' }).click();

  await page.goto('/w/canadawide/settings/properties');
  await builtins.getByRole('button', { name: 'Show City' }).click();
  await expect(builtins.getByRole('button', { name: 'Hide City' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Referral code' }).click();
  await page.getByRole('button', { name: 'Delete property' }).click();
  await expect(page.getByText('No custom properties yet.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a plan is added, an order is marked paid, filtered on, archived and restored, and its stage moves are the order’s', async ({
  page,
}) => {
  const errors = trackErrors(page);
  // Where a pending order is, and the moves it allows from there.
  const simStages = ['Pending', 'Verified', 'On hold', 'Cancelled'];

  // Settings → Plans: the owner adds a SIM order plan beside the two seeded ones.
  await page.goto('/w/getcanadasim/settings');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Plans', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Plans' })).toBeVisible();
  const simPlans = page.getByRole('list', { name: 'SIM order plans' });
  await expect(simPlans).toContainText('Rogers 60GB');
  await expect(simPlans).toContainText('Fido 75GB');
  await page.getByRole('button', { name: 'Add SIM order plan' }).click();
  const addPlan = page.getByRole('dialog', { name: 'Add plan' });
  await addPlan.getByLabel('Name').fill('Chatr 25GB');
  await addPlan.getByLabel('Price (CAD)').fill('35');
  await expect(addPlan.getByLabel('Billing period')).toHaveValue('month');
  await addPlan.getByRole('checkbox', { name: 'Payment required' }).click();
  await expect(addPlan.getByRole('checkbox', { name: 'Payment required' })).toBeChecked();
  await addPlan.getByRole('button', { name: 'Save plan' }).click();
  await expect(addPlan).toHaveCount(0);
  const chatr = simPlans.getByRole('listitem').filter({ hasText: 'Chatr 25GB' });
  await expect(chatr).toContainText('$35.00 · Monthly · Payment required');
  await expect(page.getByRole('switch', { name: 'Active Chatr 25GB' })).toBeChecked();

  // The inbox opens the seeded order in the side panel: its plan as frozen, payment pending.
  await page.goto('/w/getcanadasim/leads?type=sim_order');
  await page.getByRole('link', { name: 'Nadia Khan' }).click();
  await expect(page).toHaveURL(/lead=/);
  const panel = page.getByRole('complementary', { name: 'Lead' });
  await expect(panel.getByRole('heading', { name: 'Nadia Khan' })).toBeVisible();
  const order = panel.getByRole('region', { name: 'Order' });
  const orderValue = (label: string) => order.locator(`dt:text-is("${label}") + dd`);
  await expect(orderValue('Plan')).toContainText('Rogers 60GB');
  await expect(order.getByText(/^Frozen /)).toHaveText(
    /^Frozen [A-Z][a-z]{2} \d{1,2}, \d{4}: Rogers 60GB, \$40\.00 \/ Monthly$/,
  );
  await expect(orderValue('Quantity')).toHaveText('1');
  await expect(orderValue('Payment status')).toHaveText('Pending');

  // Marked paid in the Order section; the new plan is on offer there too.
  await order.getByRole('button', { name: 'Edit' }).click();
  await expect(order.getByLabel('Plan')).toContainText('Chatr 25GB');
  await order.getByLabel('Payment status').selectOption({ label: 'Paid' });
  await order.getByRole('button', { name: 'Save' }).click();
  await expect(order.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(orderValue('Payment status')).toHaveText('Paid');
  await expect(order.getByText(/^Frozen /)).toContainText('Rogers 60GB, $40.00 / Monthly');
  await panel.getByRole('button', { name: 'Close panel' }).click();
  await expect(panel).toHaveCount(0);

  // Filter on Payment status = Paid: the one order.
  await openInboxMenu(page, 'Filters');
  await page.getByLabel('Property').selectOption('paymentStatus');
  await page.getByLabel('Operator').selectOption('eq');
  await page.getByLabel('Value').selectOption({ label: 'Paid' });
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByText('is Paid')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove filter Payment status' })).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Nadia Khan');

  // Archived from the side panel, it leaves the list for the Archive tab.
  await page.getByRole('link', { name: 'Nadia Khan' }).click();
  await panel.getByRole('button', { name: 'Archive' }).click();
  await expect(panel.getByText(/This lead is archived \(since /)).toBeVisible();
  await expect(panel.getByLabel('Stage')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.getByRole('link', { name: 'Nadia Khan' })).toHaveCount(0);

  await page.getByRole('tab', { name: /Archive\s*1/ }).click();
  await expect(page).toHaveURL(/archived=1/);
  await page.getByRole('link', { name: 'Nadia Khan' }).click();
  await expect(panel.getByText(/This lead is archived \(since /)).toBeVisible();
  await panel.getByRole('button', { name: 'Restore' }).click();
  await expect(panel.getByText(/This lead is archived/)).toHaveCount(0);

  // Restored, its stage select offers the moves from Pending, no payment stages.
  const stage = panel.getByLabel('Stage');
  await expect(stage).toBeVisible();
  await expect(stage).toHaveValue('pending');
  await expect(stage.locator('option')).toHaveText(simStages);
  await expect(stage.locator('option', { hasText: /Paid|Invoiced/ })).toHaveCount(0);

  // Clean up: payment back to pending, the new plan no longer sold (plans are never deleted).
  await order.getByRole('button', { name: 'Edit' }).click();
  await order.getByLabel('Payment status').selectOption({ label: 'Pending' });
  await order.getByRole('button', { name: 'Save' }).click();
  await expect(orderValue('Payment status')).toHaveText('Pending');
  await panel.getByRole('button', { name: 'Close panel' }).click();

  await page.goto('/w/getcanadasim/settings/plans');
  const chatrActive = page.getByRole('switch', { name: 'Active Chatr 25GB' });
  await chatrActive.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
  await expect(chatrActive).not.toBeChecked();
  await expect(simPlans.getByRole('listitem').filter({ hasText: 'Chatr 25GB' })).toContainText(
    'Inactive',
  );
  expect(errors).toEqual([]);
});

test('a SIM order is approved, dispatched and activated by automations, and a template is edited and previewed', async ({
  page,
}) => {
  const errors = trackErrors(page);
  const dispatchedRule = 'When a SIM order moves to Delivered → send the Dispatched email';
  const activatedRule = 'When a SIM order moves to Activated → send the Activated email';
  const flows = page.getByRole('table', { name: 'Automation flows' });
  const ruleRow = (label: string) =>
    flows.getByRole('row').filter({ has: page.getByRole('switch', { name: label, exact: true }) });

  // Automations: the six built-in flows and the custom one, every one off
  // until the owner switches it on.
  await page.goto('/w/getcanadasim/automations');
  const switches = flows.getByRole('switch');
  await expect(switches).toHaveCount(7);
  await expect(flows.getByText('Built in', { exact: true })).toHaveCount(6);
  await expect(page.getByRole('switch', { name: 'Verified follow-up', exact: true })).toBeVisible();
  for (const toggle of await switches.all()) {
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  }
  for (const rule of [dispatchedRule, activatedRule]) {
    const toggle = page.getByRole('switch', { name: rule, exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
  }
  // Saved, not only shown: they are still on after a reload.
  await page.reload();
  for (const rule of [dispatchedRule, activatedRule]) {
    await expect(page.getByRole('switch', { name: rule, exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  }

  // Nadia Khan's order, on its own page: from Pending, Delivered is not a move.
  await page.goto('/w/getcanadasim/leads?type=sim_order');
  await page.getByRole('link', { name: 'Nadia Khan' }).click();
  await page.getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nadia Khan' })).toBeVisible();
  const stage = page.getByLabel('Stage');
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(stage).toHaveValue('pending');
  await expect(stage.locator('option', { hasText: 'Delivered' })).toHaveCount(0);
  await stage.selectOption({ label: 'Verified' });
  await expect(timeline).toContainText('moved this from Pending to Verified');
  await expect(stage).toHaveValue('verified');

  // Delivered asks for the dispatch details, then for the approved passport.
  const moveToDelivered = async () => {
    await stage.selectOption({ label: 'Delivered' });
    const dialog = page.getByRole('dialog', { name: 'Move to Delivered' });
    await dialog.getByLabel('Courier').fill('Canada Post');
    await dialog.getByLabel('Tracking number').fill('LX123456789CA');
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    return dialog;
  };
  const refused = await moveToDelivered();
  await expect(refused.getByRole('status')).toHaveText(/^Missing approved documents: Passport/);
  // The owner may move it on anyway, with a reason; not this time.
  await expect(refused.getByLabel('Reason for moving anyway')).toBeVisible();
  await refused.getByRole('button', { name: 'Cancel' }).click();
  await expect(refused).toHaveCount(0);
  await expect(stage).toHaveValue('verified');

  const passport = page
    .getByRole('list', { name: 'Documents' })
    .getByRole('listitem')
    .filter({ hasText: 'Passport' });
  await expect(passport.getByText('Not reviewed', { exact: true })).toBeVisible();
  await passport.getByRole('button', { name: 'Approve Passport' }).click();
  await expect(passport.getByText('Approved', { exact: true })).toBeVisible();

  const delivered = await moveToDelivered();
  await expect(delivered).toHaveCount(0);
  await expect(stage).toHaveValue('delivered');
  const order = page.getByRole('region', { name: 'Order' });
  await expect(order.locator('dt:text-is("Courier") + dd')).toHaveText('Canada Post');
  await expect(timeline).toContainText('Dispatched email queued by an automation (version 1)');

  // Activated is dated today in Toronto unless staff say otherwise (the
  // browser and CI may run in UTC, which is a different day late at night).
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  await stage.selectOption({ label: 'Activated' });
  const activate = page.getByRole('dialog', { name: 'Move to Activated' });
  await expect(activate.getByLabel('Activated on')).toHaveValue(today);
  await activate.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(activate).toHaveCount(0);
  await expect(stage).toHaveValue('activated');
  await expect(timeline).toContainText('Activated email queued by an automation');

  // Automations: each flow ran once; the Dispatched flow's page shows Nadia Khan's run.
  await page.goto('/w/getcanadasim/automations');
  for (const rule of [dispatchedRule, activatedRule]) {
    // Name, When, On, Last run, Runs, Status.
    await expect(ruleRow(rule).getByRole('cell').nth(4)).toHaveText('1');
  }
  await ruleRow(dispatchedRule).getByRole('link', { name: dispatchedRule, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: dispatchedRule })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'What it does' })
      .getByText('Send the Dispatched email', { exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: /^Runs/ }).click();
  const runs = page.getByRole('list', { name: 'Recent runs' }).getByRole('listitem');
  await expect(runs).toHaveCount(1);
  await expect(runs.first().getByRole('link', { name: 'Nadia Khan' })).toBeVisible();
  await expect(runs.first()).toContainText('Completed');

  // Settings → Email: the Dispatched email is edited, previewed and saved as version 2.
  await page.goto('/w/getcanadasim/settings');
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Email', exact: true })
    .click();
  const dispatchedEmail = page
    .getByRole('list', { name: 'Emails' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Dispatched', exact: true }) });
  await expect(dispatchedEmail).toContainText('Version 1');
  await dispatchedEmail.getByRole('button', { name: 'Edit Dispatched' }).click();
  const editor = page.getByRole('dialog', { name: 'Dispatched' });
  await editor.getByLabel('Subject').fill('Your order is on its way, {first name}');
  await expect(editor.locator('[data-preview-subject]')).toHaveText(
    'Your order is on its way, Nadia',
  );
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByText('Saved.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(dispatchedEmail).toContainText('Version 2');
  // The browser logs the one refused move (documents_incomplete), and nothing else.
  expect(errors).toEqual([
    'Failed to load resource: the server responded with a status of 409 (Conflict)',
  ]);
});

test('a customer’s change request is approved on the lead page', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/getcanadasim/leads?type=sim_order');
  await page.getByRole('link', { name: 'Nadia Khan' }).click();
  await page.getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nadia Khan' })).toBeVisible();

  // The card says what each field is now and what the customer asked for.
  const card = page.getByRole('region', { name: 'Change request #1' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('The customer asked for these changes');
  const row = (field: string) =>
    card.getByRole('row').filter({ has: page.getByRole('rowheader', { name: field }) });
  await expect(row('Phone').getByRole('cell')).toHaveText(['647 555 0204', '647 555 0299']);
  await expect(row('Arrival in Canada').getByRole('cell')).toHaveText([
    'Nov 20, 2026',
    'Nov 27, 2026',
  ]);

  await card.getByRole('button', { name: 'Approve changes' }).click();
  const outcome = card.getByRole('status');
  await expect(outcome).toHaveText('Approved.');
  // The pressed button is gone; the focus is on what happened.
  await expect(outcome).toBeFocused();
  await expect(card.getByRole('button', { name: 'Approve changes' })).toHaveCount(0);

  // The contact shows the new phone, and the timeline the decision.
  await expect(page.locator('dt:text-is("Phone") + dd')).toHaveText('647 555 0299');
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(timeline).toContainText("approved the customer's change request #1");
  await expect(timeline).toContainText(
    'The customer asked to change the phone and arrival in Canada (request #1)',
  );
  // Submitted on the website, the order was Pending at once.
  await expect(timeline).toContainText('Submitted on the website and moved to Pending');

  // Read again, the order has no pending request and keeps the new values.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Nadia Khan' })).toBeVisible();
  await expect(page.locator('dt:text-is("Phone") + dd')).toHaveText('647 555 0299');
  await expect(page.getByRole('region', { name: 'Change request #1' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

const flowRow = (page: Page, name: string) =>
  page
    .getByRole('table', { name: 'Automation flows' })
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name, exact: true }) });

test('a custom flow with an if/else and a wait is read on its page, switched on and fires on a move', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/w/getcanadasim/automations');
  const row = flowRow(page, 'Verified follow-up');
  await expect(row).toContainText('A SIM order moves to Verified');
  await expect(row.getByText(/Needs attention|Not activated|Draft changes/)).toHaveCount(0);

  // Its page opens on the canvas and toggles to List view reading the flow top to bottom, the branches labelled Yes and No.
  await row.getByRole('link', { name: 'Verified follow-up', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Verified follow-up' })).toBeVisible();
  await expect(page.getByText('Active, version 1')).toBeVisible();
  const definition = page.getByRole('region', { name: 'What it does' });
  await expect(definition.getByRole('region', { name: 'Automation flow canvas' })).toBeVisible();
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(definition.getByRole('list', { name: 'Yes' })).toBeVisible();
  const text = (await definition.textContent()) ?? '';
  let at = 0;
  for (const words of [
    'When a SIM order moves to Verified',
    'If the plan is Rogers 60GB',
    'Yes',
    'Create the task "Call {first name} about {order number}" due in 1 day for the lead\'s owner',
    'No',
    'Wait 2 days',
    'Send the Activated email',
  ]) {
    const found = text.indexOf(words, at);
    expect(found, words).toBeGreaterThanOrEqual(0);
    at = found + words.length;
  }
  const flowPage = page.url();

  // Back on the list, switched on.
  await page.getByRole('link', { name: 'All automations' }).click();
  const toggle = flowRow(page, 'Verified follow-up').getByRole('switch', {
    name: 'Verified follow-up',
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // Leila Ahmadi's order (Rogers 60GB) moves from Pending to Verified: the yes branch.
  await page.goto('/w/getcanadasim/leads?type=sim_order');
  await page.getByRole('link', { name: 'Leila Ahmadi' }).click();
  await page.getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Leila Ahmadi' })).toBeVisible();
  const stage = page.getByLabel('Stage');
  await expect(stage).toHaveValue('pending');
  await stage.selectOption({ label: 'Verified' });
  await expect(page.getByRole('region', { name: 'Timeline' })).toContainText(
    'moved this from Pending to Verified',
  );
  await page.reload();
  await expect(page.getByRole('region', { name: /^Tasks/ })).toContainText(
    /Call Leila about MS-\d+/,
  );

  // The flow's page shows the run, completed, for Leila Ahmadi.
  await page.goto(flowPage);
  await page.getByRole('tab', { name: /^Runs/ }).click();
  const runs = page.getByRole('list', { name: 'Recent runs' }).getByRole('listitem');
  await expect(runs).toHaveCount(1);
  await expect(runs.first().getByRole('link', { name: 'Leila Ahmadi' })).toBeVisible();
  await expect(runs.first()).toContainText('Completed');
  expect(errors).toEqual([]);
});

test('a rescued checkout is submitted and gets the Order received email', async ({ page }) => {
  const errors = trackErrors(page);
  const orderReceived = 'When an order is submitted on the website → send the Order received email';
  await page.goto('/w/getcanadasim/automations');
  const toggle = flowRow(page, orderReceived).getByRole('switch', {
    name: orderReceived,
    exact: true,
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // Omar Haddad never finished his checkout; staff move it on to Pending.
  await page.goto('/w/getcanadasim/leads?type=sim_order');
  await page.getByRole('link', { name: 'Omar Haddad' }).click();
  await page.getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Omar Haddad' })).toBeVisible();
  const stage = page.getByLabel('Stage');
  await expect(stage).toHaveValue('incomplete');
  await stage.selectOption({ label: 'Pending' });
  await expect(stage).toHaveValue('pending');
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(timeline).toContainText('Order received email queued by an automation');
  await expect(timeline).toContainText('submitted this checkout for the customer');
  await expect(timeline).toContainText('moved this from Incomplete to Pending');

  // Submitted now: the order received flow ran once for it.
  await page.goto('/w/getcanadasim/automations');
  await expect(flowRow(page, orderReceived).getByRole('cell').nth(4)).toHaveText('1');
  expect(errors).toEqual([]);
});

test('a custom flow is built on the canvas with an if/else, activated, switched on and its run read step by step', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/w/getcanadasim/automations');
  await page.getByRole('button', { name: 'New flow' }).click();
  const createDialog = page.getByRole('dialog', { name: 'New flow' });
  await createDialog.getByLabel('Name').fill('Verified branch check');
  await createDialog.getByRole('button', { name: 'Create' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Verified branch check' }),
  ).toBeVisible();
  const canvas = page.getByRole('region', { name: 'Automation flow canvas' });
  await expect(canvas).toBeVisible();

  // Configure the trigger: when a SIM order enters Verified.
  await canvas.getByRole('button', { name: 'Trigger: Choose when this flow runs' }).click();
  const triggerPanel = page.getByRole('complementary', { name: 'Trigger' });
  await triggerPanel.getByLabel('When', { exact: true }).selectOption('stage_entered');
  await triggerPanel.getByLabel('Lead type', { exact: true }).selectOption('sim_order');
  await triggerPanel.getByLabel('Stage').selectOption('verified');

  // Add an If/else step on plan (Rogers 60GB).
  await canvas.getByRole('button', { name: 'Add first step' }).click();
  await page
    .getByRole('menu', { name: 'Add step' })
    .getByRole('menuitem', { name: 'If/else' })
    .click();
  const ifPanel = page.getByRole('complementary', { name: 'If/else' });
  await ifPanel.getByRole('button', { name: 'Add condition' }).click();
  await ifPanel.getByLabel('Condition 1 kind').selectOption('plan');
  await ifPanel.getByRole('checkbox', { name: 'Rogers 60GB' }).check();

  // The insertion menu must stay above the existing If/else card. Exercise
  // insertion before a card, then remove that temporary step through its panel.
  await canvas.getByRole('button', { name: 'Add first step' }).click();
  await page
    .getByRole('menu', { name: 'Add step' })
    .getByRole('menuitem', { name: 'Wait' })
    .click();
  await page
    .getByRole('complementary', { name: 'Wait' })
    .getByRole('button', { name: 'Remove step' })
    .click();

  // In the Yes branch, send the Information needed email.
  await canvas.getByRole('button', { name: 'Add step to Yes branch' }).click();
  await page
    .getByRole('menu', { name: 'Add step' })
    .getByRole('menuitem', { name: 'Send email' })
    .click();
  const emailPanel = page.getByRole('complementary', { name: 'Send email' });
  await emailPanel.getByLabel('Email template').selectOption('information_needed');

  // In the No branch, create a task for the lead's owner.
  await canvas.getByRole('button', { name: 'Add step to No branch' }).click();
  await page
    .getByRole('menu', { name: 'Add step' })
    .getByRole('menuitem', { name: 'Create task' })
    .click();
  const taskPanel = page.getByRole('complementary', { name: 'Create task' });
  await taskPanel.getByLabel('Task title').fill('Verify Fido SIM for {first name}');

  // Save draft, activate and switch on.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  const activateDialog = page.getByRole('dialog', { name: 'Activate Verified branch check?' });
  await activateDialog.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('Active, version 1')).toBeVisible();

  const toggle = page.getByRole('switch', { name: 'Verified branch check' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const flowUrl = page.url();

  // Omar Haddad (Fido 75GB plan, now on Pending) moves to Verified: the No branch runs.
  await page.goto('/w/getcanadasim/leads?type=sim_order');
  await page.getByRole('link', { name: 'Omar Haddad' }).click();
  await page.getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Omar Haddad' })).toBeVisible();
  const stage = page.getByLabel('Stage');
  await expect(stage).toHaveValue('pending');
  await stage.selectOption({ label: 'Verified' });
  await expect(page.getByRole('region', { name: 'Timeline' })).toContainText(
    'moved this from Pending to Verified',
  );
  await page.reload();
  await expect(page.getByRole('region', { name: /^Tasks/ })).toContainText(
    'Verify Fido SIM for Omar',
  );

  // On the Runs tab, the run for Omar Haddad is completed and shows each step's outcome.
  await page.goto(flowUrl);
  await page.getByRole('tab', { name: /^Runs/ }).click();
  const runs = page.getByRole('list', { name: 'Recent runs' }).getByRole('listitem');
  await expect(runs).toHaveCount(1);
  await expect(runs.first().getByRole('link', { name: 'Omar Haddad' })).toBeVisible();
  await expect(runs.first()).toContainText('Completed');
  await runs.first().getByRole('button', { name: 'Steps for Omar Haddad' }).click();
  const stepOutcomes = runs.first().getByRole('list', { name: 'Step outcomes for Omar Haddad' });
  await expect(stepOutcomes).toContainText('Done (No branch)');
  await expect(stepOutcomes).toContainText('Done');
  expect(errors).toEqual([]);
});

test('the redesigned workspace supports page finding, persistent themes and narrow screens', async ({
  page,
}, testInfo) => {
  const errors = trackErrors(page);
  await page.goto('/w/getcanadasim/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.keyboard.press('Control+k');
  const finder = page.getByRole('dialog', { name: 'Search' });
  // A lead by name, from the real search, opens its page.
  await finder.getByRole('textbox', { name: 'Search leads and pages' }).fill('nadia');
  await finder.getByRole('link', { name: /Nadia Khan/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nadia Khan' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await finder.getByRole('textbox', { name: 'Search leads and pages' }).fill('settings');
  await finder.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Switch to light mode' }).click();

  const pages: { route: string; title: string }[] = [
    { route: 'dashboard', title: 'Dashboard' },
    { route: 'leads?type=sim_order', title: 'Leads' },
    { route: 'tasks', title: 'My tasks' },
    { route: 'settings', title: 'General settings' },
    { route: 'documents', title: 'Documents' },
  ];
  for (const { route, title } of pages) {
    await page.goto(`/w/getcanadasim/${route}`);
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    if (route === 'dashboard')
      await expect(page.getByRole('heading', { name: 'New orders', exact: true })).toBeVisible();
    if (route.startsWith('leads'))
      await expect(page.getByRole('link', { name: 'Omar Haddad', exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`design-${title.toLowerCase().replaceAll(' ', '-')}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/w/getcanadasim/dashboard');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Funnel by stage' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(391);
  await page.screenshot({
    path: testInfo.outputPath('design-mobile-dashboard.png'),
    fullPage: true,
  });
  await page.goto('/w/getcanadasim/settings');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(391);
  expect(errors).toEqual([]);
});

test('lead panel tabs preserve drafts and work on desktop and mobile', async ({
  page,
}, testInfo) => {
  const errors = trackErrors(page);
  async function checkScrolledTabs(surface: Locator) {
    const tabs = surface.getByRole('tablist', { name: 'Lead sections' });
    const scroller = surface.locator('[data-slot="tabs"]').locator('..');
    await scroller.evaluate((element) => {
      element.scrollTop = 300;
    });
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect
      .poll(async () => {
        const header = await surface
          .getByRole('button', { name: 'Close panel' })
          .locator('..')
          .boundingBox();
        const strip = await tabs.boundingBox();
        return header && strip ? Math.abs(strip.y - header.y - header.height) : Infinity;
      })
      .toBeLessThanOrEqual(1);
    return scroller;
  }
  /**
   * The design gives every native `<option>` an explicit colour pair so an OS
   * popup default can never mix a light menu with dark text, and a disabled
   * choice the muted token. A probe select measures that rule in the current
   * theme, rather than whichever selects happen to be on screen: the invariant
   * does not depend on an open panel, a theme switch settling, or a select the
   * site happens to render. A disabled choice is exempt from the 4.5:1 text
   * rule (WCAG), but it must still differ from its own background, which is how
   * a half-themed popup looks.
   */
  async function checkDropdownContrast(): Promise<void> {
    const colors = await page.evaluate(() => {
      const host = document.createElement('div');
      host.style.position = 'absolute';
      host.style.left = '-9999px';
      host.style.top = '0';
      const select = document.createElement('select');
      const enabled = new Option('Enabled', 'enabled');
      const disabled = new Option('Disabled', 'disabled');
      disabled.disabled = true;
      select.append(enabled, disabled);
      host.append(select);
      document.body.append(host);

      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('A canvas is needed to measure dropdown contrast');
      const rgba = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      const luminance = (color: number[]) =>
        color.slice(0, 3).reduce((sum, channel, index) => {
          const value = channel / 255;
          const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          return sum + linear * ([0.2126, 0.7152, 0.0722][index] ?? 0);
        }, 0);
      const measure = (option: HTMLOptionElement) => {
        const style = getComputedStyle(option);
        const background = rgba(style.backgroundColor);
        const foreground = rgba(style.color);
        const first = luminance(background);
        const second = luminance(foreground);
        return {
          alpha: background[3],
          ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
        };
      };
      const result = { enabled: measure(enabled), disabled: measure(disabled) };
      host.remove();
      return result;
    });
    expect(colors.enabled.alpha).toBe(255);
    expect(colors.disabled.alpha).toBe(255);
    expect(colors.enabled.ratio).toBeGreaterThanOrEqual(4.5);
    expect(colors.disabled.ratio).toBeGreaterThan(1);
  }
  await page.goto('/w/canadawide/leads?type=internet');
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved views', exact: true })).toBeVisible();
  for (const name of ['Filters', 'View options', 'Saved views']) {
    const dimensions = await page.getByRole('button', { name, exact: true }).evaluate((button) => ({
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
      radius: Number.parseFloat(getComputedStyle(button).borderRadius),
    }));
    expect(dimensions.width).toBe(dimensions.height);
    expect(dimensions.radius).toBeGreaterThanOrEqual(dimensions.width / 2);
  }
  await expect(page.getByLabel('Assignee', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await checkDropdownContrast();
  await page.screenshot({
    path: testInfo.outputPath('design-inbox-icon-toolbar.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await openInboxMenu(page, 'Filters');
  await page
    .getByRole('dialog', { name: 'Filters', exact: true })
    .screenshot({ path: testInfo.outputPath('design-inbox-filters.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await openInboxMenu(page, 'View options');
  const displayMenu = page.getByRole('dialog', { name: 'View options', exact: true });
  await displayMenu.screenshot({
    path: testInfo.outputPath('design-inbox-table-options.png'),
    animations: 'disabled',
  });
  await displayMenu.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(page).toHaveURL(/layout=board/);
  await expect(displayMenu.getByText('Board columns', { exact: true })).toBeVisible();
  await displayMenu.screenshot({
    path: testInfo.outputPath('design-inbox-board-options.png'),
    animations: 'disabled',
  });
  await displayMenu.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page).not.toHaveURL(/layout=board/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.getByRole('link', { name: 'Avery Example', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Lead', exact: true });
  await expect(panel.getByRole('tab', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(panel.getByRole('heading', { name: 'Contact', exact: true })).toBeVisible();
  const recordHeader = panel.locator('[data-slot="lead-record-header"]');
  await expect(recordHeader.getByText('Stage', { exact: true })).toBeVisible();
  await expect(recordHeader.getByText('Assignee', { exact: true })).toBeVisible();
  await expect(recordHeader.getByRole('button', { name: 'Copy info' })).toBeVisible();
  await expect(recordHeader.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
  await expect(recordHeader.getByRole('link', { name: 'Print delivery letter' })).toHaveCount(0);
  await checkDropdownContrast();
  await panel.getByRole('tab', { name: 'Notes', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Add a note' }).fill('Call about the installation date');
  await panel.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await panel.getByRole('textbox', { name: 'New task' }).fill('Confirm installation date');
  await panel.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'No files yet' })).toBeVisible();
  await panel.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'New task' })).toHaveValue(
    'Confirm installation date',
  );
  await panel.getByRole('textbox', { name: 'New task' }).fill('');
  await panel.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(panel.getByRole('textbox', { name: 'Add a note' })).toHaveValue(
    'Call about the installation date',
  );
  await panel.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Notes' })).toContainText(
    'Call about the installation date',
  );
  await panel.getByRole('tab', { name: 'Activity', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Timeline' })).toContainText(
    'Call about the installation date',
  );
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await checkDropdownContrast();
  await panel.screenshot({
    path: testInfo.outputPath('design-lead-panel-timeline.png'),
    animations: 'disabled',
  });
  const home = panel.getByRole('tab', { name: 'Home', exact: true });
  await home.focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'Tasks', exact: true })).toBeFocused();
  await expect(panel.getByRole('tab', { name: 'Tasks', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await panel.getByRole('heading', { name: 'Tasks', exact: true }).click();
  await panel
    .getByRole('region', { name: 'Tasks', exact: true })
    .locator('..')
    .locator('..')
    .screenshot({
      path: testInfo.outputPath('design-lead-tasks.png'),
      animations: 'disabled',
    });
  await home.click();
  await panel.screenshot({
    path: testInfo.outputPath('design-lead-panel-home.png'),
    animations: 'disabled',
  });
  const desktopScroll = await checkScrolledTabs(panel);
  await panel.screenshot({
    path: testInfo.outputPath('design-lead-panel-scrolled.png'),
    animations: 'disabled',
  });
  await desktopScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await panel.getByRole('tab', { name: 'Notes', exact: true }).click();
  await panel.screenshot({
    path: testInfo.outputPath('design-lead-panel-notes.png'),
    animations: 'disabled',
  });
  await panel.getByRole('button', { name: 'Close panel' }).click();
  await expect(page).not.toHaveURL(/lead=/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('link', { name: 'Avery Example', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Lead', exact: true });
  await expect(sheet.getByRole('tab', { name: 'Home', exact: true })).toBeVisible();
  const mobileScroll = await checkScrolledTabs(sheet);
  await mobileScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await sheet.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(sheet.getByRole('tab', { selected: true })).toHaveCount(1);
  await expect(sheet.getByRole('region', { name: 'Notes' })).toContainText(
    'Call about the installation date',
  );
  await sheet.screenshot({
    path: testInfo.outputPath('design-lead-panel-mobile.png'),
    animations: 'disabled',
  });
  await sheet.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await expect(sheet.getByRole('textbox', { name: 'New task' })).toBeVisible();
  const mobileTasks = sheet
    .getByRole('region', { name: 'Tasks', exact: true })
    .locator('..')
    .locator('..');
  await expect
    .poll(() => mobileTasks.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1);
  await mobileTasks.screenshot({
    path: testInfo.outputPath('design-lead-tasks-mobile.png'),
    animations: 'disabled',
  });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(391);
  await sheet.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search leads', exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(391);

  expect(errors).toEqual([]);
});
for (const layout of ['table', 'board']) {
  test(`the lead slider and table resize smoothly in both directions (${layout})`, async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(`/w/canadawide/leads?type=internet&layout=${layout}`);
    const list = page.locator('[data-slot="lead-list"]');
    await expect(page.getByRole('link', { name: 'Avery Example', exact: true })).toBeVisible();
    const initialWidth = await list.evaluate((element) => element.getBoundingClientRect().width);

    async function sampleResize(slot: Locator) {
      return slot.evaluate(async (element) => {
        const listElement = document.querySelector('[data-slot="lead-list"]');
        if (!listElement) throw new Error('The lead list is missing');
        const getMotion = () =>
          element.getAnimations({ subtree: true }).filter((animation) => {
            if (!(animation.effect instanceof KeyframeEffect)) return false;
            const target = animation.effect.target;
            return (
              animation.playState !== 'finished' &&
              (target === element ||
                (target instanceof Element && target.classList.contains('crm-lead-panel')))
            );
          });
        let motions = getMotion();
        for (let frame = 0; motions.length === 0 && frame < 20; frame += 1) {
          await new Promise(requestAnimationFrame);
          motions = getMotion();
        }
        if (motions.length === 0) throw new Error('The panel has no resize transition');
        for (const motion of motions) motion.pause();
        const durations = motions.map((motion) => Number(motion.effect?.getTiming().duration));
        const widths = [0, 0.5, 1].map((fraction) => {
          motions.forEach((motion, index) => {
            motion.currentTime = (durations[index] ?? 0) * fraction;
          });
          return listElement.getBoundingClientRect().width;
        });
        for (const motion of motions) motion.finish();
        return { durations, widths };
      });
    }

    const slot = page.locator('.crm-lead-panel-slot');
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await page.getByRole('link', { name: 'Avery Example', exact: true }).click();
      const opening = await sampleResize(slot);
      expect(opening.durations.length, `Opening ${cycle + 1} has transitions`).toBeGreaterThan(0);
      expect(opening.durations.every((duration) => duration >= 350)).toBe(true);
      expect(opening.widths[0], `Opening ${cycle + 1} narrows the table`).toBeGreaterThan(
        opening.widths[1] ?? 0,
      );
      expect(opening.widths[1]).toBeGreaterThan(opening.widths[2] ?? 0);
      expect(opening.widths[0]).toBeCloseTo(initialWidth, 0);
      await expect(page.getByRole('heading', { name: 'Avery Example', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close panel' }).click();
      const closing = await sampleResize(slot);
      expect(closing.durations.every((duration) => duration >= 300)).toBe(true);
      expect(closing.widths[0]).toBeLessThan(closing.widths[1] ?? Infinity);
      expect(closing.widths[1]).toBeLessThan(closing.widths[2] ?? Infinity);
      await expect(page).not.toHaveURL(/lead=/);
      await expect(slot).toHaveCount(0);
      expect(await list.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(
        initialWidth,
        0,
      );
    }

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('link', { name: 'Avery Example', exact: true }).click();
    await expect
      .poll(() => slot.evaluate((element) => getComputedStyle(element).transitionDuration))
      .toBe('0s');
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(page).not.toHaveURL(/lead=/);
    expect(errors).toEqual([]);
  });
}

test('board cards open the lead slider on desktop and mobile', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/leads?type=internet&layout=board');
  const name = page.getByRole('link', { name: 'Avery Example', exact: true });
  await expect(name).toBeVisible();
  await page.getByText('403 555 0101', { exact: true }).click();
  await expect(page).toHaveURL(/layout=board/);
  await expect(page).toHaveURL(/lead=/);
  const panel = page.getByRole('complementary', { name: 'Lead', exact: true });
  await expect(panel.getByRole('heading', { name: 'Avery Example', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /^New,/ })).toBeVisible();
  await expect(name).toHaveAttribute('data-lead-id');
  await panel.getByRole('button', { name: 'Close panel' }).click();
  await expect(page).not.toHaveURL(/lead=/);
  await expect(page).toHaveURL(/layout=board/);
  await expect(name).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await name.click();
  const sheet = page.getByRole('dialog', { name: 'Lead', exact: true });
  await expect(sheet.getByRole('heading', { name: 'Avery Example', exact: true })).toBeVisible();
  await expect(sheet.getByRole('tab', { name: 'Home', exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Close panel' }).click();
  await expect(page).not.toHaveURL(/lead=/);
  await expect(page).toHaveURL(/layout=board/);
  await expect(name).toBeVisible();
  expect(errors).toEqual([]);
});

test('board horizontal navigation stays at the bottom of the viewport', async ({ page }) => {
  const errors = trackErrors(page);
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto('/w/canadawide/leads?type=internet&layout=board');
  const board = page.getByRole('region', { name: 'internet board', exact: true });
  const controls = page.getByRole('group', { name: 'Board horizontal navigation' });
  const slider = page.getByRole('slider', { name: 'Scroll board horizontally' });
  const left = page.getByRole('button', { name: 'Scroll board left' });
  const right = page.getByRole('button', { name: 'Scroll board right' });
  await expect(controls).toBeVisible();
  await expect(left).toBeDisabled();
  await right.click();
  await expect.poll(() => board.evaluate((element) => element.scrollLeft)).toBeGreaterThan(200);
  await expect(left).toBeEnabled();
  await slider.focus();
  await slider.press('End');
  await expect(right).toBeDisabled();
  await slider.press('Home');
  await expect(left).toBeDisabled();

  // Simulate a column with many cards to exercise page scrolling independently
  // of the fixed horizontal controls.
  await page.addStyleTag({
    content: '[aria-label="internet board"] > section:first-child { min-height: 1600px; }',
  });
  const before = await controls.boundingBox();
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(400);
  const after = await controls.boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
  expect((after?.y ?? 0) + (after?.height ?? 0)).toBeCloseTo(684, 0);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('link', { name: 'Avery Example', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Lead', exact: true });
  await expect(panel.getByRole('heading', { name: 'Avery Example', exact: true })).toBeVisible();
  await expect
    .poll(async () => {
      const dock = await controls.boundingBox();
      const record = await panel.boundingBox();
      return (dock?.x ?? 0) + (dock?.width ?? Infinity) - (record?.x ?? 0);
    })
    .toBeLessThanOrEqual(0);
  await panel.getByRole('button', { name: 'Close panel' }).click();
  await expect(page).not.toHaveURL(/lead=/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(controls).toBeVisible();
  await expect
    .poll(async () => {
      const dock = await controls.boundingBox();
      return (dock?.x ?? 0) + (dock?.width ?? Infinity);
    })
    .toBeLessThanOrEqual(374);
  await expect(right).toBeEnabled();
  expect(errors).toEqual([]);
});

test('loading screens show layout skeletons until their data arrives', async ({
  page,
}, testInfo) => {
  const errors = trackErrors(page);
  async function holdRequests(pattern: RegExp, check: () => Promise<void>) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending: Promise<void>[] = [];
    await page.route(pattern, (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const resume = gate.then(() => route.continue());
      pending.push(resume);
      return resume;
    });
    try {
      await check();
    } finally {
      release();
      await Promise.all(pending);
      await page.unroute(pattern);
    }
  }
  async function checkSkeleton(label: string) {
    const status = page.getByRole('status', { name: label, exact: true });
    await expect(status).toBeVisible();
    await expect(status.locator('[data-slot="skeleton"]').first()).toBeVisible();
    await expect(status.getByRole('button')).toHaveCount(0);
    return status;
  }
  await holdRequests(/\/analytics(?:\?|$)/, async () => {
    await page.goto('/w/canadawide/dashboard');
    const status = await checkSkeleton('Loading the dashboard…');
    await expect(status.locator('[data-slot="skeleton"]').first()).toBeVisible();
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await page.screenshot({
      path: testInfo.outputPath('design-loading-dashboard.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(391);
    await page.screenshot({
      path: testInfo.outputPath('design-loading-dashboard-mobile.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await expect(
    page.getByRole('status', { name: 'Loading the dashboard…', exact: true }),
  ).toHaveCount(0);
  await holdRequests(/\/workspaces\/[^/]+\/leads(?:\?|$)/, async () => {
    await page.goto('/w/canadawide/leads?type=internet');
    await expect(page.getByRole('status', { name: 'Loading leads…', exact: true })).toBeAttached();
    const table = page.getByRole('table');
    await expect(table).toHaveAttribute('aria-busy', 'true');
    await expect(table.locator('tbody tr')).toHaveCount(7);
    expect(await table.locator('thead th').count()).toBe(
      await table.locator('tbody tr').first().locator('td').count(),
    );
    await expect(page.getByText(/Page 1 of 1 · 0 leads/)).not.toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('design-loading-leads.png'),
      animations: 'disabled',
    });
  });
  const name = page.getByRole('link', { name: 'Avery Example', exact: true });
  await expect(name).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await holdRequests(/\/leads\/[a-f0-9-]{36}(?:\?|$)/, async () => {
    await name.click();
    const status = await checkSkeleton('Loading the lead…');
    await expect
      .poll(() =>
        status
          .locator('[data-slot="skeleton"]')
          .first()
          .evaluate((element) => getComputedStyle(element).animationName),
      )
      .toBe('none');
    await page
      .getByRole('complementary', { name: 'Lead', exact: true })
      .screenshot({ path: testInfo.outputPath('design-loading-record.png') });
  });
  await expect(page.getByRole('heading', { name: 'Avery Example', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page).not.toHaveURL(/lead=/);
  await holdRequests(/\/leads\/board(?:\?|$)/, async () => {
    await page.goto('/w/canadawide/leads?type=internet&layout=board');
    await checkSkeleton('Loading the board…');
    await page.screenshot({ path: testInfo.outputPath('design-loading-board.png') });
  });
  await expect(name).toBeVisible();
  await holdRequests(/\/email\/settings(?:\?|$)/, async () => {
    await page.goto('/w/getcanadasim/settings/email');
    await checkSkeleton('Loading the email settings…');
    await page.screenshot({ path: testInfo.outputPath('design-loading-settings.png') });
  });
  await expect(
    page.getByRole('status', { name: 'Loading the email settings…', exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('settings separates profile, team invitations and website integrations', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/getcanadasim/settings');
  const navigation = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(page.getByRole('heading', { level: 1, name: 'General settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Invite a teammate', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Issue credential' })).toHaveCount(0);
  await navigation.getByRole('link', { name: 'Team', exact: true }).click();
  await expect(page).toHaveURL('/w/getcanadasim/settings/team');
  await expect(navigation.getByRole('link', { name: 'Team', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('list', { name: 'Team', exact: true })).toBeVisible();
  await expect(page.getByLabel('Staff email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create invitation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue credential' })).toHaveCount(0);
  await navigation.getByRole('link', { name: 'Integrations', exact: true }).click();
  await expect(page).toHaveURL('/w/getcanadasim/settings/integrations');
  await expect(navigation.getByRole('link', { name: 'Integrations', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('heading', { name: 'Website service credentials', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Issue credential' })).toBeVisible();
  await expect(page.getByLabel('Staff email')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Issue credential' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(391);
  await navigation.getByRole('link', { name: 'Team', exact: true }).click();
  await expect(page.getByLabel('Staff email')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(391);
  expect(errors).toEqual([]);
});
