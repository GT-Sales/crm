import { expect, test, type Page } from '@playwright/test';

/**
 * Staff working leads in a real browser against the real backend (see
 * playwright.leads.config.ts). The harness seeds CanadaWide with four internet
 * leads (two new, one contacted with an overdue task, one won) and one
 * mobility lead, plus Get Canada Sim with three SIM orders, two plans
 * ("Rogers 60GB" $40 a month with payment required, "Fido 75GB" $35 a month
 * without) and a fourth SIM order, Nadia Khan's, submitted with Rogers 60GB
 * frozen on it, signed in as the owner "Takib" with a colleague "Sam". The journeys share those seeded sites
 * and run in order. A lead's name in the inbox opens it in the side panel
 * (`?lead=`); "Open full page" goes to its own page. One journey adds a
 * custom property, a saved view and a hidden built-in, and puts them back; the
 * one after it adds a plan, works an order and archives and restores it. The
 * last takes that order to Activated: Rogers 60GB requires a passport, Nadia
 * Khan's is attached and not reviewed, Get Canada Sim's email settings are
 * saved with its Dispatched email at version 1, and every automation is off.
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

test('the dashboard lists the follow-ups due, and Leads filters to them', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/dashboard');
  await expect(page.getByRole('heading', { level: 2, name: 'Follow-ups due' })).toBeVisible();
  // The site's busiest type over the last 7 days: CanadaWide's internet leads, by stage.
  await expect(page.getByRole('heading', { name: 'Received' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'By stage' })).toBeVisible();
  await page.getByRole('button', { name: 'All time' }).click();
  await expect(page.getByRole('button', { name: 'All time' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('img', { name: /received per day/ })).toBeVisible();
  const followUp = page.getByRole('link', { name: /Casey Demo/ });
  await expect(followUp).toContainText('Confirm the install window');
  await expect(followUp).toContainText(/Overdue by \d+ days/);

  await page.getByRole('link', { name: 'Open the follow-ups in Leads' }).click();
  await expect(page).toHaveURL(/\/leads\?due=1$/);
  const toggle = page.getByRole('button', { name: /Follow-ups due\s*1/ });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('link', { name: 'Casey Demo' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Avery Example' })).toHaveCount(0);

  await toggle.click();
  await expect(page.getByRole('link', { name: 'Avery Example' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('a card moved on the board stays moved', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/leads?type=internet&layout=board');
  await expect(page.getByRole('region', { name: 'New, 2 leads' })).toBeVisible();

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
  await expect(page.getByRole('button', { name: 'Show 1 closed task' })).toBeVisible();
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

  await page.getByRole('button', { name: 'Add filter' }).click();
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

  await page.getByRole('button', { name: 'Columns' }).click();
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
  await page.getByRole('button', { name: 'Columns' }).click();
  await expect(page.getByRole('checkbox', { name: 'City', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Referral code', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Filter on the custom property: one row.
  await page.getByRole('button', { name: 'Add filter' }).click();
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
  await page.getByRole('button', { name: 'Save as new view' }).click();
  const saveDialog = page.getByRole('dialog', { name: 'Save as new view' });
  await saveDialog.getByLabel('View name').fill('Referrals');
  await saveDialog.getByRole('button', { name: 'Save view' }).click();
  await expect(saveDialog).toHaveCount(0);
  await expect(page).toHaveURL(/view=/);
  await expect(page.getByRole('button', { name: 'Referrals', exact: true })).toBeVisible();

  await page.reload();
  const switcher = page.getByRole('button', { name: 'Referrals', exact: true });
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
  await page.getByRole('button', { name: 'Columns' }).click();
  await expect(page.getByRole('checkbox', { name: 'Referral code', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'City', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Clean up: the view, the value, the property and City's visibility as they were.
  // Off a saved view the switcher reads "All leads", with the unsaved-changes dot.
  await page.getByRole('button', { name: /^All leads/ }).click();
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
    .getByRole('navigation', { name: 'More settings' })
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
  await expect(page.getByRole('checkbox', { name: 'Active Chatr 25GB' })).toBeChecked();

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
  await page.getByRole('button', { name: 'Add filter' }).click();
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
  const chatrActive = page.getByRole('checkbox', { name: 'Active Chatr 25GB' });
  await chatrActive.click();
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
  const ruleRow = (label: string) =>
    page
      .getByRole('list', { name: 'Automations' })
      .getByRole('listitem')
      .filter({ has: page.getByRole('switch', { name: label, exact: true }) });

  // Automations: every rule is off until the owner switches it on.
  await page.goto('/w/getcanadasim/automations');
  const switches = page.getByRole('list', { name: 'Automations' }).getByRole('switch');
  await expect(switches).toHaveCount(6);
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

  // Automations: each rule queued one email; the Dispatched rule's run is Nadia Khan's.
  await page.goto('/w/getcanadasim/automations');
  for (const rule of [dispatchedRule, activatedRule]) {
    await expect(ruleRow(rule).locator('dt:text-is("Emails queued") + dd')).toHaveText('1');
  }
  await ruleRow(dispatchedRule).getByRole('button', { name: 'Recent runs' }).click();
  const runs = ruleRow(dispatchedRule)
    .getByRole('list', { name: 'Recent runs' })
    .getByRole('listitem');
  await expect(runs).toHaveCount(1);
  await expect(runs.first().getByRole('link', { name: 'Nadia Khan' })).toBeVisible();
  await expect(runs.first()).toContainText('Queued');

  // Settings → Email: the Dispatched email is edited, previewed and saved as version 2.
  await page.goto('/w/getcanadasim/settings');
  await page
    .getByRole('navigation', { name: 'More settings' })
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
