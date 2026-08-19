import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Triage for the inbound contact queue.
 *
 * The toggle is naturally idempotent — it asserts a state rather than appending
 * to a ledger — so unlike credits or sanctions it needs no idempotency key.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type AdminContactTriageResult = {
  status: 'applied' | 'not_found' | 'invalid';
  handled: boolean | null;
  error: string | null;
};

export async function setContactMessageHandled(
  client: SupabaseClient,
  options: {
    messageId: string;
    reviewerId: string;
    handled: boolean;
    note?: string | null;
  },
): Promise<AdminContactTriageResult> {
  if (!UUID_PATTERN.test(options.messageId)) {
    return { status: 'invalid', handled: null, error: 'Message id must be a UUID.' };
  }
  if (!UUID_PATTERN.test(options.reviewerId)) {
    return { status: 'invalid', handled: null, error: 'Reviewer id must be a UUID.' };
  }

  const note = options.note?.trim() ?? '';
  if (note.length > 1000) {
    return { status: 'invalid', handled: null, error: 'Note must be 1000 characters or fewer.' };
  }

  const { data, error } = await client.rpc('set_contact_message_handled', {
    p_message_id: options.messageId,
    p_reviewer_id: options.reviewerId,
    p_handled: options.handled,
    // Reopening clears the note, so an empty string must reach the RPC as null
    // rather than as a zero-length note that fails the length check.
    p_note: options.handled && note ? note : null,
  });
  if (error) throw error;

  const result = (data ?? {}) as Record<string, unknown>;
  const status = result.status;
  if (status !== 'applied' && status !== 'not_found' && status !== 'invalid') {
    throw new Error('Contact triage resolver returned an invalid response.');
  }

  return {
    status,
    handled: typeof result.handled === 'boolean' ? result.handled : null,
    error: typeof result.error === 'string' ? result.error : null,
  };
}
