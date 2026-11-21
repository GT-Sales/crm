import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  aiCapabilitiesResponseSchema,
  createLeadResponseSchema,
  createServiceCredentialResponseSchema,
  flowDetailResponseSchema,
  flowListResponseSchema,
  getWorkspaceLeadResponseSchema,
  listPlansResponseSchema,
} from '@gt-sales/contracts';

/**
 * Ask AI's wider cards and reads in a real browser against the real backend
 * harness (apps/backend/tests/e2e/harness.ts; only the model is synthetic).
 * One journey per card kind, each ending in the app itself: the lead page, the
 * timeline entry that reads "via Ask AI", the lead's mail, the automation's
 * switch. Every journey makes its own leads through the website's intake, so
 * it depends on no other spec's data and leaves the seeded leads alone; it
 * sorts last (zz-) so the lead counts the other suites assert are unchanged
 * when it runs. It runs with `pnpm --filter admin test:e2e:leads` (the file
 * must be listed in playwright.leads.config.ts `testMatch` and in the shell
 * config's `testIgnore`); under any other base URL every test skips.
 */
const LEAD_JOURNEYS_URL = 'http://127.0.0.1:3101';
const API = 'http://127.0.0.1:4100/api/v1';
const CW = '10000000-0000-4000-8000-0000000e2e01';
const SIM = '10000000-0000-4000-8000-0000000e2e02';
const OWNER_ID = '20000000-0000-4000-8000-0000000e2e01';
const SAM_ID = '20000000-0000-4000-8000-0000000e2e02';
const OWNER = process.env['E2E_STAFF_BEARER'] ?? 'e2e-staff-session-owner';
const SAM = process.env['E2E_COLLEAGUE_BEARER'] ?? 'e2e-staff-session-leads-sam';
const run = Date.now().toString(36);

test.beforeEach(({ baseURL }) => {
  test.skip(baseURL !== LEAD_JOURNEYS_URL, 'Needs the lead-journey harness (test:e2e:leads).');
});

async function staff(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  workspaceId: string,
  path: string,
  data?: unknown,
  bearer = OWNER,
) {
  const response = await request.fetch(`${API}/staff/workspaces/${workspaceId}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}` },
    ...(data === undefined ? {} : { data }),
  });
  return { status: response.status(), json: await response.json().catch(() => ({})) };
}

const siteKeys = new Map<string, string>();
async function siteKey(request: APIRequestContext, workspaceId: string): Promise<string> {
  const known = siteKeys.get(workspaceId);
  if (known) return known;
  const made = await staff(request, 'POST', workspaceId, '/service-credentials', {
    scopes: ['leads:write'],
    // Every registered type: these journeys send more than one (issue #84).
    leadTypes: ['internet', 'mobility', 'sim_order', 'partner_application', 'contact_message'],
  });
  expect(made.status).toBe(201);
  const secret = createServiceCredentialResponseSchema.parse(made.json).secret;
  siteKeys.set(workspaceId, secret);
  return secret;
}

async function planId(request: APIRequestContext, name: string): Promise<string> {
  const listed = await staff(request, 'GET', SIM, '/plans');
  const plan = listPlansResponseSchema
    .parse(listed.json)
    .plans.find((entry) => entry.name === name);
  if (!plan) throw new Error(`plan ${name} is not seeded`);
  return plan.id;
}

