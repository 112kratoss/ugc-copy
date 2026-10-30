import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exposedPostOf,
  remixSourceTables,
  type RemixSourceRowOptions,
} from '@/__tests__/fixtures/remix-source-rows';
import { createStoredRows } from '@/__tests__/fixtures/stored-rows';
import {
  resolveSourceGenerationId,
  SourceGenerationValidationError,
} from '@/lib/source-generation';

const logBackendErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend-logger')>(),
  logBackendError: logBackendErrorMock,
}));

const SOURCE_ID = '0f0e0d0c-0b0a-4901-8807-060504030201';
const GENERATION_SELECT = ['id', 'user_id', 'is_public', 'template_run_id', 'template_run_step_id'];

/** A caller with an account, and a guest identity (`isGuestUser`). */
const REGISTERED = { callerIsGuest: false };
const GUEST = { callerIsGuest: true };

type Row = Record<string, unknown>;

/** Someone else's public creation. */
const PUBLIC_SOURCE = {
  id: SOURCE_ID,
  user_id: 'other-user',
  is_public: true,
  template_run_id: null,
  template_run_step_id: null,
};

/** Its post as the feed shows it, the start tests' own row: public, live and visible. */
const EXPOSED_POST = exposedPostOf(PUBLIC_SOURCE);

/** A recipe published on the post: its Remix is for those who unlocked it. */
const PUBLISHED_RECIPE = {
  id: 'bundle-1',
  post_id: EXPOSED_POST.id,
  status: 'published',
  allow_remix: true,
};

/**
 * Fails a read at its end, as a timed-out query does. The filters before it
 * stay the stored rows' own, so a query that changes shape is still checked by
 * them, not stopped early by a stand-in that lacks the new filter.
 */
function failRead<Query extends object>(query: Query, error: { message: string }) {
  const failed = { data: null, error };
  return Object.assign(query, {
    single: async () => failed,
    maybeSingle: async () => failed,
    then: (resolve: (value: typeof failed) => unknown, reject?: (reason: unknown) => unknown) => (
      Promise.resolve(failed).then(resolve, reject)
    ),
  });
}

/**
 * Reads answer as the database would (`createStoredRows`): filters applied,
 * only the selected columns answered, an unknown table or column refused, and
 * any `or()` filter refused, so no caller value can reach one unnoticed. The
 * tables Remix reads are the start tests' fixture (`remixSourceTables`).
 */
function createSupabaseMock({
  generation = PUBLIC_SOURCE,
  linkedProfiles = [],
  failingReads = {},
  ...remixRows
}: Omit<RemixSourceRowOptions, 'profiles'> & {
  generation?: Row | null;
  /** Guest profiles and the account each was linked into (`merged_into_user_id`). */
  linkedProfiles?: Array<{ id: string; mergedIntoUserId: string }>;
  failingReads?: Partial<Record<string, { message: string }>>;
} = {}) {
  const stored = createStoredRows({
    generations: generation ? [generation] : [],
    ...remixSourceTables(PUBLIC_SOURCE, {
      ...remixRows,
      profiles: linkedProfiles.map(({ id, mergedIntoUserId }) => ({ id, merged_into_user_id: mergedIntoUserId })),
    }),
  });
  const from = (table: string) => {
    const query = stored.client.from(table);
    const error = failingReads[table];
    return error ? { ...query, select: (columns: string) => failRead(query.select(columns), error) } : query;
  };

  return {
    supabase: { from } as unknown as SupabaseClient,
    /** The tables read, in order. */
    tables: () => stored.reads.map(({ table }) => table),
    reads: stored.reads,
  };
}

beforeEach(() => {
  logBackendErrorMock.mockClear();
});

