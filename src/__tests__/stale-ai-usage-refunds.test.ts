import { describe, expect, it, vi } from 'vitest';

import {
  AI_USAGE_PENDING_REFUND_AFTER_MINUTES,
  AI_USAGE_STALE_PENDING_REFUND_MESSAGE,
  hasStaleAiUsageCharges,
  refundStaleAiUsageCharges,
} from '@/lib/stale-ai-usage-refunds';

type Result = { data: unknown; error: unknown };

function createClient(queryResults: Result[], rpcResults: Result[] = []) {
  const builder: Record<string, unknown> = {};
  const select = vi.fn(() => builder);
  const eq = vi.fn(() => builder);
  const lt = vi.fn(() => builder);
  const order = vi.fn(() => builder);
  const limit = vi.fn(async () => {
    const result = queryResults.shift();
    if (!result) throw new Error('Unexpected query');
    return result;
  });
  Object.assign(builder, { select, eq, lt, order, limit });
  const from = vi.fn(() => builder);
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => {
    void _name; void _args;
    const result = rpcResults.shift();
    if (!result) throw new Error('Unexpected RPC');
    return result;
  });
  return { client: { from, rpc }, from, select, eq, lt, order, limit, rpc };
}

const NOW_MS = Date.UTC(2026, 10, 27, 12, 0, 0);

describe('stale AI usage refunds', () => {
  it('refunds a charge left pending well past any request that could still settle it', () => {
    // The enhance-prompt, workflow-assistant and workflow-blueprint routes run
    // for at most Vercel's 300 s; health reports a charge still pending after 35 min,
    // two runs of this refund later (backend-health.test.ts holds the two together).
    expect(AI_USAGE_PENDING_REFUND_AFTER_MINUTES).toBe(10);
  });

  it('refunds pending charges older than the safe age through the idempotent settlement', async () => {
    const db = createClient(
      [{
        data: [
          { id: 'event-1', feature: 'prompt_enhancement', created_at: '2026-11-27T11:00:00.000Z' },
          { id: 'event-2', feature: 'workflow_assistant', created_at: '2026-11-27T11:10:00.000Z' },
          { id: 'event-3', feature: 'workflow_blueprint', created_at: '2026-11-27T11:20:00.000Z' },
          { id: 'event-4', feature: 'prompt_enhancement', created_at: '2026-11-27T11:30:00.000Z' },
        ],
        error: null,
      }],
      [
        { data: { status: 'refunded', settled: true, event_id: 'event-1' }, error: null },
        // The request settled it first: nothing more to do.
        { data: { status: 'transition_conflict', settled: false, event_id: 'event-2', current_status: 'succeeded' }, error: null },
        { data: null, error: { message: 'database unavailable' } },
        { data: { status: 'already_refunded', settled: false, event_id: 'event-4' }, error: null },
      ],
    );

    await expect(refundStaleAiUsageCharges({ client: db.client as never, nowMs: NOW_MS }))
      .resolves.toEqual({ eligible: 4, refunded: 1, skipped: 2, failed: 1, deferred: 0 });

    expect(db.from).toHaveBeenCalledWith('ai_usage_events');
    expect(db.eq).toHaveBeenCalledWith('status', 'pending');
    expect(db.lt).toHaveBeenCalledWith('created_at', '2026-11-27T11:50:00.000Z');
    expect(db.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(db.rpc).toHaveBeenNthCalledWith(1, 'settle_ai_usage_event', {
      p_event_id: 'event-1',
      p_outcome: 'refunded',
      p_output_text: null,
      p_response_payload: null,
      p_error_message: AI_USAGE_STALE_PENDING_REFUND_MESSAGE,
    });
    expect(db.rpc).toHaveBeenCalledTimes(4);
  });

  it('defers what it cannot start before the deadline', async () => {
    const db = createClient([{ data: [{ id: 'event-1', feature: 'x', created_at: '2026-11-27T11:00:00.000Z' }], error: null }]);
    await expect(refundStaleAiUsageCharges({ client: db.client as never, nowMs: NOW_MS, deadlineMs: Date.now() - 1 }))
      .resolves.toMatchObject({ eligible: 1, deferred: 1, refunded: 0 });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('throws when the batch cannot be read', async () => {
    const db = createClient([{ data: null, error: { message: 'boom' } }]);
    await expect(refundStaleAiUsageCharges({ client: db.client as never, nowMs: NOW_MS })).rejects.toMatchObject({ message: 'boom' });
  });

  it('probes with a one-row indexed read', async () => {
    const db = createClient([{ data: [{ id: 'event-1' }], error: null }]);
    await expect(hasStaleAiUsageCharges(db.client as never, { nowMs: NOW_MS })).resolves.toBe(true);
    expect(db.limit).toHaveBeenCalledWith(1);
    expect(db.lt).toHaveBeenCalledWith('created_at', '2026-11-27T11:50:00.000Z');
  });
});
