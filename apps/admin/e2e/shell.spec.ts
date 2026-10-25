import { expect, test } from '@playwright/test';

const publicRoutes = [
  { url: '/login', title: 'Staff sign in' },
  { url: '/denied', title: 'Access denied' },
  { url: '/recovery', title: 'Recover staff access' },
];

for (const route of publicRoutes) {
  test(`${route.url} remains reachable without an authenticated session`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const response = await page.goto(route.url);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(route.title);
    await expect(page.getByRole('main')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test('an unconfigured or unauthenticated deployment never renders a workspace shell', async ({
  page,
}) => {
  await page.goto('/w/getcanadasim/leads');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /^(Staff authentication unavailable|Staff sign in)$/,
  );
  await expect(page.getByRole('heading', { name: 'Leads' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch site' })).toHaveCount(0);
});

test('invitation acceptance and recovery entry points stay usable', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'I have a staff invitation' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accept staff invitation');
  await page.getByRole('link', { name: 'Recover access' }).click();
  await expect(page).toHaveURL('/recovery');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Recover staff access');
});

test('denial reason codes are visible and lead back to sign in', async ({ page }) => {
  await page.goto('/denied?reason=permission_denied');
  await expect(page.getByText('Reason: permission_denied')).toBeVisible();
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(page).toHaveURL('/login');
});

test('unknown route returns 404', async ({ page }) => {
  const response = await page.goto('/route-does-not-exist');
  expect(response?.status()).toBe(404);
});
