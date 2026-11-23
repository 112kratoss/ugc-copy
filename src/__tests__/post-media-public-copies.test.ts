import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  isPublicPostMediaCopyPath,
  maintainPostMediaPublicCopies,
  PostMediaPublicCopiesStuckError,
  publicCopyPathOf,
  removeQueuedPostMediaPublicCopies,
  servedPostMediaPathUrl,
  syncPostMediaPublicCopies,
} from '@/lib/post-media-public-copies';

const POST = 'b9500000-0000-4000-8000-000000000001';
const OWNER = 'a9500000-0000-4000-8000-000000000001';
const ORIGINAL = `private-posts/${POST}/0/photo.jpg`;
const PREVIEW = `private-posts/${POST}/0/photo.preview.0123456789abcdef.webp`;
const ORIGINAL_COPY = `public-posts/${POST}/0/photo.jpg`;
const PREVIEW_COPY = `public-posts/${POST}/0/photo.preview.0123456789abcdef.webp`;

type QueueRow = {
  public_path: string;
  post_id: string;
  next_attempt_at: string;
  created_at: string;
  claim_token: string | null;
  copy_began_at?: string | null;
};

/**
 * An in-memory stand-in for the database functions (the SQL itself is held
 * by post_media_public_copies.test.sql) and the two buckets. It answers the
 * way the migration's functions do: begin names only sources Storage holds and
 * queues before naming, stamped; commit records only verified copies of an
 * allowed post and takes one already recorded as committed; claim hands out a
 * token; finish holds a row whose copy began under 15 minutes ago.
 */
