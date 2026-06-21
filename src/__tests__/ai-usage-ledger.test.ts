import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  AiUsageLedgerError,
  startAiUsageLedger,
} from '@/lib/ai-usage-ledger';

function createDb(options?: {
  remainingCredits?: number;
  insertError?: Error | null;
  existingUsageEvent?: {
    id: string;
    user_id: string;
    feature: string;
    client_request_key_hash: string;
    status: string;
    cost: number;
    response_payload?: Record<string, unknown> | null;
  } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const remainingCredits = options?.remainingCredits ?? 42;
  const insertError = options?.insertError ?? null;
  const existingUsageEvent = options?.existingUsageEvent ?? null;

  return {
    rpcCalls,
    inserts,
    updates,
    client: {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });

        if (fn === 'deduct_credits') {
          return { data: remainingCredits, error: null };
        }

        if (fn === 'refund_credits' || fn === 'refund_ai_usage_event') {
          return { data: true, error: null };
        }

        throw new Error(`Unexpected rpc: ${fn}`);
      }),
      from: vi.fn((table: string) => {
        if (table === 'profiles') {
          return createSelectChain([{ id: 'user-1', credits: remainingCredits }]);
        }

        if (table !== 'ai_usage_events') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
          select() {
            return createSelectChain(existingUsageEvent ? [existingUsageEvent] : []);
          },
          insert(record: Record<string, unknown>) {
            inserts.push(record);
            return {
              select() {
                return {
                  async single() {
                    return insertError
                      ? { data: null, error: insertError }
                      : { data: { id: 'usage-1' }, error: null };
                  },
                };
              },
            };
          },
          update(record: Record<string, unknown>) {
            updates.push(record);
            return {
              async eq() {
                return { error: null };
              },
            };
          },
        };
      }),
    },
  };
}

function createSelectChain(rows: Array<Record<string, unknown>>) {
  const filters: Array<{ column: string; value: unknown }> = [];
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push({ column, value });
      return chain;
    }),
    maybeSingle: vi.fn(async () => ({
      data: rows.find((row) => filters.every((filter) => row[filter.column] === filter.value)) ?? null,
      error: null,
    })),
  };

  return chain;
}

function testKeyHash(userId: string, feature: string, key: string) {
  return createHash('sha256')
    .update(userId)
    .update('\0')
    .update(feature)
    .update('\0')
    .update(key)
    .digest('hex');
}

describe('AI usage ledger', () => {
  it('charges credits and creates a pending usage event', async () => {
    const db = createDb({ remainingCredits: 88 });

    const ledger = await startAiUsageLedger(db.client as never, {
      userId: 'user-1',
      cost: 2,
      feature: 'prompt_enhancement',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'image',
      inputPrompt: 'Create a product hero shot',
    });

    expect(ledger).toMatchObject({
      eventId: 'usage-1',
      remainingCredits: 88,
      cost: 2,
    });
    expect(db.rpcCalls).toEqual([
      { fn: 'deduct_credits', args: { p_user_id: 'user-1', p_cost: 2 } },
    ]);
    expect(db.inserts[0]).toMatchObject({
      user_id: 'user-1',
      feature: 'prompt_enhancement',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'image',
      cost: 2,
      status: 'pending',
      input_prompt: 'Create a product hero shot',
    });
  });

  it('stores only a hashed idempotency key when starting a paid AI request', async () => {
    const db = createDb({ remainingCredits: 88 });

    await startAiUsageLedger(db.client as never, {
      userId: 'user-1',
      cost: 2,
      feature: 'prompt_enhancement',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'image',
      inputPrompt: 'Create a product hero shot',
      idempotencyKey: 'enhance-click-1',
    });

    expect(db.inserts[0]).toMatchObject({
      user_id: 'user-1',
      feature: 'prompt_enhancement',
    });
    expect(db.inserts[0].client_request_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.inserts[0].client_request_key_hash).not.toBe('enhance-click-1');
  });

  it('replays a completed paid AI request without deducting credits again', async () => {
    const db = createDb({
      remainingCredits: 77,
      existingUsageEvent: {
        id: 'usage-existing',
        user_id: 'user-1',
        feature: 'prompt_enhancement',
        client_request_key_hash: testKeyHash('user-1', 'prompt_enhancement', 'enhance-click-1'),
        status: 'succeeded',
        cost: 2,
        response_payload: {
          enhancedPrompt: 'existing enhanced prompt',
          remainingCredits: 80,
        },
      },
    });

    const ledger = await startAiUsageLedger(db.client as never, {
      userId: 'user-1',
      cost: 2,
      feature: 'prompt_enhancement',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'image',
      inputPrompt: 'Create a product hero shot',
      idempotencyKey: 'enhance-click-1',
    });

    expect(ledger).toMatchObject({
      eventId: 'usage-existing',
      remainingCredits: 77,
      cost: 2,
      idempotentReplay: true,
      responsePayload: {
        enhancedPrompt: 'existing enhanced prompt',
        remainingCredits: 80,
      },
    });
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('rejects an idempotent paid AI request while the original request is still pending', async () => {
    const db = createDb({
      existingUsageEvent: {
        id: 'usage-pending',
        user_id: 'user-1',
        feature: 'workflow_blueprint',
        client_request_key_hash: testKeyHash('user-1', 'workflow_blueprint', 'blueprint-click-1'),
        status: 'pending',
        cost: 6,
        response_payload: null,
      },
    });

    await expect(startAiUsageLedger(db.client as never, {
      userId: 'user-1',
      cost: 6,
      feature: 'workflow_blueprint',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'video',
      inputPrompt: 'Plan a campaign',
      idempotencyKey: 'blueprint-click-1',
    })).rejects.toMatchObject({
      name: 'AiUsageLedgerError',
      status: 409,
      code: 'AI_USAGE_IN_PROGRESS',
    });

    expect(db.rpcCalls).toHaveLength(0);
    expect(db.inserts).toHaveLength(0);
  });

  it('refunds immediately and fails closed when usage event creation fails after charging', async () => {
    const db = createDb({
      remainingCredits: 88,
      insertError: new Error('ai_usage_events unavailable'),
    });

    await expect(startAiUsageLedger(db.client as never, {
      userId: 'user-1',
      cost: 5,
      feature: 'workflow_assistant',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'video',
      inputPrompt: 'Plan a workflow',
    })).rejects.toMatchObject({
      name: 'AiUsageLedgerError',
      status: 500,
      message: 'Failed to record AI usage.',
    });

    expect(db.rpcCalls).toEqual([
      { fn: 'deduct_credits', args: { p_user_id: 'user-1', p_cost: 5 } },
      { fn: 'refund_credits', args: { p_user_id: 'user-1', p_amount: 5 } },
    ]);
  });

  it('does not create usage events when the user has insufficient credits', async () => {
    const db = createDb({ remainingCredits: -1 });

    await expect(startAiUsageLedger(db.client as never, {
      userId: 'user-1',
      cost: 8,
      feature: 'workflow_blueprint',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'video',
      inputPrompt: 'Plan a campaign',
    })).rejects.toBeInstanceOf(AiUsageLedgerError);

    expect(db.inserts).toHaveLength(0);
    expect(db.rpcCalls).toEqual([
      { fn: 'deduct_credits', args: { p_user_id: 'user-1', p_cost: 8 } },
    ]);
  });
});
