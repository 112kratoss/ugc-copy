import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  AiUsageLedgerError,
  markAiUsageSucceeded,
  refundAiUsageLedger,
  startAiUsageLedger,
} from '@/lib/ai-usage-ledger';

function createDb(options?: {
  remainingCredits?: number;
  startError?: Error | null;
  startData?: Record<string, unknown> | null;
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
  const startError = options?.startError ?? null;
  const startData = options?.startData;
  const existingUsageEvent = options?.existingUsageEvent ?? null;

  return {
    rpcCalls,
    inserts,
    updates,
    client: {
      rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });

        if (fn === 'start_ai_usage_event') {
          if (startError) {
            return { data: null, error: startError };
          }

          if (startData !== undefined) {
            return { data: startData, error: null };
          }

          if (existingUsageEvent) {
            if (existingUsageEvent.status === 'pending') {
              return {
                data: {
                  status: 'in_progress',
                  event_id: existingUsageEvent.id,
                  remaining_credits: remainingCredits,
                  cost: existingUsageEvent.cost,
                },
                error: null,
              };
            }

            if (existingUsageEvent.status === 'succeeded') {
              return {
                data: {
                  status: 'succeeded_replay',
                  event_id: existingUsageEvent.id,
                  remaining_credits: remainingCredits,
                  cost: existingUsageEvent.cost,
                  response_payload: existingUsageEvent.response_payload,
                },
                error: null,
              };
            }

            return {
              data: {
                status: 'key_already_used',
                event_id: existingUsageEvent.id,
                remaining_credits: remainingCredits,
                cost: existingUsageEvent.cost,
              },
              error: null,
            };
          }

          if (remainingCredits === -1) {
            return {
              data: {
                status: 'insufficient_credits',
                remaining_credits: 0,
                required_credits: args.p_cost,
              },
              error: null,
            };
          }

          return {
            data: {
              status: 'started',
              event_id: 'usage-1',
              remaining_credits: remainingCredits,
              cost: args.p_cost,
            },
            error: null,
          };
        }

        if (fn === 'deduct_credits') {
          return { data: remainingCredits, error: null };
        }

        if (fn === 'refund_credits' || fn === 'refund_ai_usage_event') {
          return { data: true, error: null };
        }

        if (fn === 'settle_ai_usage_event') {
          return {
            data: {
              status: args.p_outcome,
              settled: true,
              event_id: args.p_event_id,
              remaining_credits: remainingCredits,
            },
            error: null,
          };
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
                    return { data: { id: 'usage-1' }, error: null };
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
  it('starts a paid AI usage event with one atomic database call', async () => {
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      expect(fn).toBe('start_ai_usage_event');
      expect(args).toMatchObject({
        p_user_id: 'user-1',
        p_cost: 2,
        p_feature: 'prompt_enhancement',
        p_provider: 'kie',
        p_model: 'gemini-3-flash',
        p_medium: 'image',
        p_input_prompt: 'Create a product hero shot',
        p_client_request_key_hash: null,
      });
      return {
        data: {
          status: 'started',
          event_id: 'usage-atomic-1',
          remaining_credits: 88,
          cost: 2,
        },
        error: null,
      };
    });
    const from = vi.fn(() => {
      throw new Error('AI usage reservations must not deduct credits and insert ledger rows as separate app-side steps.');
    });

    const ledger = await startAiUsageLedger({ rpc, from } as never, {
      userId: 'user-1',
      cost: 2,
      feature: 'prompt_enhancement',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'image',
      inputPrompt: 'Create a product hero shot',
    });

    expect(ledger).toMatchObject({
      eventId: 'usage-atomic-1',
      remainingCredits: 88,
      cost: 2,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

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
      {
        fn: 'start_ai_usage_event',
        args: {
          p_user_id: 'user-1',
          p_cost: 2,
          p_feature: 'prompt_enhancement',
          p_provider: 'kie',
          p_model: 'gemini-3-flash',
          p_medium: 'image',
          p_input_prompt: 'Create a product hero shot',
          p_client_request_key_hash: null,
        },
      },
    ]);
    expect(db.inserts).toHaveLength(0);
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

    expect(db.rpcCalls[0]?.fn).toBe('start_ai_usage_event');
    expect(db.rpcCalls[0]?.args.p_client_request_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.rpcCalls[0]?.args.p_client_request_key_hash).not.toBe('enhance-click-1');
    expect(db.inserts).toHaveLength(0);
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
    expect(db.rpcCalls).toHaveLength(1);
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

    expect(db.rpcCalls).toHaveLength(1);
    expect(db.inserts).toHaveLength(0);
  });

  it('fails closed without compensating refunds when the atomic start RPC fails', async () => {
    const db = createDb({
      remainingCredits: 88,
      startError: new Error('ai_usage_events unavailable'),
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
      message: 'ai_usage_events unavailable',
    });

    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]?.fn).toBe('start_ai_usage_event');
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
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]?.fn).toBe('start_ai_usage_event');
  });

  it('returns a client error when the atomic start RPC rejects malformed usage input', async () => {
    const db = createDb({
      startData: { status: 'invalid_request' },
    });

    await expect(startAiUsageLedger(db.client as never, {
      userId: 'user-1',
      cost: 8,
      feature: '',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'video',
      inputPrompt: 'Plan a campaign',
    })).rejects.toMatchObject({
      name: 'AiUsageLedgerError',
      status: 400,
      code: 'INVALID_AI_USAGE_REQUEST',
    });
  });

  it('returns an auth-style error when the atomic start RPC cannot find a profile', async () => {
    const db = createDb({
      startData: { status: 'profile_not_found' },
    });

    await expect(startAiUsageLedger(db.client as never, {
      userId: 'user-1',
      cost: 8,
      feature: 'workflow_blueprint',
      provider: 'kie',
      model: 'gemini-3-flash',
      medium: 'video',
      inputPrompt: 'Plan a campaign',
    })).rejects.toMatchObject({
      name: 'AiUsageLedgerError',
      status: 401,
      code: 'AI_USAGE_PROFILE_NOT_FOUND',
    });
  });

  it('settles a successful AI usage event atomically through the state-machine RPC', async () => {
    const db = createDb({ remainingCredits: 88 });

    const result = await markAiUsageSucceeded(db.client as never, {
      eventId: 'usage-1',
      remainingCredits: 88,
      cost: 2,
      userId: 'user-1',
    }, 'enhanced prompt', { enhancedPrompt: 'enhanced prompt' });

    expect(result).toEqual({
      status: 'succeeded',
      eventId: 'usage-1',
      settled: true,
      remainingCredits: 88,
    });
    expect(db.rpcCalls).toEqual([{
      fn: 'settle_ai_usage_event',
      args: {
        p_event_id: 'usage-1',
        p_outcome: 'succeeded',
        p_output_text: 'enhanced prompt',
        p_response_payload: { enhancedPrompt: 'enhanced prompt' },
        p_error_message: null,
      },
    }]);
    expect(db.updates).toHaveLength(0);
  });

  it('refunds credits and records the failure in the same retry-safe RPC', async () => {
    const db = createDb({ remainingCredits: 90 });

    await expect(refundAiUsageLedger(db.client as never, {
      eventId: 'usage-1',
      remainingCredits: 88,
      cost: 2,
      userId: 'user-1',
    }, new Error('provider timeout'))).resolves.toMatchObject({
      status: 'refunded',
      eventId: 'usage-1',
    });

    expect(db.rpcCalls).toEqual([{
      fn: 'settle_ai_usage_event',
      args: {
        p_event_id: 'usage-1',
        p_outcome: 'refunded',
        p_output_text: null,
        p_response_payload: null,
        p_error_message: 'provider timeout',
      },
    }]);
    expect(db.updates).toHaveLength(0);
  });

  it('fails closed when the database reports an incompatible AI usage transition', async () => {
    const client = {
      rpc: vi.fn(async () => ({
        data: {
          status: 'transition_conflict',
          settled: false,
          event_id: 'usage-1',
          current_status: 'refunded',
        },
        error: null,
      })),
    };

    await expect(markAiUsageSucceeded(client as never, {
      eventId: 'usage-1',
      remainingCredits: 88,
      cost: 2,
      userId: 'user-1',
    }, 'enhanced prompt')).rejects.toMatchObject({
      name: 'AiUsageLedgerError',
      code: 'USAGE_EVENT_FAILED',
      status: 500,
    });
  });
});