function fakeDatabase({
  allowed = true,
  rows = [{ paths: [ORIGINAL, PREVIEW], public_copy_paths: [] as string[] }],
  privateObjects = [ORIGINAL, PREVIEW],
  copyError = null as null | { message: string; statusCode?: string },
  removeError = null as null | Error,
  stillExists = false,
  queue = [] as QueueRow[],
  now = new Date('2026-11-23T12:00:00.000Z'),
} = {}) {
  const state = {
    allowed,
    rows: rows.map((row) => ({ ...row, public_copy_paths: [...row.public_copy_paths] })),
    objects: new Set<string>(privateObjects.map((path) => `post_media/${path}`)),
    queue: new Map<string, QueueRow>(queue.map((row) => [row.public_path, { ...row }])),
    copies: [] as Array<{ from: string; to: string; bucket?: string }>,
    removed: [] as string[],
    rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  };
  let tokens = 0;

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ name, args });
    if (name === 'begin_post_media_public_copies') {
      if (!state.allowed) return { data: [], error: null };
      const pairs: Array<{ source_path: string; copy_path: string }> = [];
      for (const row of state.rows) {
        for (const path of row.paths) {
          const copy = publicCopyPathOf(POST, path);
          if (!copy || row.public_copy_paths.includes(copy) || pairs.some((pair) => pair.copy_path === copy)) continue;
          if (!state.objects.has(`post_media/${path}`)) continue;
          if (state.queue.get(copy)?.claim_token) continue;
          state.queue.set(copy, {
            public_path: copy,
            post_id: POST,
            next_attempt_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
            created_at: state.queue.get(copy)?.created_at ?? now.toISOString(),
            claim_token: null,
            copy_began_at: now.toISOString(),
          });
          pairs.push({ source_path: path, copy_path: copy });
        }
      }
      return { data: pairs, error: null };
    }
    if (name === 'commit_post_media_public_copies') {
      const committed: string[] = [];
      for (const copy of args.p_copy_paths as string[]) {
        const source = `private-posts/${copy.slice('public-posts/'.length)}`;
        const queued = state.queue.get(copy);
        if (state.allowed && state.rows.some((row) => row.paths.includes(source) && row.public_copy_paths.includes(copy))) {
          // Recorded by another sync of the post: committed as it stands.
          for (const row of state.rows) {
            if (row.paths.includes(source) && !row.public_copy_paths.includes(copy)) row.public_copy_paths.push(copy);
          }
          if (queued && !queued.claim_token) state.queue.delete(copy);
          committed.push(copy);
          continue;
        }
        if (state.allowed && queued && !queued.claim_token && state.objects.has(`showcase_media/${copy}`)) {
          for (const row of state.rows) {
            if (row.paths.includes(source) && !row.public_copy_paths.includes(copy)) row.public_copy_paths.push(copy);
          }
          state.queue.delete(copy);
          committed.push(copy);
        } else {
          state.queue.set(copy, {
            created_at: now.toISOString(),
            copy_began_at: null,
            ...queued,
            public_path: copy, post_id: POST, next_attempt_at: now.toISOString(), claim_token: null,
          });
        }
      }
      return { data: committed, error: null };
    }
    if (name === 'claim_post_media_public_copy_removal') {
      const copy = args.p_copy_path as string;
      if (!state.queue.has(copy)) return { data: { outcome: 'gone' }, error: null };
      if (state.rows.some((row) => row.public_copy_paths.includes(copy))) {
        state.queue.delete(copy);
        return { data: { outcome: 'served' }, error: null };
      }
      tokens += 1;
      const token = `00000000-0000-4000-8000-${String(tokens).padStart(12, '0')}`;
      state.queue.get(copy)!.claim_token = token;
      return { data: { outcome: 'claimed', token }, error: null };
    }
    if (name === 'finish_post_media_public_copy_removal') {
      const queued = state.queue.get(args.p_copy_path as string);
      if (!queued || queued.claim_token !== args.p_claim_token) return { data: 'released', error: null };
      const began = queued.copy_began_at ? Date.parse(queued.copy_began_at) : null;
      if (began !== null && began > now.getTime() - 15 * 60_000) {
        queued.claim_token = null;
        queued.next_attempt_at = new Date(began + 15 * 60_000).toISOString();
        return { data: 'held', error: null };
      }
      state.queue.delete(args.p_copy_path as string);
      return { data: 'removed', error: null };
    }
    if (name === 'reschedule_post_media_public_copy_removal') {
      const queued = state.queue.get(args.p_copy_path as string);
      if (queued && queued.claim_token === args.p_claim_token) {
        queued.claim_token = null;
        queued.next_attempt_at = new Date(now.getTime() + 10 * 60_000).toISOString();
      }
      return { data: null, error: null };
    }
    if (name === 'list_post_media_public_copy_candidates') {
      const missing = state.rows.flatMap((row) => row.paths.filter((path) => {
        const copy = publicCopyPathOf(POST, path);
        return copy && !row.public_copy_paths.includes(copy) && state.objects.has(`post_media/${path}`);
      }));
      const served = state.rows.some((row) => row.public_copy_paths.length > 0);
      const listed = state.allowed && missing.length > 0 && (args.p_include_unserved || served) && !args.p_before_post_id;
      return {
        data: listed
          ? [{ post_id: POST, owner_user_id: OWNER, post_created_at: now.toISOString(), missing_objects: missing.length, missing_bytes: 1000 }]
          : [],
        error: null,
      };
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  const from = (table: string) => {
    if (table !== 'post_media_public_copy_queue') throw new Error(`unexpected table ${table}`);
    const filters: Array<(row: QueueRow) => boolean> = [];
    let head = false;
    const query = {
      select: (_columns: string, options?: { head?: boolean }) => {
        head = Boolean(options?.head);
        return query;
      },
      lte: (column: 'next_attempt_at', value: string) => { filters.push((row) => row[column] <= value); return query; },
      lt: (column: 'created_at', value: string) => {
        filters.push((row) => row[column] < value);
        const rows = [...state.queue.values()].filter((row) => filters.every((filter) => filter(row)));
        return Promise.resolve(head ? { count: rows.length, error: null } : { data: rows, error: null });
      },
      eq: (column: 'post_id', value: string) => { filters.push((row) => row[column] === value); return query; },
      order: () => query,
      limit: async (count: number) => ({
        data: [...state.queue.values()]
          .filter((row) => filters.every((filter) => filter(row)))
          .sort((left, right) => left.next_attempt_at.localeCompare(right.next_attempt_at)
            || left.public_path.localeCompare(right.public_path))
          .slice(0, count),
        error: null,
      }),
    };
    return query;
  };

  const storage = {
    from: (bucket: string) => ({
      copy: async (fromPath: string, toPath: string, options?: { destinationBucket?: string }) => {
        state.copies.push({ from: `${bucket}/${fromPath}`, to: toPath, bucket: options?.destinationBucket });
        if (copyError) return { data: null, error: copyError };
        const target = `${options?.destinationBucket ?? bucket}/${toPath}`;
        if (state.objects.has(target)) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
        state.objects.add(target);
        return { data: { path: toPath }, error: null };
      },
      remove: async (paths: string[]) => {
        if (removeError) return { data: null, error: removeError };
        for (const path of paths) {
          state.removed.push(`${bucket}/${path}`);
          if (!stillExists) state.objects.delete(`${bucket}/${path}`);
        }
        return { data: [], error: null };
      },
      exists: async (path: string) => ({ data: state.objects.has(`${bucket}/${path}`), error: null }),
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example.test/storage/v1/object/public/${bucket}/${path}` } }),
    }),
  };

  return { client: { rpc, from, storage } as unknown as SupabaseClient, state, now };
}

describe('public copy paths', () => {
  it('maps only the post\'s own private folder, onto its public folder', () => {
    expect(publicCopyPathOf(POST, ORIGINAL)).toBe(ORIGINAL_COPY);
    expect(publicCopyPathOf(POST, `private-posts/${POST}/`)).toBeNull();
    expect(publicCopyPathOf(POST, `private-posts/b9500000-0000-4000-8000-000000000002/0/photo.jpg`)).toBeNull();
    expect(publicCopyPathOf(POST, `showcase/${POST}/photo.jpg`)).toBeNull();
    expect(publicCopyPathOf(POST, `posts/${POST}/photo.jpg`)).toBeNull();
    expect(publicCopyPathOf('not-a-uuid', 'private-posts/not-a-uuid/photo.jpg')).toBeNull();
    expect(publicCopyPathOf(POST, null)).toBeNull();
  });

  it('accepts only canonical paths inside the post\'s public folder', () => {
    expect(isPublicPostMediaCopyPath(ORIGINAL_COPY, POST)).toBe(true);
    expect(isPublicPostMediaCopyPath(`public-posts/${POST}/../other/photo.jpg`, POST)).toBe(false);
    expect(isPublicPostMediaCopyPath(`public-posts/b9500000-0000-4000-8000-000000000002/photo.jpg`, POST)).toBe(false);
  });

  it('serves a recorded copy from the CDN and anything else through the fallback', () => {
    const { client } = fakeDatabase();
    const fallback = (path: string) => `/api/media?bucket=post_media&path=${encodeURIComponent(path)}`;
    expect(servedPostMediaPathUrl({ client, postId: POST, path: ORIGINAL, recordedCopies: [ORIGINAL_COPY], fallback }))
      .toBe(`https://cdn.example.test/storage/v1/object/public/showcase_media/${ORIGINAL_COPY}`);
    expect(servedPostMediaPathUrl({ client, postId: POST, path: PREVIEW, recordedCopies: [ORIGINAL_COPY], fallback }))
      .toBe(fallback(PREVIEW));
    expect(servedPostMediaPathUrl({ client, postId: POST, path: ORIGINAL, recordedCopies: null, fallback }))
      .toBe(fallback(ORIGINAL));
  });
});

