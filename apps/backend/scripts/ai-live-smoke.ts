/** Opt-in provider smoke using only in-memory synthetic facts, never a CRM database. */
import { tool } from 'ai';
import { z } from 'zod';
import { createGatewayEngine } from '../src/ai/engine.js';

const key = process.env['AI_GATEWAY_API_KEY'];
const modelId = process.env['AI_GATEWAY_MODEL'];
if (process.env['AI_LIVE_SMOKE'] !== 'synthetic' || !key || !modelId) {
  process.stderr.write(
    'Not run. Set AI_LIVE_SMOKE=synthetic and supply the Gateway key/model through secure environment variables.\n',
  );
  process.exit(2);
}
let calls = 0;
let answer = '';
try {
  const engine = createGatewayEngine({ apiKey: key, modelId });
  for await (const event of engine.stream({
    system:
      'You are testing synthetic data only. Call getSiteOverview before answering. Return the exact received count and explain drafts are included. Do not invent facts.',
    messages: [
      { role: 'user', text: 'How many leads did Synthetic Test Site receive in the last 30 days?' },
    ],
    signal: AbortSignal.timeout(60000),
    tools: {
      getSiteOverview: tool({
        inputSchema: z.object({}).strict(),
        execute: async () => {
          calls += 1;
          if (calls > 6) throw new Error('synthetic tool budget');
          return {
            status: 'ok',
            site: 'Synthetic Test Site',
            period: 'last 30 days',
            received: 3,
            submitted: 2,
            draftsIncluded: true,
          };
        },
      }),
    },
  }))
    if (event.type === 'text') answer += event.text;
  const passed = calls > 0 && /\b(3|three)\b/i.test(answer) && /draft/i.test(answer);
  process.stdout.write(
    JSON.stringify({
      date: new Date().toISOString(),
      modelId,
      syntheticOnly: true,
      toolCalls: calls,
      passed,
    }) + '\n',
  );
  if (!passed) process.exitCode = 1;
} catch {
  process.stderr.write('Synthetic Gateway smoke failed; no provider error body logged.\n');
  process.exitCode = 1;
}
