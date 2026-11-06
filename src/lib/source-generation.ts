import type { SupabaseClient } from '@supabase/supabase-js';

import { isOwnOrLinkedAccountId } from '@/lib/account-identity';
import { logBackendError } from '@/lib/backend-logger';
import { resolveRemixAccess, type RemixAccessGeneration } from '@/lib/remix-access';
import { isTemplateResultGeneration } from '@/lib/template-result';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SourceGenerationValidationError extends Error {
  status: number;
  /** The refusal's own code, where a client tells it apart; the route answers the generic one otherwise. */
  code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = 'SourceGenerationValidationError';
    this.status = status;
    if (code) this.code = code;
  }
}

export async function resolveSourceGenerationId(
  adminSupabase: SupabaseClient,
  userId: string,
  rawSourceGenerationId: unknown,
  {
    callerIsGuest,
  }: {
    /** The caller is a guest identity (`isGuestUser`), which Remix serves only its own creations. */
    callerIsGuest: boolean;
  },
): Promise<string | null> {
  if (typeof rawSourceGenerationId !== 'string' || rawSourceGenerationId.trim().length === 0) {
    return null;
  }

  // `generations.id` is a uuid column, so any other shape can never resolve.
  // Rejecting it up front keeps malformed client input out of the query and
  // avoids uuid cast failures surfacing as server errors.
  const sourceGenerationId = rawSourceGenerationId.trim();
  if (!UUID_PATTERN.test(sourceGenerationId)) {
    throw new SourceGenerationValidationError('Source generation not found or inaccessible.');
  }

  // Callers MUST pass a service-role client: authenticated clients hold no
  // read grant on `is_public`, so a user-scoped read errors for every row.
  // The ownership/public check below is therefore the sole visibility gate.
  // Keeping the filter out of the query also avoids interpolating values into
  // a PostgREST `.or()` expression, which postgrest-js does not escape.
  const { data, error } = await adminSupabase
    .from('generations')
    .select('id, user_id, is_public, template_run_id, template_run_step_id, remix_recipe_mode')
    .eq('id', sourceGenerationId)
    .maybeSingle();

  if (error) {
    throw new SourceGenerationValidationError('Failed to validate the remix source.', 500);
  }

  // A private source is still the caller's own when it was made under a guest
  // identity since linked to them. Recreate restores exactly those creations,
  // and they keep their guest UUID for good.
  if (!data || (!data.is_public && !(await isOwnOrLinkedAccountId(adminSupabase, userId, data.user_id)))) {
    throw new SourceGenerationValidationError('Source generation not found or inaccessible.');
  }

  // Nobody remixes a template's result (`remix-access.ts`), but a create page
  // sends the `remix` id of its own URL with every start. The run goes ahead as
  // an ordinary one, and the result is never credited with a remix.
  if (isTemplateResultGeneration(data)) return null;

  // The id kept here credits the post with a remix and tells its creator
  // (`record_completed_post_remix`, `notifyCompletedRemix`). So a public source
  // counts only when Remix would hand the caller its recipe now: the post
  // exposed, no block between the two, no recipe locked to the caller. The
  // create page sends its URL's id even after Remix refused, so a refusal
  // starts an ordinary run, as a template result does.
  if (data.is_public) {
    // Remix serves a guest only its own creations, and `resolveRemixAccess`
    // does not ask who is a guest: `/api/remix-source` answers a guest 403 for
    // anyone else's before asking it, as here, and the proxy keeps guests off
    // `/api/showcase/remix`.
    if (callerIsGuest && !(await isOwnOrLinkedAccountId(adminSupabase, userId, data.user_id))) return null;
    if (!(await remixWouldBeAllowed(adminSupabase, userId, data))) {
      // The link also carries the run's remix terms (`record_generation_remix_terms`):
      // a run that left it would go out free. Someone who holds this post's
      // recipe on paid terms has its prompt in their creator: they paid for it,
      // or claimed it free and it is paid now (owner, 2026-11-06: "B's recipe
      // must be paid"). When they can no longer remix it (a block since, the post
      // archived, the recipe taken down) the run does not start from it rather
      // than start as an ordinary one (owner, 2026-11-05: paid stays paid).
      // Anyone else's refused remix still starts as an ordinary run, as before:
      // they never had the prompt.
      if (await holdsPaidRecipeOf(adminSupabase, userId, sourceGenerationId)) {
        throw new SourceGenerationValidationError(
          REMIX_SOURCE_NO_LONGER_REMIXABLE,
          409,
          REMIX_SOURCE_NO_LONGER_REMIXABLE_CODE,
        );
      }
      return null;
    }
  }

  return sourceGenerationId;
}

export const REMIX_SOURCE_NO_LONGER_REMIXABLE_CODE = 'REMIX_SOURCE_NO_LONGER_REMIXABLE';
export const REMIX_SOURCE_NO_LONGER_REMIXABLE =
  "This post can't be remixed any more, so this run can't start from it. Your recipe is still in your library: start a new creation from it.";

/**
 * Whether the remix may go ahead now. The answer credits the post and tells its
 * creator, and the link it keeps carries the run's terms, so a check that
 * cannot be made keeps the link: crediting a remix by mistake costs less than a
 * paid version going out free.
 */
async function remixWouldBeAllowed(
  adminSupabase: SupabaseClient,
  userId: string,
  generation: RemixAccessGeneration,
) {
  try {
    const access = await resolveRemixAccess({ adminSupabase, viewerUserId: userId, generation });
    return access.allowed;
  } catch (error) {
    logBackendError('failed_to_check_remix_access_for_source_generation', { error });
    return true;
  }
}

/**
 * Whether the caller, or a guest linked to them, holds the recipe on the source's post on paid
 * terms: paid for it, or holds it while it is paid (`remix_source_held_paid`).
 */
async function holdsPaidRecipeOf(adminSupabase: SupabaseClient, userId: string, sourceGenerationId: string) {
  const { data, error } = await adminSupabase.rpc('remix_source_held_paid', {
    p_user_id: userId,
    p_source_generation_id: sourceGenerationId,
  });
  if (error) {
    throw new SourceGenerationValidationError('Failed to validate the remix source.', 500);
  }
  return data === true;
}
