import { expect, test } from '@playwright/test';
import { getWorkspaceLeadResponseSchema } from '@gt-sales/contracts';

for (const theme of ['light', 'dark']) {
  for (const width of [375, 1440]) {
    test(`Ask AI streams from the backend at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/w/canadawide/leads');
      await page.evaluate(
        (mode) => document.documentElement.classList.toggle('dark', mode === 'dark'),
        theme,
      );
      const trigger = page.getByRole('button', { name: 'Ask AI', exact: true });
      for (let count = 0; count < 3; count += 1) {
        await trigger.click();
        await expect(page.getByRole('textbox', { name: 'Ask a question' })).toBeFocused();
        await page.getByRole('button', { name: 'Close Ask AI' }).click();
        await expect(trigger).toBeFocused();
      }
      await trigger.click();
      await page.getByRole('textbox', { name: 'Ask a question' }).fill('Count all leads');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(
        page.getByText(/Synthetic model: \d+ leads checked in this site\./),
      ).toBeVisible();
      await expect(page.getByText('Sources checked')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Lead overview' })).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Answer table' }).getByRole('table'),
      ).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Count' })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Ask a question' })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: testInfo.outputPath(`formatted-reply-${width}-${theme}.png`) });
      await page.getByRole('textbox', { name: 'Ask a question' }).fill('Slow test');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await expect(page.getByText('Stopped.', { exact: true })).toBeVisible();
      await expect(page.getByText('Late test answer')).toHaveCount(0);
      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByText(/Synthetic model:/)).toHaveCount(0);
    });
  }
}

for (const width of [375, 1440]) {
  test(`closing Ask AI preserves the open lead and note draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/w/canadawide/leads');
    await page.getByRole('link', { name: 'Avery Example', exact: true }).click();
    await expect(page).toHaveURL(/lead=/);
    const leadUrl = page.url();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    const note = page.getByRole('textbox', { name: 'Add a note' });
    await note.fill('Unsaved AI review note');
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await expect(page.getByText('Asking about the open lead')).toBeVisible();
    await page.getByRole('button', { name: 'Remove lead context' }).click();
    await expect(page.getByText('Asking about the open lead')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Ask a question' }).press('Escape');
    await expect(page).toHaveURL(leadUrl);
    await expect(page.getByRole('button', { name: 'Close panel' })).toBeVisible();
    await expect(note).toHaveValue('Unsaved AI review note');
    await expect(note).toBeEditable();
  });
}

for (const width of [375, 1440]) {
  test(`AI notes and tasks require confirmation and survive a lost save response at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/w/canadawide/leads');
    await page.getByRole('link', { name: 'Avery Example', exact: true }).click();
    await expect(page).toHaveURL(/lead=/);
    const leadId = new URL(page.url()).searchParams.get('lead');
    if (!leadId) throw new Error('expected lead');
    const recordUrl = `http://127.0.0.1:4100/api/v1/staff/workspaces/10000000-0000-4000-8000-0000000e2e01/leads/${leadId}`;
    const record = async () => {
      const response = await page.request.get(recordUrl, {
        headers: {
          authorization: `Bearer ${process.env['E2E_STAFF_BEARER'] ?? 'e2e-staff-session-owner'}`,
        },
      });
      expect(response.status()).toBe(200);
      return getWorkspaceLeadResponseSchema.parse(await response.json());
    };
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const note = `AI confirmed callback ${width}`;
    await page.getByRole('textbox', { name: 'Ask a question' }).fill(`Add a note: ${note}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Confirm note' })).toBeVisible();
    expect(
      (await record()).activities.filter((a) => a.kind === 'note' && a.body === note),
    ).toHaveLength(0);
    let lost = false;
    await page.route('**/ai/actions/confirm', async (route) => {
      const response = await route.fetch();
      if (!lost) {
        lost = true;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(page.getByText('Note added.', { exact: true })).toBeVisible();
    expect(
      (await record()).activities.filter((a) => a.kind === 'note' && a.body === note),
    ).toHaveLength(1);
    await page.unroute('**/ai/actions/confirm');
    await page.getByRole('button', { name: 'Close Ask AI' }).click();
    await expect(
      page.getByRole('tabpanel', { name: 'Notes' }).getByText(note, { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await page.getByRole('button', { name: 'New chat' }).click();
    const title = `AI follow-up ${width}`;
    const prepareTask = async () => {
      await page.getByRole('textbox', { name: 'Ask a question' }).fill(`Create a task: ${title}`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Confirm task' })).toBeVisible();
    };
    await prepareTask();
    await expect(
      page.getByRole('region', { name: 'Confirm task' }).getByText('You', { exact: true }),
    ).toBeVisible();
    expect((await record()).tasks.filter((t) => t.title === title)).toHaveLength(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await record()).tasks.filter((t) => t.title === title)).toHaveLength(0);
    await page.getByRole('button', { name: 'New chat' }).click();
    await prepareTask();
    // The server saves successfully but its receipt is lost. Retry must use
    // the same signed task card, including through the real browser client.
    let taskReceiptLost = false;
    await page.route('**/ai/actions/confirm', async (route) => {
      const response = await route.fetch();
      if (!taskReceiptLost) {
        taskReceiptLost = true;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await page.getByRole('button', { name: 'Retry save' }).click();
    await expect(page.getByText('Task created.', { exact: true })).toBeVisible();
    await page.unroute('**/ai/actions/confirm');
    const saved = (await record()).tasks.filter((t) => t.title === title);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      assignedActorId: '20000000-0000-4000-8000-0000000e2e01',
      dueAt: '2026-12-01T12:00:00.000Z',
    });
    await page.getByRole('button', { name: 'Close Ask AI' }).click();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await expect(
      page.getByRole('tabpanel', { name: 'Tasks' }).getByText(title, { exact: true }),
    ).toBeVisible();
  });
}

for (const width of [375, 1440]) {
  test(`interactive drafts and email queue at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/w/canadawide/leads');
    await page.getByRole('link', { name: 'Avery Example', exact: true }).click();
    await expect(page).toHaveURL(/lead=/);
    if (width === 375)
      await page.getByRole('dialog').getByRole('button', { name: 'Ask AI', exact: true }).click();
    else await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const ask = async (text: string) => {
      await page.getByRole('textbox', { name: 'Ask a question' }).fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
    };
    await ask('Guided follow-up');
    await expect(page.getByRole('region', { name: 'Clarifying question' })).toBeVisible();
    await page.getByRole('button', { name: 'No due date', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Ask a question' })).toBeEnabled();
    await page.getByRole('button', { name: 'New chat' }).click();
    await ask('Add a note: Original draft');
    const note = page.getByRole('region', { name: 'Confirm note' });
    await note.getByRole('button', { name: 'Edit', exact: true }).click();
    await note.getByRole('textbox', { name: 'Note text' }).fill(`Edited note ${width}`);
    await note.getByRole('button', { name: 'Update draft' }).click();
    await expect(note.getByText(`Edited note ${width}`, { exact: true })).toBeVisible();
    await note.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(note.getByText('Note added.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New chat' }).click();
    await ask(`Draft an email: Please call us ${width}`);
    const email = page.getByRole('region', { name: 'Review email' });
    await email.getByRole('button', { name: 'Edit', exact: true }).click();
    await email.getByRole('textbox', { name: 'Email subject' }).fill('Updated subject');
    await email.getByRole('textbox', { name: 'Email message' }).fill(`Updated message ${width}`);
    await email.getByRole('button', { name: 'Update draft' }).click();
    await expect(email.getByText('Updated subject', { exact: true })).toBeVisible();
    let lost = false;
    await page.route('**/ai/actions/confirm', async (route) => {
      const response = await route.fetch();
      if (!lost) {
        lost = true;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await email.getByRole('button', { name: 'Send', exact: true }).click();
    await email.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(email.getByText('Email queued for delivery.', { exact: true })).toBeVisible();
    await page.unroute('**/ai/actions/confirm');
  });
}

for (const width of [375, 1440]) {
  test(`AI lead updates review edits and retry a lost receipt at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/w/canadawide/leads');
    await page.getByRole('link', { name: 'Avery Example', exact: true }).click();
    await expect(page).toHaveURL(/lead=/);
    const leadId = new URL(page.url()).searchParams.get('lead');
    if (!leadId) throw new Error('expected lead id');
    try {
      if (width === 375)
        await page.getByRole('dialog').getByRole('button', { name: 'Ask AI', exact: true }).click();
      else await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'Ask a question' })
        .fill('Update lead phone: 403 555 0111');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const card = page.getByRole('region', { name: 'Confirm lead update' });
      await expect(card.getByText('Current', { exact: true })).toBeVisible();
      await card.getByRole('button', { name: 'Edit', exact: true }).click();
      await card.getByRole('textbox', { name: 'Proposed value' }).fill(`403 555 ${width}`);
      await card.getByRole('button', { name: 'Update draft' }).click();
      await expect(card.getByText(`403 555 ${width}`, { exact: true })).toBeVisible();
      let lost = false;
      await page.route('**/ai/actions/confirm', async (route) => {
        const response = await route.fetch();
        if (!lost) {
          lost = true;
          await route.abort('failed');
        } else await route.fulfill({ response });
      });
      await card.getByRole('button', { name: 'Confirm', exact: true }).click();
      await card.getByRole('button', { name: 'Retry save' }).click();
      await expect(card.getByText('Lead updated.', { exact: true })).toBeVisible();
      await page.unroute('**/ai/actions/confirm');
      await page.getByRole('button', { name: 'Close Ask AI' }).click();
      await expect(page.getByText(`403 555 ${width}`, { exact: true }).first()).toBeVisible();
    } finally {
      await page.unroute('**/ai/actions/confirm');
      const restored = await page.request.patch(
        `http://127.0.0.1:4100/api/v1/staff/workspaces/10000000-0000-4000-8000-0000000e2e01/leads/${leadId}`,
        {
          headers: {
            authorization: `Bearer ${process.env['E2E_STAFF_BEARER'] ?? 'e2e-staff-session-owner'}`,
          },
          data: { contact: { phone: '403 555 0101' } },
        },
      );
      expect(restored.status()).toBe(200);
    }
  });
}

for (const width of [375, 1440]) {
  test(`AI automation drafts are reviewed, simulated and explicitly saved at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/w/getcanadasim/automations');
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    const ask = async (text: string) => {
      await page.getByRole('textbox', { name: 'Ask a question' }).fill(text);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Ask a question' })).toBeEnabled();
    };
    await ask(`Create a reviewed automation ${width}`);
    const card = page.getByRole('region', { name: 'Review automation draft' }).last();
    await expect(card).toBeVisible();
    await expect(card.getByText('Saving creates a draft with the flow Off.')).toBeVisible();
    await card.getByText('Simulate with sample data', { exact: true }).click();
    await card.getByLabel('Sample lead type', { exact: true }).selectOption('sim_order');
    await card.getByRole('button', { name: 'Run simulation' }).click();
    await expect(card.getByLabel('Automation simulation results')).toContainText('No email queued');
    await expect(card.getByLabel('Automation simulation results')).toContainText('Wait simulated');
    await card.getByRole('button', { name: 'Edit draft' }).click();
    await card.getByLabel('Automation draft name').fill(`AI browser flow ${width}`);
    await card.getByRole('button', { name: 'Review edits' }).click();
    await expect(card.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`automation-proposal-${width}.png`),
      fullPage: true,
    });
    let lost = false;
    await page.route('**/ai/automations/save', async (route) => {
      const response = await route.fetch();
      if (!lost) {
        lost = true;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await card.getByRole('button', { name: 'Save draft' }).click();
    await expect(card.getByRole('alert')).toBeVisible();
    await card.getByRole('button', { name: 'Save draft' }).click();
    await expect(card.getByRole('status')).toContainText('Draft saved');
    await expect(card.getByText(/· Saved draft$/)).toBeVisible();
    await page.unroute('**/ai/automations/save');
    await ask(`Edit the reviewed automation ${width}`);
    const edit = page.getByRole('region', { name: 'Review automation draft' }).last();
    await expect(edit.getByText('Before this edit', { exact: true })).toBeVisible();
    await edit.getByRole('button', { name: 'Save draft' }).click();
    await expect(edit.getByRole('status')).toContainText('Draft saved');
    const href = await edit.getByRole('link', { name: 'Open in builder' }).getAttribute('href');
    if (!href) throw new Error('missing builder link');
    await page.getByRole('button', { name: 'Close Ask AI' }).click();
    await page.goto(href);
    await expect(
      page.getByRole('heading', { level: 1, name: `AI browser flow ${width} edited` }),
    ).toBeVisible();
    await expect(
      page.getByRole('switch', { name: `AI browser flow ${width} edited`, exact: true }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // Keep the shared seeded site's seven active-list fixtures intact for later journeys.
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await page
      .getByRole('dialog', { name: `Archive AI browser flow ${width} edited?` })
      .getByRole('button', { name: 'Archive', exact: true })
      .click();
    await expect(page.getByText('Archived', { exact: true })).toBeVisible();
  });
}

test('AI resolves me into a reviewed assignment without requesting staff identifiers', async ({
  page,
}) => {
  await page.goto('/w/getcanadasim/automations');
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask a question' }).fill('Assign new SIM orders to me');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByRole('region', { name: 'Review automation draft' });
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Assign/);
  await expect(card.getByRole('button', { name: 'Save draft' })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Clarifying question' })).toHaveCount(0);
  await expect(card).not.toContainText(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  await card.getByRole('button', { name: 'Discard', exact: true }).click();
});
