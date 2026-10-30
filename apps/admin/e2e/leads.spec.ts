import { expect, test, type Page } from '@playwright/test';

/**
 * Staff working leads in a real browser against the real backend (see
 * playwright.leads.config.ts). The harness seeds CanadaWide with four internet
 * leads (two new, one contacted with an overdue task, one won) and one
 * mobility lead, plus Get Canada Sim with three SIM orders, signed in as the
 * owner "Takib" with a colleague "Sam". The journeys share those seeded sites
 * and run in order. A lead's name in the inbox opens it in the side panel
 * (`?lead=`); "Open full page" goes to its own page. The last journey adds a
 * custom property, a saved view and a hidden built-in, and puts them back.
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

  await page.getByRole('button', { name: 'Filter', exact: true }).click();
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
  await page.getByRole('link', { name: 'Drew Testcase' }).click();
  await expect(page).toHaveURL(/lead=/);
  const panel = page.getByRole('complementary', { name: 'Lead' });
  await expect(panel.getByRole('heading', { name: 'Drew Testcase' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
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
  // The table's 32 px rows (h-8), with a little room for borders.
  const rowHeight = await rows.first().evaluate((row) => row.getBoundingClientRect().height);
  expect(rowHeight).toBeLessThanOrEqual(36);
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