describe('syncPostMediaPublicCopies', () => {
  it('copies each private object inside Storage and records the copies', async () => {
    const { client, state } = fakeDatabase();
    expect(await syncPostMediaPublicCopies(client, POST)).toEqual({ begun: 2, committed: 2, refused: 0, failed: 0 });
    expect(state.copies).toEqual([
      { from: `post_media/${ORIGINAL}`, to: ORIGINAL_COPY, bucket: 'showcase_media' },
      { from: `post_media/${PREVIEW}`, to: PREVIEW_COPY, bucket: 'showcase_media' },
    ]);
    expect(state.rows[0].public_copy_paths).toEqual([ORIGINAL_COPY, PREVIEW_COPY]);
    expect(state.queue.size).toBe(0);
  });

  it('makes nothing for a post nobody signed out may read', async () => {
    const { client, state } = fakeDatabase({ allowed: false });
    expect(await syncPostMediaPublicCopies(client, POST)).toEqual({ begun: 0, committed: 0, refused: 0, failed: 0 });
    expect(state.copies).toEqual([]);
  });

  it('records an object an earlier run already copied', async () => {
    const { client, state } = fakeDatabase();
    state.objects.add(`showcase_media/${ORIGINAL_COPY}`);
    expect(await syncPostMediaPublicCopies(client, POST)).toMatchObject({ committed: 2, failed: 0 });
  });

  it('leaves a copy Storage refused queued for the worker, recording nothing', async () => {
    const { client, state } = fakeDatabase({ copyError: { message: 'Payload too large', statusCode: '413' } });
    expect(await syncPostMediaPublicCopies(client, POST)).toEqual({ begun: 2, committed: 0, refused: 0, failed: 2 });
    expect(state.rpcCalls.map((call) => call.name)).toEqual(['begin_post_media_public_copies']);
    expect([...state.queue.keys()]).toEqual([ORIGINAL_COPY, PREVIEW_COPY]);
    expect(state.rows[0].public_copy_paths).toEqual([]);
  });

  it('removes a copy the database refused to record (the post went private meanwhile)', async () => {
    const { client, state } = fakeDatabase();
    const rpc = client.rpc as unknown as ReturnType<typeof vi.fn>;
    const answer = rpc.getMockImplementation() as (name: string, args: Record<string, unknown>) => Promise<unknown>;
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'commit_post_media_public_copies') state.allowed = false;
      return answer(name, args);
    });
    expect(await syncPostMediaPublicCopies(client, POST)).toEqual({ begun: 2, committed: 0, refused: 2, failed: 0 });
    // Removed under a claim, never by a raw remove: a claim re-reads the rows.
    expect(state.rpcCalls.filter((call) => call.name === 'claim_post_media_public_copy_removal')).toHaveLength(2);
    expect(state.removed).toEqual([`showcase_media/${ORIGINAL_COPY}`, `showcase_media/${PREVIEW_COPY}`]);
    expect(state.objects.has(`showcase_media/${ORIGINAL_COPY}`)).toBe(false);
    // The copies began moments ago, so their rows stay until one could no longer land.
    expect([...state.queue.values()].map((row) => [row.public_path, row.claim_token, row.next_attempt_at])).toEqual([
      [ORIGINAL_COPY, null, '2026-11-23T12:15:00.000Z'],
      [PREVIEW_COPY, null, '2026-11-23T12:15:00.000Z'],
    ]);
  });

  // Review of #908: a second sync's refused commit used to remove the object
  // the first had just recorded, leaving the row naming a dead URL.
  it('lets two syncs of one post run at once without removing what either recorded', async () => {
    const { client, state } = fakeDatabase();

    const [first, second] = await Promise.all([
      syncPostMediaPublicCopies(client, POST),
      syncPostMediaPublicCopies(client, POST),
    ]);

    expect(first.committed + second.committed).toBeGreaterThanOrEqual(2);
    expect(first.refused + second.refused).toBe(0);
    expect(state.removed).toEqual([]);
    expect(state.objects.has(`showcase_media/${ORIGINAL_COPY}`)).toBe(true);
    expect(state.rows[0].public_copy_paths).toEqual([ORIGINAL_COPY, PREVIEW_COPY]);
    expect(state.queue.size).toBe(0);
  });

  it('refuses a pair outside the post\'s own folder before Storage sees it', async () => {
    const { client, state } = fakeDatabase();
    const rpc = client.rpc as unknown as ReturnType<typeof vi.fn>;
    rpc.mockImplementationOnce(async () => ({
      data: [{ source_path: `private-posts/${POST}/0/photo.jpg`, copy_path: 'public-posts/b9500000-0000-4000-8000-000000000002/0/photo.jpg' }],
      error: null,
    }));
    await expect(syncPostMediaPublicCopies(client, POST)).rejects.toThrow('outside the post');
    expect(state.copies).toEqual([]);
  });
});

