import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  createBackendClient,
  walkDraftSteps,
  type AiAutomationProposal,
  type AiStreamPart,
} from '@gt-sales/contracts';
import { z } from 'zod';

const settings = z
  .object({
    baseUrl: z.url(),
    credential: z.string().min(1),
    workspaceId: z.uuid(),
    ack: z.literal('dedicated-test-site'),
  })
  .parse({
    baseUrl: process.env['AI_EVAL_BACKEND_URL'],
    credential: process.env['AI_EVAL_STAFF_TOKEN'],
    workspaceId: process.env['AI_EVAL_WORKSPACE_ID'],
    ack: process.env['AI_EVAL_ACK'],
  });
const fixtures = z
  .object({
    cases: z.array(
      z.object({
        id: z.string(),
        request: z.string(),
        expected: z.object({
          outcome: z.enum(['proposal', 'edit', 'clarification', 'read', 'unsupported']),
          kind: z.string().optional(),
        }),
      }),
    ),
  })
  .parse(
    JSON.parse(
      await readFile(
        new URL('../../../docs/evals/automation-authoring-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
const client = createBackendClient(settings);
const capabilities = await client.staff.aiCapabilities(settings.workspaceId);
if (!capabilities.available || !capabilities.automationAuthoring)
  throw new Error('Enable authoring on the dedicated evaluation site first');
const selected = process.env['AI_EVAL_CASE'];
let failures = 0;
for (const fixture of fixtures.cases.filter((c) => !selected || c.id === selected)) {
  const parts: AiStreamPart[] = [];
  try {
    for await (const part of client.staff.askAi(settings.workspaceId, {
      requestId: randomUUID(),
      message: fixture.request,
      history: [],
    }))
      parts.push(part);
    const proposals: AiAutomationProposal[] = parts.flatMap((p) =>
      p.type === 'automation_proposals' ? p.proposals : [],
    );
    const ordinaryActions = parts.some((p) => p.type === 'actions' && p.actions.length > 0);
    const expected = fixture.expected;
    let pass = !parts.some((p) => p.type === 'error') && !ordinaryActions;
    if (expected.outcome === 'proposal' || expected.outcome === 'edit') {
      pass &&= proposals.length > 0;
      if (expected.outcome === 'edit') pass &&= proposals.every((p) => !!p.target && !!p.before);
      if (expected.kind)
        pass &&= proposals.some((p) => {
          const kinds: string[] = [];
          if (p.draft.definition.trigger) kinds.push(p.draft.definition.trigger.kind);
          walkDraftSteps(p.draft.definition.steps, (s) => kinds.push(s.kind));
          return kinds.includes(expected.kind ?? '');
        });
    } else {
      pass &&= proposals.length === 0;
      if (expected.outcome === 'clarification') pass &&= parts.some((p) => p.type === 'follow_up');
    }
    // Only fixture IDs and checks leave the runner. Tokens, prompts, drafts,
    // member names and provider bodies are never printed. No save endpoint exists here.
    process.stdout.write(
      JSON.stringify({ id: fixture.id, pass, proposals: proposals.length }) + '\n',
    );
    if (!pass) failures++;
  } catch {
    failures++;
    process.stdout.write(
      JSON.stringify({ id: fixture.id, pass: false, error: 'evaluation_request_failed' }) + '\n',
    );
  }
  if (!selected) await new Promise((resolve) => setTimeout(resolve, 15_000));
}
process.exitCode = failures ? 1 : 0;
