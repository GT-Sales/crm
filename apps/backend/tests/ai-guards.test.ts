import { describe, expect, it } from 'vitest';
import { AI_CHAT_LIMITS } from '@gt-sales/contracts';
import type { RateLimitInput } from '@gt-sales/db';

import { chargeDailyAttachmentBytes } from '../src/ai/limits.js';
import { selectedChoiceText } from '../src/routes/ai-assistant.js';

const SCOPE = {
  workspaceId: '10000000-0000-4000-8000-000000000e91',
  actorId: '20000000-0000-4000-8000-000000000e91',
};
const MIB = AI_CHAT_LIMITS.attachmentBudgetUnitBytes;

describe('the daily attachment budget (audit B7)', () => {
  it('is 300 MiB per member per site, charged in whole MiB', () => {
    expect(AI_CHAT_LIMITS.attachmentBytesPerActorPerDay).toBe(300 * 1024 * 1024);
    expect(MIB).toBe(1024 * 1024);
  });

  it('charges a turn’s bytes rounded up to whole units, one limiter hit each', async () => {
    const seen: RateLimitInput[] = [];
    const allow = async (input: RateLimitInput) => {
      seen.push(input);
      return { allowed: true, retryAfterSeconds: 0 };
    };
    expect(await chargeDailyAttachmentBytes(allow, SCOPE, 0)).toBe('allowed');
    expect(seen).toHaveLength(0);
    expect(await chargeDailyAttachmentBytes(allow, SCOPE, 1)).toBe('allowed');
    expect(seen).toHaveLength(1);
    expect(await chargeDailyAttachmentBytes(allow, SCOPE, 2 * MIB + 1)).toBe('allowed');
    expect(seen).toHaveLength(4);
    expect(seen[0]).toEqual({
      bucketKey: `ai_file_bytes:${SCOPE.actorId}:${SCOPE.workspaceId}`,
      windowSeconds: 86_400,
      maxCount: 300,
    });
  });

  it('is spent at the first refused unit and asks no further', async () => {
    let hits = 0;
    const result = await chargeDailyAttachmentBytes(
      async () => {
        hits += 1;
        return { allowed: hits < 2, retryAfterSeconds: hits < 2 ? 0 : 60 };
      },
      SCOPE,
      5 * MIB,
    );
    expect(result).toBe('spent');
    expect(hits).toBe(2);
  });

  it('fails closed when the limiter cannot be reached', async () => {
    expect(
      await chargeDailyAttachmentBytes(
        async () => {
          throw new Error('limiter down');
        },
        SCOPE,
        MIB,
      ),
    ).toBe('unavailable');
  });
});

describe('a clicked follow-up choice (audit B8)', () => {
  it('reaches the model marked as an option it offered, with the choice on its own line', () => {
    const text = selectedChoiceText('Tomorrow');
    expect(text.split('\n')).toEqual([
      '[The person picked this option from the choices you offered earlier in this chat; it is your wording, not a new request from them]',
      'Tomorrow',
    ]);
  });
});