describe('source generation validation', () => {
  it('resolves public remix sources without interpolating the user id into a filter', async () => {
    const { reads, supabase } = createSupabaseMock();

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      ` ${SOURCE_ID} `,
      REGISTERED,
    )).resolves.toBe(SOURCE_ID);

    // The visibility rule lives in code, so no caller-influenced value is ever
    // embedded in a PostgREST `.or()` filter expression: the stored rows refuse
    // every `or()` this read could send.
    expect(reads[0]).toEqual({ table: 'generations', columns: GENERATION_SELECT });
  });

  // A template's result is remixed by nobody (`remix-access.ts`), and its post
  // offers no Remix. A create page sends the `remix` id of its own URL with every
  // start, so a hand-made link credited the post with a remix and told its owner.
  it.each([
    ['public, someone else’s', { user_id: 'other-user', is_public: true }],
    ['the caller’s own', { user_id: 'user-1', is_public: false }],
  ])('records no remix of a template result (%s), and starts the run as an ordinary one', async (_label, row) => {
    const { reads, supabase } = createSupabaseMock({
      generation: { ...PUBLIC_SOURCE, ...row, template_run_id: 'run-1', template_run_step_id: 'step-1' },
    });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID, REGISTERED)).resolves.toBeNull();
    expect(reads[0]).toEqual({ table: 'generations', columns: GENERATION_SELECT });
  });

  it('resolves sources the requesting user owns even when private', async () => {
    const { supabase, tables } = createSupabaseMock({
      generation: { ...PUBLIC_SOURCE, user_id: 'user-1', is_public: false },
    });

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      SOURCE_ID,
      REGISTERED,
    )).resolves.toBe(SOURCE_ID);
    // A direct owner match costs generation start no linked-account lookup.
    expect(tables()).toEqual(['generations']);
  });

  it('resolves a private source made under a guest identity linked to the requesting user', async () => {
    // Recreate restores creations made before registering, which keep their
    // guest UUID. Rejecting them here fails the generation that restore set up.
    const { supabase, tables } = createSupabaseMock({
      generation: { ...PUBLIC_SOURCE, user_id: 'guest-1', is_public: false },
      linkedProfiles: [{ id: 'guest-1', mergedIntoUserId: 'user-1' }],
    });

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      SOURCE_ID,
      REGISTERED,
    )).resolves.toBe(SOURCE_ID);
    expect(tables()).toEqual(['generations', 'profiles']);
  });

  it('rejects a private source made under a guest identity linked to another account', async () => {
    const { supabase } = createSupabaseMock({
      generation: { ...PUBLIC_SOURCE, user_id: 'guest-1', is_public: false },
      linkedProfiles: [{ id: 'guest-1', mergedIntoUserId: 'other-user' }],
    });

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      SOURCE_ID,
      REGISTERED,
    )).rejects.toMatchObject({
      name: 'SourceGenerationValidationError',
      status: 400,
    });
  });

  it('rejects private sources owned by someone else', async () => {
    const { supabase } = createSupabaseMock({
      generation: { ...PUBLIC_SOURCE, is_public: false },
    });

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      SOURCE_ID,
      REGISTERED,
    )).rejects.toMatchObject({
      name: 'SourceGenerationValidationError',
      status: 400,
    });
  });

  it('returns null when no remix source is provided', async () => {
    const { supabase, tables } = createSupabaseMock();

    await expect(resolveSourceGenerationId(supabase, 'user-1', '  ', REGISTERED)).resolves.toBeNull();

    expect(tables()).toEqual([]);
  });

  it('rejects malformed and filter-injection source ids without querying', async () => {
    const { supabase, tables } = createSupabaseMock();

    for (const malicious of [
      'not-a-uuid',
      `${SOURCE_ID},user_id.not.is.null`,
      'x)or(is_public.eq.true',
    ]) {
      await expect(resolveSourceGenerationId(
        supabase,
        'user-1',
        malicious,
        REGISTERED,
      )).rejects.toMatchObject({
        name: 'SourceGenerationValidationError',
        status: 400,
      });
    }

    expect(tables()).toEqual([]);
  });

  it('throws a validation error when the source is not visible', async () => {
    const { supabase } = createSupabaseMock({ generation: null });

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      SOURCE_ID,
      REGISTERED,
    )).rejects.toMatchObject({
      name: 'SourceGenerationValidationError',
      status: 400,
    });
  });

  it('turns database failures into a 500 validation error', async () => {
    const { supabase } = createSupabaseMock({ failingReads: { generations: { message: 'database down' } } });

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      SOURCE_ID,
      REGISTERED,
    )).rejects.toBeInstanceOf(SourceGenerationValidationError);

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      SOURCE_ID,
      REGISTERED,
    )).rejects.toMatchObject({ status: 500 });
  });
});

