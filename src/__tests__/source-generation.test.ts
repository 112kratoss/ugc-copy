import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

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

type Row = Record<string, unknown>;

/** Someone else's public creation. */
const PUBLIC_SOURCE = {
  id: SOURCE_ID,
  user_id: 'other-user',
  is_public: true,
  template_run_id: null,
  template_run_step_id: null,
};

/** Its post as the feed shows it: public, live and visible. */
const EXPOSED_POST = {
  id: 'post-1',
  user_id: 'other-user',
  generation_id: SOURCE_ID,
  category: 'image',
  post_format: 'media',
  source_kind: 'magicbooklet',
  visibility: 'public',
  archived_at: null,
  review_status: 'visible',
};

/** A recipe published on the post: its Remix is for those who unlocked it. */
const PUBLISHED_RECIPE = {
  id: 'bundle-1',
  post_id: 'post-1',
  status: 'published',
  allow_remix: true,
};

/** A table whose every read fails, as a timed-out query does. */
function failingTable(error: { message: string }) {
  const failed = { data: null, error };
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    maybeSingle: async () => failed,
    then: (resolve: (value: typeof failed) => unknown, reject?: (reason: unknown) => unknown) => (
      Promise.resolve(failed).then(resolve, reject)
    ),
  };
  return query;
}

/**
 * Reads answer as the database would (`createStoredRows`): filters applied,
 * only the selected columns answered, an unknown table or column refused, and
 * any `or()` filter refused, so no caller value can reach one unnoticed.
 */
function createSupabaseMock({
  generation = PUBLIC_SOURCE,
  posts = [EXPOSED_POST],
  recipes = [],
  purchases = [],
  blocks = [],
  linkedProfiles = [],
  failingReads = {},
}: {
  generation?: Row | null;
  posts?: Row[];
  recipes?: Row[];
  purchases?: Row[];
  /** `user_blocks` rows: who blocked whom. */
  blocks?: Array<{ blocker_user_id: string; blocked_user_id: string }>;
  /** Guest profiles and the account each was linked into (`merged_into_user_id`). */
  linkedProfiles?: Array<{ id: string; mergedIntoUserId: string }>;
  failingReads?: Partial<Record<string, { message: string }>>;
} = {}) {
  const stored = createStoredRows({
    generations: generation ? [generation] : [],
    profiles: linkedProfiles.map(({ id, mergedIntoUserId }) => ({ id, merged_into_user_id: mergedIntoUserId })),
    posts,
    post_resource_bundles: recipes,
    post_resource_bundle_purchases: purchases,
    user_blocks: blocks,
  });
  const from = vi.fn((table: string) => {
    const error = failingReads[table];
    return error ? failingTable(error) : stored.client.from(table);
  });

  return {
    supabase: { from } as unknown as SupabaseClient,
    tables: () => from.mock.calls.map(([table]) => table),
    reads: stored.reads,
  };
}

describe('source generation validation', () => {
  it('resolves public remix sources without interpolating the user id into a filter', async () => {
    const { reads, supabase } = createSupabaseMock();

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      ` ${SOURCE_ID} `,
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

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID)).resolves.toBeNull();
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
    )).rejects.toMatchObject({
      name: 'SourceGenerationValidationError',
      status: 400,
    });
  });

  it('returns null when no remix source is provided', async () => {
    const { supabase, tables } = createSupabaseMock();

    await expect(resolveSourceGenerationId(supabase, 'user-1', '  ')).resolves.toBeNull();

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
    )).rejects.toBeInstanceOf(SourceGenerationValidationError);

    await expect(resolveSourceGenerationId(
      supabase,
      'user-1',
      SOURCE_ID,
    )).rejects.toMatchObject({ status: 500 });
  });
});

// The id a start keeps is what credits the post with a remix and tells its
// creator (`record_completed_post_remix`, `notifyCompletedRemix`). Someone
// else's public source is kept only when Remix would hand the caller its recipe
// now (`resolveRemixAccess`). Otherwise the run goes ahead as an ordinary one,
// as a template result's does: the create page sends its URL's `remix` id even
// after Remix refused the caller.
describe('remix credit', () => {
  it.each([
    ['the creator blocked the caller', { blocker_user_id: 'other-user', blocked_user_id: 'user-1' }],
    ['the caller blocked the creator', { blocker_user_id: 'user-1', blocked_user_id: 'other-user' }],
  ])('records no remix when %s, and starts the run as an ordinary one', async (_label, block) => {
    const { supabase } = createSupabaseMock({ blocks: [block] });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID)).resolves.toBeNull();
  });

  it('records no remix for a caller who has not unlocked the post’s published recipe', async () => {
    const { supabase } = createSupabaseMock({
      recipes: [PUBLISHED_RECIPE],
      purchases: [{ id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: 'someone-else' }],
    });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID)).resolves.toBeNull();
  });

  it('credits a caller who unlocked the post’s recipe', async () => {
    const { supabase } = createSupabaseMock({
      recipes: [PUBLISHED_RECIPE],
      purchases: [{ id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: 'user-1' }],
    });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID)).resolves.toBe(SOURCE_ID);
  });

  // A post held for review keeps its creation public (`generations.is_public`),
  // but the feed and Remix withhold it.
  it('records no remix of a post held for review', async () => {
    const { supabase } = createSupabaseMock({ posts: [{ ...EXPOSED_POST, review_status: 'flagged' }] });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID)).resolves.toBeNull();
  });

  it('credits the caller’s own public source without reading its post', async () => {
    const { supabase, tables } = createSupabaseMock({
      generation: { ...PUBLIC_SOURCE, user_id: 'user-1' },
      posts: [{ ...EXPOSED_POST, user_id: 'user-1' }],
    });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID)).resolves.toBe(SOURCE_ID);
    expect(tables()).toEqual(['generations']);
  });

  // The bookkeeping must not cost the caller their run: a check that cannot be
  // made credits no remix, is logged, and the run starts.
  it.each([
    ['posts', {}],
    ['user_blocks', {}],
    ['post_resource_bundles', {}],
    ['post_resource_bundle_purchases', { recipes: [PUBLISHED_RECIPE] }],
  ])('records no remix, and starts the run, when its %s read fails', async (table, rows) => {
    logBackendErrorMock.mockClear();
    const { supabase, tables } = createSupabaseMock({ ...rows, failingReads: { [table]: { message: 'timeout' } } });

    await expect(resolveSourceGenerationId(supabase, 'user-1', SOURCE_ID)).resolves.toBeNull();
    expect(tables()).toContain(table);
    expect(logBackendErrorMock).toHaveBeenCalled();
  });
});