/** A submitted lead through the website's intake, optionally moved on as staff. */
async function makeLead(input: {
  request: APIRequestContext;
  site: 'sim' | 'cw';
  name: string;
  plan?: 'Fido 75GB' | 'Rogers 60GB';
  stage?: string;
  patch?: Record<string, unknown>;
}): Promise<string> {
  const { request } = input;
  const workspaceId = input.site === 'sim' ? SIM : CW;
  const email = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.test`;
  const contact = { fullName: input.name, email, phone: '647 555 0911', countryCode: 'CA' };
  let body: Record<string, unknown>;
  if (input.site === 'sim') {
    const id = await planId(request, input.plan ?? 'Fido 75GB');
    body = {
      leadType: 'sim_order',
      contact,
      form: {
        schemaVersion: 1,
        payload: {
          planId: id,
          planLabel: input.plan ?? 'Fido 75GB',
          permitType: 'worker',
          arrivalDate: '2026-12-01',
          delivery: 'esim',
          flightBooked: true,
          gotVisa: true,
        },
      },
      order: { planId: id, quantity: 1 },
      consentVersion: 'ai-wide-e2e',
      submit: true,
    };
  } else {
    body = {
      leadType: 'internet',
      contact,
      form: {
        schemaVersion: 1,
        payload: {
          planId: 'ab-1gbps',
          planLabel: '1Gbps',
          dateOfBirth: '1990-04-12',
          streetAddress: '12 Example Street',
          city: 'Calgary',
          postalCode: 'T2P 1J9',
          currentProvider: 'Shaw',
          consent: true,
          consentedAt: '2026-10-20T10:00:00.000Z',
        },
      },
      consentVersion: 'ai-wide-e2e',
      submit: true,
    };
  }
  const created = await request.post(`${API}/website/leads`, {
    headers: { authorization: `Bearer ${await siteKey(request, workspaceId)}` },
    data: body,
  });
  expect(created.status()).toBe(201);
  const id = createLeadResponseSchema.parse(await created.json()).lead.id;
  if (input.stage) {
    const moved = await staff(request, 'PATCH', workspaceId, `/leads/${id}`, {
      stage: input.stage,
      ...input.patch,
    });
    expect(moved.status).toBe(200);
  }
  return id;
}

async function leadOf(request: APIRequestContext, workspaceId: string, id: string) {
  const response = await request.get(`${API}/staff/workspaces/${workspaceId}/leads/${id}`, {
    headers: { authorization: `Bearer ${OWNER}` },
  });
  expect(response.status()).toBe(200);
  return getWorkspaceLeadResponseSchema.parse(await response.json());
}

/** The lead's own page with Ask AI open on it. */
async function openAsk(page: Page, slug: string, leadId?: string) {
  await page.goto(leadId ? `/w/${slug}/leads/${leadId}` : `/w/${slug}/automations`);
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Ask a question' })).toBeFocused();
  if (leadId) await expect(page.getByText('Asking about the open lead')).toBeVisible();
}

async function ask(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Ask a question' }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const newChat = (page: Page) => page.getByRole('button', { name: 'New chat' }).click();

/** Today in Toronto, `YYYY-MM-DD`: the date a stage move defaults to. */
const torontoToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const confirmButton = (card: ReturnType<Page['getByRole']>) =>
  card.getByRole('button', { name: 'Confirm', exact: true });

/** What the model received from one read, as the synthetic engine prints it. */
async function rawRead(page: Page, tool: string, args = '') {
  await ask(page, `Raw read: ${tool}${args ? ` ${args}` : ''}`);
  const block = page.locator('pre').last();
  await expect(block).toContainText('"status"');
  await expect(page.getByRole('textbox', { name: 'Ask a question' })).toBeEnabled();
  return (await block.innerText()).replace(/\s+/g, ' ');
}

/** No contact email, phone or street address in text the model was given. */
function expectNoContactDetails(text: string) {
  expect(text).not.toMatch(/@example\.test/);
  expect(text).not.toMatch(/\b\d{3}[ -]\d{3}[ -]\d{4}\b/);
  expect(text).not.toMatch(/Example Street|Sample Road/);
}

test('a stage move to Delivered carries the courier and tracking number on one card', async ({
  page,
  request,
}) => {
  const name = `Courier ${run}`;
  const id = await makeLead({ request, site: 'sim', name, stage: 'verified' });
  await openAsk(page, 'getcanadasim', id);
  await ask(page, 'Mark as delivered with Canada Post TRK123');
  const card = page.getByRole('region', { name: 'Confirm lead change' });
  await expect(card.getByRole('heading', { name: 'Move the lead' })).toBeVisible();
  await expect(card).toContainText(name);
  for (const text of ['Verified', 'Delivered', 'Canada Post', 'TRK123']) {
    await expect(card).toContainText(text);
  }
  await expect(card.getByText('What else happens', { exact: true })).toBeVisible();
  // T2: the card shows what Confirm saves: the dispatch date it defaults to is
  // today, shown as that day, and no detail reads "Not set → Cleared".
  await expect(card.getByText(/^\d{1,2} \w+ \d{4} \(today\)$/)).toBeVisible();
  await expect(card).not.toContainText('Cleared');
  await expect(confirmButton(card)).toBeEnabled();
  // Nothing is saved before Confirm.
  expect((await leadOf(request, SIM, id)).lead.stage).toBe('verified');
  await confirmButton(card).click();
  await expect(card.getByText('Lead updated.', { exact: true })).toBeVisible();
  const saved = (await leadOf(request, SIM, id)).lead;
  expect(saved.stage).toBe('delivered');
  expect(saved.order).toMatchObject({ courier: 'Canada Post', trackingNumber: 'TRK123' });
  expect(saved.order?.dispatchedAt).toBe(torontoToday());

  // The result in the app: the lead page, and the timeline reads "via Ask AI".
  await page.getByRole('button', { name: 'Close Ask AI' }).click();
  await page.reload();
  const order = page.getByRole('region', { name: 'Order' });
  await expect(order.locator('dt:text-is("Courier") + dd')).toHaveText('Canada Post');
  await expect(order.locator('dt:text-is("Tracking number") + dd')).toHaveText('TRK123');
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(
    timeline.getByRole('listitem').filter({ hasText: 'moved this from Verified to Delivered' }),
  ).toContainText('Takib · via Ask AI');
  await expect(
    timeline.getByRole('listitem').filter({ hasText: 'corrected the courier' }),
  ).toContainText('via Ask AI');
});

test('a move to Delivered without a courier waits for one typed on the card', async ({
  page,
  request,
}) => {
  const id = await makeLead({ request, site: 'sim', name: `Nocourier ${run}`, stage: 'verified' });
  await openAsk(page, 'getcanadasim', id);
  await ask(page, 'Mark as delivered');
  const card = page.getByRole('region', { name: 'Confirm lead change' });
  await expect(card.getByText('Courier (required)')).toBeVisible();
  await expect(confirmButton(card)).toBeDisabled();
  await expect(card.getByText(/Enter the courier with Edit, then Update draft/)).toBeVisible();

  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await card.getByRole('textbox', { name: 'Courier' }).fill('Purolator');
  await card.getByRole('button', { name: 'Update draft' }).click();
  await expect(card).toContainText('Purolator');
  await expect(confirmButton(card)).toBeEnabled();
  expect((await leadOf(request, SIM, id)).lead.stage).toBe('verified');
  await confirmButton(card).click();
  await expect(card.getByText('Lead updated.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Close Ask AI' }).click();
  await page.reload();
  const order = page.getByRole('region', { name: 'Order' });
  await expect(order.locator('dt:text-is("Courier") + dd')).toHaveText('Purolator');
  await expect(
    page.getByRole('region', { name: 'Timeline' }).getByRole('listitem').filter({
      hasText: 'moved this from Verified to Delivered',
    }),
  ).toContainText('via Ask AI');
});

test('a move blocked by missing documents makes no card, says why and links to the lead', async ({
  page,
  request,
}) => {
  const id = await makeLead({
    request,
    site: 'sim',
    name: `Blocked ${run}`,
    plan: 'Rogers 60GB',
    stage: 'verified',
  });
  await openAsk(page, 'getcanadasim', id);
  await ask(page, 'Mark as delivered and explain');
  await expect(
    page.getByText(/needs these required documents approved on the lead page first: passport/),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Ask a question' })).toBeEnabled();
  await expect(page.getByRole('region', { name: /^(Confirm|Review)/ })).toHaveCount(0);
  // The lead's source card under the answer links to its page.
  await expect(page.getByRole('link', { name: /^MS-\d+$/ })).toHaveAttribute(
    'href',
    `/w/getcanadasim/leads/${id}`,
  );
  expect((await leadOf(request, SIM, id)).lead.stage).toBe('verified');
});

test('mark as activated: the activation number is typed on the card and saved', async ({
  page,
  request,
}) => {
  const id = await makeLead({
    request,
    site: 'sim',
    name: `Activate ${run}`,
    stage: 'verified',
  });
  const delivered = await staff(request, 'PATCH', SIM, `/leads/${id}`, {
    stage: 'delivered',
    order: { courier: 'UPS' },
  });
  expect(delivered.status).toBe(200);
  await openAsk(page, 'getcanadasim', id);
  await ask(page, 'Mark as activated');
  const card = page.getByRole('region', { name: 'Confirm lead change' });
  await expect(card).toContainText('Delivered');
  await expect(card).toContainText('Activated');
  // T2: the activation date it saves is today; the number and account it does
  // not change are not listed until the person types them.
  await expect(card.getByText(/^\d{1,2} \w+ \d{4} \(today\)$/)).toBeVisible();
  await expect(card).not.toContainText('Activation number');
  await expect(card).not.toContainText('Cleared');
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(card.getByRole('textbox', { name: 'Activation number' })).toBeVisible();
  await card.getByRole('textbox', { name: 'Activation number' }).fill('ACT-4455');
  await card.getByRole('textbox', { name: 'Activation account' }).fill('acct-9');
  await card.getByRole('button', { name: 'Update draft' }).click();
  await expect(card).toContainText('ACT-4455');
  expect((await leadOf(request, SIM, id)).lead.stage).toBe('delivered');
  await confirmButton(card).click();
  await expect(card.getByText('Lead updated.', { exact: true })).toBeVisible();
  const saved = (await leadOf(request, SIM, id)).lead;
  expect(saved.stage).toBe('activated');
  expect(saved.order).toMatchObject({ activationNumber: 'ACT-4455', activationAccount: 'acct-9' });
  expect(saved.order?.activatedAt).toBe(torontoToday());

  await page.getByRole('button', { name: 'Close Ask AI' }).click();
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Timeline' }).getByRole('listitem').filter({
      hasText: 'moved this from Delivered to Activated',
    }),
  ).toContainText('Takib · via Ask AI');
});

test('set quantity, change plan, a form field and a custom property are each one reviewed card', async ({
  page,
  request,
}) => {
  const id = await makeLead({ request, site: 'sim', name: `Edits ${run}` });
  const rogers = await planId(request, 'Rogers 60GB');
  const made = await staff(request, 'POST', SIM, '/properties', {
    label: 'Account ref',
    kind: 'text',
  });
  expect([201, 409]).toContain(made.status);
  await openAsk(page, 'getcanadasim', id);

  // Quantity and payment status together.
  await ask(page, 'Set quantity to 3');
  let card = page.getByRole('region', { name: 'Confirm lead change' }).last();
  await expect(card).toContainText('Quantity');
  await expect(card).toContainText('Paid');
  // T6: nothing on this card is typed by the person, so it offers no (empty) Edit.
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  expect((await leadOf(request, SIM, id)).lead.order?.quantity).toBe(1);
  await confirmButton(card).click();
  await expect(card.getByText('Lead updated.', { exact: true })).toBeVisible();
  expect((await leadOf(request, SIM, id)).lead.order).toMatchObject({
    quantity: 3,
    paymentStatus: 'paid',
  });

  // A plan change says the price is re-frozen.
  await newChat(page);
  await ask(page, `Prepare lead edit: {"order":{"planId":"${rogers}"}}`);
  card = page.getByRole('region', { name: 'Confirm lead change' }).last();
  await expect(card).toContainText('Rogers 60GB');
  await expect(card).toContainText('Re-freezes the plan');
  await expect(card.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await confirmButton(card).click();
  await expect(card.getByText('Lead updated.', { exact: true })).toBeVisible();
  const replanned = (await leadOf(request, SIM, id)).lead.order;
  expect(replanned?.plan?.name).toBe('Rogers 60GB');
  expect(replanned?.plan?.priceMinor).toBe(4000);

  // A form field.
  await newChat(page);
  await ask(page, 'Prepare lead edit: {"form":{"permitType":"student"}}');
  card = page.getByRole('region', { name: 'Confirm lead change' }).last();
  await expect(card).toContainText('Work permit');
  await expect(card).toContainText('Study permit');
  await confirmButton(card).click();
  await expect(card.getByText('Lead updated.', { exact: true })).toBeVisible();

  // A custom property.
  await newChat(page);
  await ask(page, 'Prepare lead edit: {"customValues":{"custom_account_ref":"R-100"}}');
  card = page.getByRole('region', { name: 'Confirm lead change' }).last();
  await expect(card).toContainText('Account ref');
  await expect(card).toContainText('R-100');
  await confirmButton(card).click();
  await expect(card.getByText('Lead updated.', { exact: true })).toBeVisible();

  // The result on the lead page.
  await page.getByRole('button', { name: 'Close Ask AI' }).click();
  await page.reload();
  const order = page.getByRole('region', { name: 'Order' });
  await expect(order.locator('dt:text-is("Plan") + dd')).toContainText('Rogers 60GB');
  await expect(order.locator('dt:text-is("Quantity") + dd')).toHaveText('3');
  await expect(order.locator('dt:text-is("Payment status") + dd')).toHaveText('Paid');
  await expect(page.getByText('Study permit').first()).toBeVisible();
  await expect(page.getByText('R-100').first()).toBeVisible();
  const timeline = page.getByRole('region', { name: 'Timeline' });
  expect(await timeline.getByText('via Ask AI').count()).toBeGreaterThanOrEqual(4);
  // Clean up the property so later suites see the site as seeded.
  await staff(request, 'DELETE', SIM, '/properties/custom_account_ref');
});

test('a task can be assigned to another member and a task edit changes title, date and assignee', async ({
  page,
  request,
}) => {
  const id = await makeLead({ request, site: 'cw', name: `Tasks ${run}` });
  await openAsk(page, 'canadawide', id);
  await ask(page, 'Assign a task to Sam');
  let card = page.getByRole('region', { name: 'Confirm task' });
  await expect(card).toContainText('Follow up for a colleague');
  await expect(card).toContainText('Sam');
  await confirmButton(card).click();
  await expect(card.getByText('Task created.', { exact: true })).toBeVisible();
  const tasks = (await leadOf(request, CW, id)).tasks;
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.assignedActorId).toBe(SAM_ID);

  await page.getByRole('button', { name: 'Close Ask AI' }).click();
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Tasks' }).getByText('Follow up for a colleague'),
  ).toBeVisible();

  // The edit: title, due date and assignee in one card (it moves back to the owner).
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await newChat(page);
  await ask(
    page,
    'Change the task "Follow up for a colleague" to "Call back Friday", due 2026-12-24, for me',
  );
  card = page.getByRole('region', { name: 'Confirm task move' });
  await expect(card.getByRole('heading', { name: 'Change a task' })).toBeVisible();
  await expect(card).toContainText('Follow up for a colleague');
  await expect(card).toContainText('Call back Friday');
  await expect(card).toContainText('Dec 24, 2026');
  await expect(card).toContainText('Sam');
  await expect(card).toContainText('You');
  expect((await leadOf(request, CW, id)).tasks[0]?.title).toBe('Follow up for a colleague');
  await confirmButton(card).click();
  await expect(card.getByRole('status')).toContainText(/saved|moved|changed|updated/i);
  const edited = (await leadOf(request, CW, id)).tasks[0];
  expect(edited?.title).toBe('Call back Friday');
  expect(edited?.dueAt).toBe('2026-12-24T12:00:00.000Z');
  expect(edited?.assignedActorId).toBe(OWNER_ID);

  // The result on the owner's own Tasks board.
  await page.goto('/w/canadawide/tasks');
  await expect(page.getByText('Call back Friday').first()).toBeVisible();
  await expect(page.getByText('Follow up for a colleague')).toHaveCount(0);
});

test('a template email shows its rendered text, is sent once and reaches the lead’s mail', async ({
  page,
  request,
}) => {
  const id = await makeLead({ request, site: 'sim', name: `Template ${run}`, stage: 'verified' });
  const simNumber = '416 555 0188';
  const set = await staff(request, 'PATCH', SIM, `/leads/${id}`, { form: { simNumber } });
  expect(set.status).toBe(200);
  await openAsk(page, 'getcanadasim', id);
  const confirms: string[] = [];
  page.on('request', (outgoing) => {
    if (outgoing.url().endsWith('/ai/actions/confirm') && outgoing.method() === 'POST')
      confirms.push(outgoing.postData() ?? '');
  });
  await ask(page, 'Send the SIM number email');
  const card = page.getByRole('region', { name: 'Review email' });
  await expect(
    card.getByRole('heading', { name: 'Send the “SIM number ready” email' }),
  ).toBeVisible();
  await expect(card).toContainText('Your Canadian mobile number is ready');
  await expect(card).toContainText(`Your Canadian number: ${simNumber}`);
  await expect(card).toContainText('orders@getcanadasim.example');
  await expect(card).not.toContainText(/\{[^}]+\}/);
  await expect(card.getByText(/A sent email cannot be called back/)).toBeVisible();
  const sendButton = card.getByRole('button', { name: 'Send', exact: true });
  await expect(sendButton).toBeEnabled();
  await sendButton.dblclick();
  await expect(card.getByText('Email queued for delivery.', { exact: true })).toBeVisible();
  const first = confirms[0];
  expect(first).toBeTruthy();

  // A replay of the same signed card (a retry after a lost answer) makes no second mail.
  const replay = await request.post(`${API}/staff/workspaces/${SIM}/ai/actions/confirm`, {
    headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
    data: first ?? '',
  });
  expect([200, 409]).toContain(replay.status());

  await page.getByRole('button', { name: 'Close Ask AI' }).click();
  await page.reload();
  const mail = page.getByRole('button', { name: /^Your Canadian mobile number is ready/ });
  await expect(mail).toHaveCount(1);
  await expect(mail).toContainText('with Ask AI');
  const sent = (await leadOf(request, SIM, id)).activities.filter(
    (entry) =>
      entry.kind === 'system' &&
      entry.event === 'customer_emailed' &&
      entry.template === 'sim_number_ready',
  );
  expect(sent).toHaveLength(1);
  await expect(
    page.getByRole('region', { name: 'Timeline' }).getByText('via Ask AI').first(),
  ).toBeVisible();
});

test('archive and restore are cards that say what else happens', async ({ page, request }) => {
  const name = `Archive ${run}`;
  const id = await makeLead({ request, site: 'sim', name });
  await openAsk(page, 'getcanadasim', id);
  await ask(page, 'Archive this lead');
  let card = page.getByRole('region', { name: 'Confirm archive change' });
  await expect(card.getByRole('heading', { name: 'Archive the lead' })).toBeVisible();
  await expect(
    card.getByText('Waiting automation runs and timers for this lead are cancelled.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(card.getByText(/The lead leaves the inbox and can be restored/)).toBeVisible();
  expect((await leadOf(request, SIM, id)).lead.deletedAt).toBeNull();
  await confirmButton(card).click();
  await expect(card.getByText('Lead archived.', { exact: true })).toBeVisible();
  expect((await leadOf(request, SIM, id)).lead.deletedAt).not.toBeNull();

  await page.goto(`/w/getcanadasim/leads?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);

  // T13: from the archived lead's own page, which the model is told is archived.
  await openAsk(page, 'getcanadasim', id);
  await ask(page, 'Restore this lead');
  card = page.getByRole('region', { name: 'Confirm archive change' });
  await expect(card.getByRole('heading', { name: 'Restore the lead' })).toBeVisible();
  await confirmButton(card).click();
  await expect(card.getByText('Lead restored.', { exact: true })).toBeVisible();
  expect((await leadOf(request, SIM, id)).lead.deletedAt).toBeNull();
  await page.goto(`/w/getcanadasim/leads/${id}`);
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(timeline.getByText('via Ask AI').first()).toBeVisible();
  await page.goto(`/w/getcanadasim/leads?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
});

test('the owner can switch an automation off with a card; a member without integration access is not offered it', async ({
  page,
  request,
  browser,
}) => {
  const enabledOf = async (workspaceId: string, key: string) =>
    flowListResponseSchema
      .parse((await staff(request, 'GET', workspaceId, '/automations')).json)
      .automations.find((entry) => entry.key === key)?.enabled;
  // The seeded custom flow, switched on for the journey and left off.
  const flow = flowListResponseSchema
    .parse((await staff(request, 'GET', SIM, '/automations')).json)
    .automations.find((entry) => entry.name === 'Verified follow-up');
  if (!flow) throw new Error('the seeded flow is missing');
  const detail = flowDetailResponseSchema.parse(
    (await staff(request, 'GET', SIM, `/automations/${flow.key}`)).json,
  );
  const on = await staff(request, 'PUT', SIM, `/automations/${flow.key}`, {
    enabled: true,
    expectedRevision: detail.revision,
  });
  expect(on.status).toBe(200);
  expect(await enabledOf(SIM, flow.key)).toBe(true);

  await openAsk(page, 'getcanadasim');
  await ask(page, `Switch off the automation ${flow.key}`);
  const card = page.getByRole('region', { name: 'Confirm automation switch-off' });
  await expect(
    card.getByRole('heading', { name: 'Switch off “Verified follow-up”' }),
  ).toBeVisible();
  await expect(
    card.getByText(/Switching it on again is done on the Automations page/),
  ).toBeVisible();
  await expect(card.getByRole('link', { name: 'View automation' })).toBeVisible();
  expect(await enabledOf(SIM, flow.key)).toBe(true);
  await confirmButton(card).click();
  await expect(card.getByText('Automation switched off.', { exact: true })).toBeVisible();
  expect(await enabledOf(SIM, flow.key)).toBe(false);
  await page.getByRole('button', { name: 'Close Ask AI' }).click();
  await page.goto(`/w/getcanadasim/automations/${flow.key}`);
  await expect(
    page.getByRole('switch', { name: 'Verified follow-up', exact: true }),
  ).toHaveAttribute('aria-checked', 'false');

  // Sam (Leads role, no integration access): the capabilities and the app offer no such card.
  const cardActions = async (bearer: string) =>
    aiCapabilitiesResponseSchema.parse(
      await (
        await request.get(`${API}/staff/workspaces/${CW}/ai/capabilities`, {
          headers: { authorization: `Bearer ${bearer}` },
        })
      ).json(),
    ).cardActions ?? [];
  expect(await cardActions(OWNER)).toContain('automation_off');
  const samCards = await cardActions(SAM);
  expect(samCards).not.toContain('automation_off');
  expect(samCards).toContain('lead_edit');
  const samContext = await browser.newContext({ baseURL: LEAD_JOURNEYS_URL });
  const samPage = await samContext.newPage();
  await samPage.route(`${API}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${SAM}` } }),
  );
  try {
    await openAsk(samPage, 'canadawide');
    await ask(samPage, 'Switch off the automation order_received');
    await expect(samPage.getByRole('textbox', { name: 'Ask a question' })).toBeEnabled();
    await expect(
      samPage.getByRole('region', { name: 'Confirm automation switch-off' }),
    ).toHaveCount(0);
    expect(await enabledOf(CW, 'order_received')).toBe(false);
  } finally {
    await samContext.close();
  }
});

test('a member who loses the change but keeps Ask AI sees the card refused and keeps the chat', async ({
  browser,
  request,
}) => {
  const id = await makeLead({ request, site: 'cw', name: `Rolechange ${run}` });
  const setRole = async (role: 'leads' | 'orders') => {
    const changed = await request.post('http://127.0.0.1:4100/__e2e/colleague-role', {
      data: { role },
    });
    expect(changed.status()).toBe(200);
  };
  const samContext = await browser.newContext({ baseURL: LEAD_JOURNEYS_URL });
  const samPage = await samContext.newPage();
  await samPage.route(`${API}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${SAM}` } }),
  );
  try {
    await openAsk(samPage, 'canadawide', id);
    await ask(samPage, 'Add a note: Sam called the customer');
    const card = samPage.getByRole('region', { name: 'Confirm note' });
    await expect(card).toContainText('Sam called the customer');
    // The owner moves Sam from Leads to Orders while the card is open: Ask AI stays, notes go.
    await setRole('orders');
    await confirmButton(card).click();
    await expect(card.getByRole('status')).toHaveText(
      'Not saved. You no longer have permission to make this change. Ask the owner if you need it; you can still ask Ask AI questions.',
    );
    await expect(card.getByRole('button', { name: 'Retry save' })).toHaveCount(0);
    // The conversation is kept and Ask AI still answers.
    await expect(
      samPage.getByText('Draft ready for confirmation. Nothing has been saved.'),
    ).toBeVisible();
    await expect(samPage.getByRole('textbox', { name: 'Ask a question' })).toBeEnabled();
    expect(
      (await leadOf(request, CW, id)).activities.filter((entry) => entry.kind === 'note'),
    ).toEqual([]);
  } finally {
    await setRole('leads');
    await samContext.close();
  }
});

test('an email whose body names another customer is refused until the person ticks the warning', async ({
  page,
  request,
}) => {
  const id = await makeLead({ request, site: 'sim', name: `Mention ${run}` });
  const mailsOf = async () =>
    (await leadOf(request, SIM, id)).activities.filter(
      (entry) =>
        entry.kind === 'system' &&
        entry.event === 'customer_emailed' &&
        entry.subject === 'Your order',
    ).length;
  await openAsk(page, 'getcanadasim', id);
  // The first confirm goes without the tick, as a tampered or older client would send it.
  const confirms: string[] = [];
  let stripped = false;
  await page.route('**/ai/actions/confirm', async (route) => {
    if (stripped) {
      confirms.push(route.request().postData() ?? '');
      await route.continue();
      return;
    }
    stripped = true;
    const withoutTick = JSON.stringify({ token: route.request().postDataJSON().token });
    confirms.push(withoutTick);
    await route.continue({ postData: withoutTick });
  });
  await ask(
    page,
    'Email naming a customer found by search: Priya | Hello, your order matches the one Priya Sharma placed.',
  );
  const card = page.getByRole('region', { name: 'Review email' });
  await expect(card.getByText(/This names other customers: .*Priya Sharma/)).toBeVisible();
  const send = card.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  const tick = card.getByRole('checkbox', { name: /I checked it, and it may name them/ });
  await expect(tick).not.toBeChecked();

  await tick.check();
  await expect(send).toBeEnabled();
  await send.click();
  // The server refuses the confirm that lacks the tick, in words, and nothing is sent.
  const status = card.getByRole('status');
  await expect(card.getByRole('button', { name: 'Retry save' })).toBeVisible();
  await expect(status).not.toContainText(/acknowledgement_required|conflict|409/i);
  await expect(card.getByText('Email queued for delivery.', { exact: true })).toHaveCount(0);
  expect(confirms[0]).not.toContain('acknowledged');
  expect(await mailsOf()).toBe(0);

  // The retry carries the tick and sends.
  await card.getByRole('button', { name: 'Retry save' }).click();
  await expect(card.getByText('Email queued for delivery.', { exact: true })).toBeVisible();
  expect(confirms[1]).toContain('"acknowledged":true');
  expect(await mailsOf()).toBe(1);
  await page.getByRole('button', { name: 'Close Ask AI' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: /^Your order/ })).toHaveCount(1);
});

test('wider reads: a lead’s timeline and documents, inbox counters and plans carry no contact details', async ({
  page,
  request,
}) => {
  const name = `Reads ${run}`;
  const id = await makeLead({ request, site: 'sim', name, stage: 'verified' });
  const moved = await staff(request, 'PATCH', SIM, `/leads/${id}`, { assignedActorId: null });
  expect(moved.status).toBe(200);
  await openAsk(page, 'getcanadasim', id);

  const summary = await rawRead(
    page,
    'getLeadSummary',
    '{"leadId":"$lead","sections":["tasks","activity","documents"]}',
  );
  expect(summary).toContain('"status":"ok"');
  expect(summary).toMatch(/pending/i);
  expect(summary).toMatch(/verified/i);
  expectNoContactDetails(summary);
  expect(summary).not.toContain(`${name.toLowerCase().replace(/ /g, '.')}@`);

  await newChat(page);
  const counters = await rawRead(page, 'getInboxCounts');
  expect(counters).toContain('"status":"ok"');
  expect(counters).toMatch(/\d/);
  expectNoContactDetails(counters);

  await newChat(page);
  const plans = await rawRead(page, 'listPlans');
  expect(plans).toContain('Rogers 60GB');
  expect(plans).toContain('Fido 75GB');
  // The owner sees the price; no plan read carries a person's details.
  expectNoContactDetails(plans);

  // The answer shown to the person is the same text: no contact detail on screen.
  const shown = (await page.locator('pre').last().innerText()).replace(/\s+/g, ' ');
  expectNoContactDetails(shown);
});
