import { expect, test, type Page } from '@playwright/test';

/**
 * Staff working leads in a real browser against the real backend (see
 * playwright.leads.config.ts). The harness seeds CanadaWide with four internet
 * leads (two new, one contacted with an overdue task, one won) and one
 * mobility lead, plus Get Canada Sim with three SIM orders, signed in as the
 * owner "Takib" with a colleague "Sam". The journeys share those seeded sites
 * and run in order.
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
  await page.goto('/w/canadawide/leads?type=internet&view=board');
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
  await page.getByRole('link', { name: 'Avery Example' }).click();
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

test('the trash hides a lead and restores it', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/w/canadawide/leads?type=internet');
  await page.getByRole('link', { name: 'Blake Sample' }).click();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByText(/This lead is in the trash/)).toBeVisible();
  await expect(page.getByLabel('Stage')).toHaveCount(0);

  await page.goto('/w/canadawide/leads');
  await expect(page.getByRole('tab', { name: /All leads\s*4/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Blake Sample' })).toHaveCount(0);
  await page.getByRole('tab', { name: /Trash\s*1/ }).click();
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

  await expect(
    page.getByRole('button', { name: /Visa \/ permit type is Study permit/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Marco Rossi' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Arjun Patel' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Priya Sharma' })).toBeVisible();

  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('checkbox', { name: 'Arrival in Canada' }).check();
  await expect(page).toHaveURL(/cols=arrivalDate/);

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
  await expect(
    page.getByRole('button', { name: /Visa \/ permit type is Study permit/ }),
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
