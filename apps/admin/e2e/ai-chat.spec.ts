import { expect, test, type Page } from '@playwright/test';

/**
 * Ask AI as a saved chat, over the real backend harness with its synthetic
 * engine: a new chat on the full page, the answer, a reload that finds the
 * conversation in the list and reopens it with both messages, a rename and a
 * delete, at a phone's width and a desktop's. Each run asks a question of its
 * own and deletes what it made, so a retry or the other width never meets it.
 *
 * Attachments are not in this journey: the harness runs an in-memory object
 * store, which has no address a browser could PUT a file to.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The conversation list: inline on a desktop, a drawer on a phone. */
async function openList(page: Page, width: number) {
  if (width < 768) {
    await page.getByRole('button', { name: 'Show conversations' }).click();
    return page.getByRole('dialog', { name: 'Your conversations' });
  }
  return page.getByRole('complementary', { name: 'Your conversations' });
}

for (const width of [375, 1440]) {
  test(`a saved Ask AI chat is asked, reopened, renamed and deleted at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/w/canadawide/chat');
    await expect(page.getByRole('heading', { name: 'What would you like to know?' })).toBeVisible();
    // The page is Ask AI: the header's panel trigger stays away.
    await expect(page.getByRole('button', { name: 'Ask AI', exact: true })).toHaveCount(0);

    const question = `How many leads are there? (${width})`;
    const composer = page.getByRole('textbox', { name: 'Ask a question' });
    await composer.fill(question);
    await composer.press('Enter');
    const thread = page.getByRole('log', { name: 'Conversation' });
    await expect(
      thread.getByText(/Synthetic model: \d+ leads checked in this site\./),
    ).toBeVisible();
    await expect(thread.getByRole('region', { name: 'Answer table' })).toBeVisible();
    // The first message gave the new chat its address, in place.
    await expect(page).toHaveURL(new RegExp(`/w/canadawide/chat/${UUID}$`));
    const address = page.url();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(composer).toBeEnabled();

    await page.reload();
    await expect(thread.getByText(question, { exact: true })).toBeVisible();
    await expect(
      thread.getByText(/Synthetic model: \d+ leads checked in this site\./),
    ).toBeVisible();
    let list = await openList(page, width);
    const row = list.getByRole('link', { name: question, exact: true });
    await expect(row).toHaveAttribute('aria-current', 'page');

    const renamed = `Lead count check ${width}`;
    await list.getByRole('button', { name: `Options for ${question}` }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const title = list.getByRole('textbox', { name: 'Conversation title' });
    await expect(title).toBeFocused();
    await title.fill(renamed);
    await title.press('Enter');
    await expect(list.getByRole('link', { name: renamed, exact: true })).toBeVisible();
    if (width < 768) await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();

    await page.reload();
    list = await openList(page, width);
    await expect(list.getByRole('link', { name: renamed, exact: true })).toBeVisible();
    await expect(page).toHaveURL(address);

    await list.getByRole('button', { name: `Options for ${renamed}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this conversation?' });
    await expect(confirm).toContainText('removed for good');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole('link', { name: renamed, exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/w\/canadawide\/chat$/);
    await expect(page.getByRole('heading', { name: 'What would you like to know?' })).toBeVisible();

    // Gone for good: its old address is a calm "not available", not a crash.
    await page.goto(address);
    await expect(
      page.getByRole('heading', { name: 'This conversation is not available' }),
    ).toBeVisible();
  });
}

for (const width of [375, 1440]) {
  test(`a question asked at High effort shows Thinking, keeps its tag after a reload at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/w/canadawide/chat');
    await expect(page.getByRole('heading', { name: 'What would you like to know?' })).toBeVisible();

    // The harness offers High: the control sits beside Send, Normal chosen.
    const effort = page.getByRole('radiogroup', { name: 'Effort' });
    await expect(effort.getByRole('radio', { name: 'Normal' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await effort.getByRole('radio', { name: 'High' }).click();
    await expect(effort.getByRole('radio', { name: 'High' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    const question = `Think hard: which orders need me? (${width})`;
    const composer = page.getByRole('textbox', { name: 'Ask a question' });
    await composer.fill(question);
    await composer.press('Enter');
    const thread = page.getByRole('log', { name: 'Conversation' });
    // The synthetic engine reasons for 1.5 s before it answers.
    await expect(thread.getByText('Thinking…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(thread.getByText('High effort answer: 3 orders need you.')).toBeVisible();
    await expect(thread.getByText('High effort', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/w/canadawide/chat/${UUID}$`));

    // After a reload the stored level still tags the answer, and the choice is Normal again
    // (it lives in the tab's memory only).
    await page.reload();
    await expect(thread.getByText('High effort answer: 3 orders need you.')).toBeVisible();
    await expect(thread.getByText('High effort', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'Normal' }),
    ).toHaveAttribute('aria-checked', 'true');

    // Clean up what this run made.
    const list = await openList(page, width);
    await list.getByRole('button', { name: `Options for ${question}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page
      .getByRole('dialog', { name: 'Delete this conversation?' })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(page).toHaveURL(/\/w\/canadawide\/chat$/);
  });
}