describe('removeQueuedPostMediaPublicCopies', () => {
  const now = new Date('2026-11-23T12:00:00.000Z');
  const due = (path: string, minutesAgo = 1): QueueRow => ({
    public_path: path,
    post_id: POST,
    next_attempt_at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    created_at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    claim_token: null,
  });

  it('removes a queued copy no row records and verifies it gone before the row leaves', async () => {
    const { client, state } = fakeDatabase({ queue: [due(ORIGINAL_COPY)] });
    state.objects.add(`showcase_media/${ORIGINAL_COPY}`);
    expect(await removeQueuedPostMediaPublicCopies(client, { postId: POST, now }))
      .toMatchObject({ due: 1, removed: 1, rescheduled: 0 });
    expect(state.objects.has(`showcase_media/${ORIGINAL_COPY}`)).toBe(false);
    expect(state.queue.size).toBe(0);
  });

  it('holds the row of a copy begun minutes ago after verifying it gone, since that copy may still land', async () => {
    const copying: QueueRow = { ...due(ORIGINAL_COPY), copy_began_at: new Date(now.getTime() - 5 * 60_000).toISOString() };
    const { client, state } = fakeDatabase({ queue: [copying] });
    state.objects.add(`showcase_media/${ORIGINAL_COPY}`);

    expect(await removeQueuedPostMediaPublicCopies(client, { postId: POST, now }))
      .toMatchObject({ due: 1, removed: 0, held: 1 });
    expect(state.objects.has(`showcase_media/${ORIGINAL_COPY}`)).toBe(false);
    expect(state.queue.get(ORIGINAL_COPY)).toMatchObject({ claim_token: null, next_attempt_at: '2026-11-23T12:10:00.000Z' });
  });

  it('never removes a copy a row records again', async () => {
    const { client, state } = fakeDatabase({
      rows: [{ paths: [ORIGINAL], public_copy_paths: [ORIGINAL_COPY] }],
      queue: [due(ORIGINAL_COPY)],
    });
    state.objects.add(`showcase_media/${ORIGINAL_COPY}`);
    expect(await removeQueuedPostMediaPublicCopies(client, { postId: POST, now })).toMatchObject({ served: 1, removed: 0 });
    expect(state.removed).toEqual([]);
    expect(state.objects.has(`showcase_media/${ORIGINAL_COPY}`)).toBe(true);
  });

  it('keeps the row and retries later when Storage still holds the object', async () => {
    const { client, state } = fakeDatabase({ queue: [due(ORIGINAL_COPY)], stillExists: true });
    state.objects.add(`showcase_media/${ORIGINAL_COPY}`);
    expect(await removeQueuedPostMediaPublicCopies(client, { postId: POST, now })).toMatchObject({ removed: 0, rescheduled: 1 });
    expect(state.queue.get(ORIGINAL_COPY)?.claim_token).toBeNull();
    expect(state.rpcCalls.map((call) => call.name)).toContain('reschedule_post_media_public_copy_removal');
  });

  it('keeps the row and retries later when Storage refuses the removal', async () => {
    const { client, state } = fakeDatabase({ queue: [due(ORIGINAL_COPY)], removeError: new Error('storage unavailable') });
    expect(await removeQueuedPostMediaPublicCopies(client, { postId: POST, now })).toMatchObject({ rescheduled: 1 });
    expect(state.queue.has(ORIGINAL_COPY)).toBe(true);
  });

  it('leaves a copy still being made alone until its grace ends', async () => {
    const copying: QueueRow = { ...due(ORIGINAL_COPY), next_attempt_at: new Date(now.getTime() + 15 * 60_000).toISOString() };
    const { client, state } = fakeDatabase({ queue: [copying] });
    expect(await removeQueuedPostMediaPublicCopies(client, { postId: POST, now })).toMatchObject({ due: 0 });
    expect(state.rpcCalls).toEqual([]);
  });

  it('takes rows due within a minute after a write, for a clock behind the database\'s', async () => {
    const ahead: QueueRow = { ...due(ORIGINAL_COPY), next_attempt_at: new Date(now.getTime() + 30_000).toISOString() };
    const { client } = fakeDatabase({ queue: [ahead] });
    expect(await removeQueuedPostMediaPublicCopies(client, { postId: POST, now })).toMatchObject({ due: 1, removed: 1 });
    const job = fakeDatabase({ queue: [ahead] });
    expect(await removeQueuedPostMediaPublicCopies(job.client, { now })).toMatchObject({ due: 0 });
  });

  it('fails the job\'s run on a row a day old, after removing what it can', async () => {
    const { client, state } = fakeDatabase({ queue: [due(ORIGINAL_COPY, 25 * 60)], stillExists: true });
    state.objects.add(`showcase_media/${ORIGINAL_COPY}`);
    const run = removeQueuedPostMediaPublicCopies(client, { now, failOnStuck: true });
    await expect(run).rejects.toBeInstanceOf(PostMediaPublicCopiesStuckError);
    await expect(run).rejects.toMatchObject({ summary: { stuck: 1, rescheduled: 1 } });
  });
});

describe('maintainPostMediaPublicCopies', () => {
  it('copies what posts already served are missing, and names them for a page refresh', async () => {
    const { client, state } = fakeDatabase({
      rows: [{ paths: [ORIGINAL, PREVIEW], public_copy_paths: [ORIGINAL_COPY] }],
    });
    state.objects.add(`showcase_media/${ORIGINAL_COPY}`);
    const result = await maintainPostMediaPublicCopies(client, { now: new Date('2026-11-23T12:00:00.000Z') });
    expect(result.synced).toEqual({ posts: 1, committed: 1, refused: 0, failed: 0 });
    expect(result.copiedPosts).toMatchObject([{ postId: POST, ownerUserId: OWNER }]);
    expect(state.rows[0].public_copy_paths).toEqual([ORIGINAL_COPY, PREVIEW_COPY]);
  });

  it('never copies a post nothing was copied for: existing posts wait for the backfill', async () => {
    const { client, state } = fakeDatabase();
    const result = await maintainPostMediaPublicCopies(client, { now: new Date('2026-11-23T12:00:00.000Z') });
    expect(result.synced.posts).toBe(0);
    expect(state.copies).toEqual([]);
  });
});
