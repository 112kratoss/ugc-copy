import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { setContactMessageHandled } from '@/lib/admin-contact-triage-service';
import { applyAdminGenerationModeration } from '@/lib/admin-generation-moderation-service';

const GENERATION_ID = '66666666-0000-4000-8000-000000000001';
const MESSAGE_ID = '55555555-0000-4000-8000-000000000001';
const REVIEWER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function rpcClient(response: Record<string, unknown>, calls: unknown[][] = []) {
  return {
    rpc: (fn: string, args: unknown) => {
      calls.push([fn, args]);
      return Promise.resolve({ data: response, error: null });
    },
  } as unknown as SupabaseClient;
}

describe('applyAdminGenerationModeration', () => {
  it('forwards a removal with its rationale', async () => {
    const calls: unknown[][] = [];
    const client = rpcClient({ status: 'applied', action: 'remove', action_id: 'a1' }, calls);

    const result = await applyAdminGenerationModeration(client, {
      generationId: GENERATION_ID,
      reviewerId: REVIEWER_ID,
      action: 'remove',
      reason: '  Depicts a real person without consent.  ',
      idempotencyKey: 'k1',
    });

    expect(calls[0][0]).toBe('apply_admin_generation_moderation');
    expect(calls[0][1]).toMatchObject({
      p_generation_id: GENERATION_ID,
      p_action: 'remove',
      p_reason: 'Depicts a real person without consent.',
      p_idempotency_key: 'k1',
    });
    expect(result.status).toBe('applied');
  });

  it('requires a rationale before any database call', async () => {
    const rpc = vi.fn();
    const result = await applyAdminGenerationModeration({ rpc } as unknown as SupabaseClient, {
      generationId: GENERATION_ID, reviewerId: REVIEWER_ID, action: 'remove', reason: 'no',
    });

    expect(result.status).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID generation id', async () => {
    const rpc = vi.fn();
    const result = await applyAdminGenerationModeration({ rpc } as unknown as SupabaseClient, {
      generationId: 'nope', reviewerId: REVIEWER_ID, action: 'remove', reason: 'Spam.',
    });

    expect(result.status).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('mints an idempotency key when none is supplied', async () => {
    const calls: unknown[][] = [];
    const client = rpcClient({ status: 'applied', action: 'remove' }, calls);

    await applyAdminGenerationModeration(client, {
      generationId: GENERATION_ID, reviewerId: REVIEWER_ID, action: 'remove', reason: 'Spam.',
    });

    expect(String((calls[0][1] as Record<string, unknown>).p_idempotency_key)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('setContactMessageHandled', () => {
  it('sends the note when marking handled', async () => {
    const calls: unknown[][] = [];
    const client = rpcClient({ status: 'applied', handled: true }, calls);

    await setContactMessageHandled(client, {
      messageId: MESSAGE_ID, reviewerId: REVIEWER_ID, handled: true, note: '  Refunded.  ',
    });

    expect(calls[0][1]).toMatchObject({ p_handled: true, p_note: 'Refunded.' });
  });

  /**
   * The column's CHECK requires 1..1000 characters, so an empty string would
   * fail the constraint rather than reading as "no note".
   */
  it('sends null rather than an empty note', async () => {
    const calls: unknown[][] = [];
    const client = rpcClient({ status: 'applied', handled: true }, calls);

    await setContactMessageHandled(client, {
      messageId: MESSAGE_ID, reviewerId: REVIEWER_ID, handled: true, note: '   ',
    });

    expect((calls[0][1] as Record<string, unknown>).p_note).toBeNull();
  });

  it('drops any note when reopening, since the state is being cleared', async () => {
    const calls: unknown[][] = [];
    const client = rpcClient({ status: 'applied', handled: false }, calls);

    await setContactMessageHandled(client, {
      messageId: MESSAGE_ID, reviewerId: REVIEWER_ID, handled: false, note: 'ignored',
    });

    expect(calls[0][1]).toMatchObject({ p_handled: false, p_note: null });
  });

  it('rejects an over-long note before hitting the constraint', async () => {
    const rpc = vi.fn();
    const result = await setContactMessageHandled({ rpc } as unknown as SupabaseClient, {
      messageId: MESSAGE_ID, reviewerId: REVIEWER_ID, handled: true, note: 'x'.repeat(1001),
    });

    expect(result.status).toBe('invalid');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('surfaces a missing message as not_found', async () => {
    const client = rpcClient({ status: 'not_found' });

    const result = await setContactMessageHandled(client, {
      messageId: MESSAGE_ID, reviewerId: REVIEWER_ID, handled: true,
    });

    expect(result.status).toBe('not_found');
  });
});
