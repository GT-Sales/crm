import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  for (const width of [375, 1440]) {
    test(`Ask AI streams from the backend at ${width}px in ${theme} mode`, async ({ page }) => {
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
      await expect(page.getByRole('textbox', { name: 'Ask a question' })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
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