// The id a start keeps credits the post with a remix and tells its creator
// (`record_completed_post_remix`, `notifyCompletedRemix`), so someone else's
// public source is kept only when Remix would hand the caller its recipe now.
// Otherwise the run goes ahead as an ordinary one: the create page sends its
// URL's `remix` id even after Remix refused the caller.
describe('remix credit', () => {
  /**
   * No remix is recorded, and by the rule: a read that fails on the way answers
   * null too, but logs, so a refusal that logged refused for the wrong reason.
   */
  async function expectNoRemixByRule(supabase: SupabaseClient) {
    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID, REGISTERED)).resolves.toBeNull();
    expect(logBackendErrorMock).not.toHaveBeenCalled();
  }

  it.each([
    ['the creator blocked the caller', { blocker_user_id: 'other-user', blocked_user_id: 'user-1' }],
    ['the caller blocked the creator', { blocker_user_id: 'user-1', blocked_user_id: 'other-user' }],
  ])('records no remix when %s, and starts the run as an ordinary one', async (_label, block) => {
    await expectNoRemixByRule(createSupabaseMock({ blocks: [block] }).supabase);
  });

  it('records no remix for a caller who has not unlocked the post’s published recipe', async () => {
    await expectNoRemixByRule(createSupabaseMock({
      recipes: [PUBLISHED_RECIPE],
      purchases: [{ id: 'purchase-1', bundle_id: PUBLISHED_RECIPE.id, buyer_user_id: 'someone-else' }],
    }).supabase);
  });

  it('credits a caller who unlocked the post’s recipe', async () => {
    const { supabase } = createSupabaseMock({
      recipes: [PUBLISHED_RECIPE],
      purchases: [{ id: 'purchase-1', bundle_id: PUBLISHED_RECIPE.id, buyer_user_id: 'user-1' }],
    });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID, REGISTERED)).resolves.toBe(SOURCE_ID);
  });

  // A post held for review keeps its creation public (`generations.is_public`),
  // but the feed and Remix withhold it.
  it('records no remix of a post held for review', async () => {
    await expectNoRemixByRule(createSupabaseMock({ posts: [{ ...EXPOSED_POST, review_status: 'flagged' }] }).supabase);
  });

  // Remix serves a guest nothing but its own creations: `/api/remix-source`
  // answers anyone else's 403, and `/api/showcase/remix` takes accounts only.
  it('records no remix of someone else’s post for a guest, and starts the run as an ordinary one', async () => {
    const { supabase, tables } = createSupabaseMock();

    await expect(resolveSourceGenerationId(supabase, 'guest-1', SOURCE_ID, GUEST)).resolves.toBeNull();
    expect(logBackendErrorMock).not.toHaveBeenCalled();
    // Decided by whose creation it is, as `/api/remix-source` decides it,
    // before anything Remix reads about the post.
    expect(tables()).toEqual(['generations', 'profiles']);
  });

  // The guest rule answers only public sources: a private one that is not the
  // guest's still answers 400, as for anyone, so a guest cannot tell someone's
  // private creation from none by whether its run starts.
  it('still refuses a guest someone else’s private creation', async () => {
    const { supabase } = createSupabaseMock({ generation: { ...PUBLIC_SOURCE, is_public: false } });

    await expect(resolveSourceGenerationId(supabase, 'guest-1', SOURCE_ID, GUEST)).rejects.toMatchObject({
      name: 'SourceGenerationValidationError',
      status: 400,
    });
  });

  it.each([
    ['private', false],
    ['public', true],
  ])('keeps a guest’s own %s creation, as Recreate restores it', async (_label, isPublic) => {
    const { supabase } = createSupabaseMock({
      generation: { ...PUBLIC_SOURCE, user_id: 'guest-1', is_public: isPublic },
    });

    await expect(resolveSourceGenerationId(supabase, 'guest-1', SOURCE_ID, GUEST)).resolves.toBe(SOURCE_ID);
  });

  it('credits the caller’s own public source without reading its post', async () => {
    const { supabase, tables } = createSupabaseMock({ generation: { ...PUBLIC_SOURCE, user_id: 'user-1' } });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID, REGISTERED)).resolves.toBe(SOURCE_ID);
    expect(tables()).toEqual(['generations']);
  });

  // The bookkeeping must not cost the caller their run: a check that cannot be
  // made credits no remix, is logged, and the run starts. The log must carry the
  // failure each case injects, so another error on the way cannot stand in for it.
  it.each([
    ['posts', {}, 'failed_to_check_remix_access_for_source_generation'],
    // Remix counts a block check it cannot make as a block, and logs that itself.
    ['user_blocks', {}, 'failed_to_verify_block_state_before_remix_access'],
    ['post_resource_bundles', {}, 'failed_to_check_remix_access_for_source_generation'],
    ['post_resource_bundle_purchases', { recipes: [PUBLISHED_RECIPE] }, 'failed_to_check_remix_access_for_source_generation'],
  ])('records no remix, and starts the run, when its %s read fails', async (table, rows, event) => {
    const timeout = { message: 'timeout' };
    const { supabase, tables } = createSupabaseMock({ ...rows, failingReads: { [table]: timeout } });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID, REGISTERED)).resolves.toBeNull();
    expect(tables()).toContain(table);
    expect(logBackendErrorMock).toHaveBeenCalledTimes(1);
    expect(logBackendErrorMock).toHaveBeenCalledWith(event, { error: timeout });
  });
});
