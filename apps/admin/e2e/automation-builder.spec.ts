import { expect, test } from '@playwright/test';

/**
 * The automation builder's layout in a real browser against the real backend
 * (see playwright.leads.config.ts), on the seeded custom flow "Verified
 * follow-up". It sets the flow's switch to a known state itself and leaves the
 * flow off, as the harness seeds it, so it depends on no other journey. It
 * lives outside the serial lead journeys (leads.spec.ts) so a retry reruns this
 * test alone, not journeys whose seeded data the first pass already changed.
 */
test('automation builder explains setup and paths visually', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/w/getcanadasim/automations');
  await page.getByRole('link', { name: 'Verified follow-up', exact: true }).click();
  const canvas = page.getByRole('region', { name: 'Automation flow canvas' });
  await expect(canvas).toBeVisible();
  const flowSwitch = page.getByRole('switch', { name: 'Verified follow-up', exact: true });
  if ((await flowSwitch.getAttribute('aria-checked')) !== 'true') {
    await flowSwitch.click();
    await expect(page.getByText(/On · New matching leads run the active version/)).toBeVisible();
  }
  await expect(flowSwitch).not.toHaveAttribute('aria-disabled', 'true');
  await flowSwitch.click();
  await expect(page.getByText(/Off · An active version is ready/)).toBeVisible();
  await canvas.getByRole('button', { name: /^If\/else:/ }).click();
  await expect(page.getByRole('navigation', { name: 'Flow setup' })).toBeVisible();
  await expect(canvas.getByText('Yes · matches', { exact: true })).toBeVisible();
  await expect(canvas.getByText('No · otherwise', { exact: true })).toBeVisible();
  await expect(canvas.getByText('End of path', { exact: true })).toHaveCount(2);
  await expect
    .poll(() =>
      canvas
        .locator('.automation-node-card')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    )
    .toBe('automation-card-enter');
  await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
  await expect
    .poll(async () => {
      const area = await canvas.boundingBox();
      const selected = await canvas.locator('.automation-node-selected').boundingBox();
      return (
        area !== null &&
        selected !== null &&
        selected.x >= area.x &&
        selected.y >= area.y &&
        selected.x + selected.width <= area.x + area.width &&
        selected.y + selected.height <= area.y + area.height
      );
    })
    .toBe(true);
  await page.getByRole('button', { name: 'Fit flow', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'If/else', exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Fit flow', exact: true }).click();
  await expect
    .poll(() =>
      canvas
        .locator('.automation-node-card')
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    )
    .toBe('none');
  await expect
    .poll(async () => {
      const area = await canvas.boundingBox();
      const bounds = await canvas.locator('.react-flow__node').evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
        }),
      );
      return (
        area !== null &&
        bounds.every(
          (rect) =>
            rect.x >= area.x &&
            rect.y >= area.y &&
            rect.right <= area.x + area.width &&
            rect.bottom <= area.y + area.height,
        )
      );
    })
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('automation-desktop.png'), fullPage: true });
  await testInfo.attach('automation-layout', {
    body: JSON.stringify({
      width: 1440,
      height: await page.evaluate(() => document.documentElement.scrollHeight),
      setup: await page.getByRole('navigation', { name: 'Flow setup' }).boundingBox(),
      status: await page.getByText(/Off · An active version is ready/).boundingBox(),
      endings: await canvas.locator('.react-flow__node-end').evaluateAll((elements) => {
        const rects = elements.map((el) => el.getBoundingClientRect());
        const x = Math.min(...rects.map((rect) => rect.x));
        const y = Math.min(...rects.map((rect) => rect.y));
        return {
          x,
          y: y + window.scrollY,
          width: Math.max(...rects.map((rect) => rect.right)) - x,
          height: Math.max(...rects.map((rect) => rect.bottom)) - y,
        };
      }),
    }),
    contentType: 'application/json',
  });
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(page.getByRole('button', { name: 'List view', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('navigation', { name: 'Flow setup' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('automation-phone.png'), fullPage: true });
});
