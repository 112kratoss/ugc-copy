import { resolveLinkedAccountIds } from '@/lib/account-identity';
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  GENERATION_LIFECYCLE_MUTATION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';

export type GenerationLifecycleResult =
  | {
    ok: true;
    body: {
      success: true;
      archived?: true;
      restored?: true;
    };
  }
  | {
    ok: false;
    status: 404 | 500;
    body: { error: string };
  }
  | {
    ok: false;
    rateLimitError: BackendRateLimitError;
  };

async function enforceGenerationLifecycleRateLimit(
  adminSupabase: SupabaseClient,
  ownerUserId: string,
) {
  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...GENERATION_LIFECYCLE_MUTATION_RATE_LIMIT,
      key: ownerUserId,
    });
    return null;
  } catch (error) {
    return error;
  }
}

export async function archiveOwnerGenerationForRoute({
  adminSupabase,
  generationId,
  now = () => new Date(),
  ownerUserId,
}: {
  adminSupabase: SupabaseClient;
  generationId: string;
  now?: () => Date;
  ownerUserId: string;
}): Promise<GenerationLifecycleResult> {
  const rateLimitError = await enforceGenerationLifecycleRateLimit(adminSupabase, ownerUserId);
  if (rateLimitError) {
    if (rateLimitError instanceof BackendRateLimitError) {
      return { ok: false, rateLimitError };
    }
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to archive creation.' },
    };
  }

  const { data, error } = await adminSupabase
    .from('generations')
    .update({
      archived_at: now().toISOString(),
      archived_by_user_id: ownerUserId,
      is_public: false,
      showcase_asset_path: null,
    })
    .eq('id', generationId)
    .in('user_id', await resolveLinkedAccountIds(adminSupabase, ownerUserId))
    .is('template_run_id', null)
    .is('template_run_step_id', null)
    .is('archived_at', null)
    .select('id')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to archive creation.' },
    };
  }

  if (!data) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Creation not found.' },
    };
  }

  return { ok: true, body: { success: true, archived: true } };
}

export async function restoreOwnerGenerationForRoute({
  adminSupabase,
  generationId,
  ownerUserId,
}: {
  adminSupabase: SupabaseClient;
  generationId: string;
  ownerUserId: string;
}): Promise<GenerationLifecycleResult> {
  const rateLimitError = await enforceGenerationLifecycleRateLimit(adminSupabase, ownerUserId);
  if (rateLimitError) {
    if (rateLimitError instanceof BackendRateLimitError) {
      return { ok: false, rateLimitError };
    }
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to restore creation.' },
    };
  }

  const { data, error } = await adminSupabase
    .from('generations')
    .update({
      archived_at: null,
      archived_by_user_id: null,
    })
    .eq('id', generationId)
    .in('user_id', await resolveLinkedAccountIds(adminSupabase, ownerUserId))
    .is('template_run_id', null)
    .is('template_run_step_id', null)
    .not('archived_at', 'is', null)
    .select('id')
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to restore creation.' },
    };
  }

  if (!data) {
    return {
      ok: false,
      status: 404,
      body: { error: 'Creation not found.' },
    };
  }

  return { ok: true, body: { success: true, restored: true } };
}
