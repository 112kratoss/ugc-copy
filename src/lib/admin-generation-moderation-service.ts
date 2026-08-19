import 'server-only';

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Operator removal of a single generation.
 *
 * The database side is where the real work happens: `apply_admin_generation_moderation`
 * hides the generation through `archived_at` (which every public read path
 * already filters) while marking it with `moderation_removed_at`, so the
 * creator's own restore route refuses to undo it. See the migration for why
 * those are two separate columns.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type AdminGenerationModerationAction = 'remove' | 'restore';

export type AdminGenerationModerationResult = {
  status: 'applied' | 'already_applied' | 'not_found' | 'invalid';
  actionId: string | null;
  action: AdminGenerationModerationAction | null;
  error: string | null;
};

export type AdminGenerationModerationEntry = {
  id: string;
  generationId: string;
  reviewerId: string;
  action: AdminGenerationModerationAction;
  reason: string;
  createdAt: string;
};

function invalid(message: string): AdminGenerationModerationResult {
  return { status: 'invalid', actionId: null, action: null, error: message };
}

export async function applyAdminGenerationModeration(
  client: SupabaseClient,
  options: {
    generationId: string;
    reviewerId: string;
    action: AdminGenerationModerationAction;
    reason: string;
    idempotencyKey?: string;
  },
): Promise<AdminGenerationModerationResult> {
  if (!UUID_PATTERN.test(options.generationId)) {
    return invalid('Generation id must be a UUID.');
  }
  if (!UUID_PATTERN.test(options.reviewerId)) {
    return invalid('Reviewer id must be a UUID.');
  }

  const reason = options.reason?.trim() ?? '';
  if (reason.length < 3 || reason.length > 1000) {
    return invalid('A reason of 3 to 1000 characters is required.');
  }

  const { data, error } = await client.rpc('apply_admin_generation_moderation', {
    p_generation_id: options.generationId,
    p_reviewer_id: options.reviewerId,
    p_action: options.action,
    p_reason: reason,
    p_idempotency_key: options.idempotencyKey?.trim() || randomUUID(),
  });
  if (error) throw error;

  const result = (data ?? {}) as Record<string, unknown>;
  const status = result.status;
  if (status !== 'applied' && status !== 'already_applied' && status !== 'not_found' && status !== 'invalid') {
    throw new Error('Generation moderation resolver returned an invalid response.');
  }

  return {
    status,
    actionId: typeof result.action_id === 'string' ? result.action_id : null,
    action: result.action === 'remove' || result.action === 'restore' ? result.action : null,
    error: typeof result.error === 'string' ? result.error : null,
  };
}

export async function listAdminGenerationModeration(
  client: SupabaseClient,
  generationId: string,
): Promise<AdminGenerationModerationEntry[]> {
  const { data, error } = await client
    .from('admin_generation_moderation_actions')
    .select('id, generation_id, reviewer_id, action, reason, created_at')
    .eq('generation_id', generationId)
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) throw error;

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    generationId: String(row.generation_id),
    reviewerId: String(row.reviewer_id),
    action: row.action === 'restore' ? 'restore' : 'remove',
    reason: String(row.reason ?? ''),
    createdAt: String(row.created_at ?? ''),
  }));
}
