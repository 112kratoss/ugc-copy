import { describe, expect, it, vi } from 'vitest';

import {
  AiUsageLedgerError,
  startAiUsageLedger,
} from '@/lib/ai-usage-ledger';

function createDb(options?: {
  remainingCredits?: number;
  insertError?: Error | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const remainingCredits = options?.remainingCredits ?? 42;
  const insertError = options?.insertError ?? null;

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
        if (table !== 'ai_usage_events') {
          throw new Error(`Unexpected table: ${table}`);
        }

        return {
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
