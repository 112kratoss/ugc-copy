/**
 * Local-only live check of the public copies of uploaded post media
 * (20261123153250_post_media_public_copies.sql, src/lib/post-media-public-copies.ts).
 * No production configuration is loaded: the stack's own `supabase status -o json`
 * is read from the path given, and anything but a local API is refused.
 *
 *   npx --yes supabase@2.75.0 --workdir <stack> status -o json > status.json
 *   NODE_PATH=<dir holding node_modules/server-only/index.js, empty> \
 *     npx tsx scripts/audits/verify-local-post-media-public-copies.ts status.json [iterations]
 *
 * (`server-only` resolves inside Next alone; the integration configs alias it
 * to src/__tests__/mocks/server-only.ts, and outside vitest an empty module on
 * NODE_PATH does the same.)
 *
 * It seeds a public post made from uploads (a ~1 MB JPEG and its preview in
 * the private bucket), then measures one media view each way:
 * - before: the descriptor names `/api/media`; the route's own code runs
 *   (identity, `resolve_post_media_read`, a signature) and its redirect is
 *   followed to the object;
 * - after the copies are made (publish's path): the descriptor names the
 *   public copy, fetched directly.
 * Every request to the stack is counted by kind. Then every reverse path is
 * run against the real database and Storage (private, archive, hide, NSFW,
 * a gallery save, delete, the owner deleting), each checked to leave no
 * public object behind once the queue is drained, and the copies made
 * again where the post comes back.
 */
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

import { loadPostMediaItemsMap } from '../../src/lib/post-media';
import { getPostMediaRouteResponse } from '../../src/lib/post-media-route-adapter-service';
import { resetPostMediaSignaturesForTests } from '../../src/lib/post-media-read-service';
import {
  removeQueuedPostMediaPublicCopies,
  syncPostMediaPublicCopies,
} from '../../src/lib/post-media-public-copies';

type Kind = 'rpc' | 'rest' | 'storage-sign' | 'storage-object' | 'auth' | 'other';
const requests: Record<Kind, number> = { rpc: 0, rest: 0, 'storage-sign': 0, 'storage-object': 0, auth: 0, other: 0 };
const nativeFetch = globalThis.fetch;

function count(input: RequestInfo | URL) {
  const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
  const kind: Kind = path.startsWith('/rest/v1/rpc/') ? 'rpc'
    : path.startsWith('/rest/v1/') ? 'rest'
      : path.startsWith('/storage/v1/object/sign/') ? 'storage-sign'
        : path.startsWith('/storage/v1/object/') ? 'storage-object'
          : path.startsWith('/auth/v1/') ? 'auth'
            : 'other';
  requests[kind] += 1;
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  count(input);
  return nativeFetch(input, init);
}) as typeof fetch;

function snapshot() {
  return { ...requests };
}

function delta(before: Record<Kind, number>): Record<string, number> {
  return Object.fromEntries((Object.entries(requests) as Array<[Kind, number]>)
    .map(([kind, value]): [Kind, number] => [kind, value - before[kind]])
    .filter(([, value]) => value !== 0));
}

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.floor(sorted.length / 2)].toFixed(1));
};
const p95 = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(1));
};

function checked<T extends { error: unknown }>(result: T, what: string): T {
  if (result.error) throw new Error(`${what}: ${(result.error as { message?: string }).message ?? String(result.error)}`);
  return result;
}

async function main() {
  const configuration = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Record<string, string>;
  const iterations = Number(process.argv[3] ?? 20);
  const url = configuration.API_URL;
  if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
    throw new Error('This probe only runs against a local Supabase stack.');
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = configuration.ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = configuration.SERVICE_ROLE_KEY;

  const admin = createClient(url, configuration.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const anon = createClient(url, configuration.ANON_KEY, { auth: { persistSession: false } });

  const owner = checked(await admin.auth.admin.createUser({
    email: `copies-${randomUUID()}@example.invalid`, password: randomUUID(), email_confirm: true,
  }), 'owner');
  const ownerId = owner.data.user!.id;

  const [width, height] = [1200, 1600];
  const original = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 60 }).toBuffer();
  const preview = await sharp(original).resize(540).webp({ quality: 70 }).toBuffer();

  async function seedPost(label: string) {
    const postId = randomUUID();
    const originalPath = `private-posts/${postId}/0/${label}.jpg`;
    const previewPath = `private-posts/${postId}/0/${label}.preview.0123456789abcdef.webp`;
    checked(await admin.storage.from('post_media').upload(originalPath, new Blob([original], { type: 'image/jpeg' }), {
      contentType: 'image/jpeg', cacheControl: '300',
    }), 'upload original');
    checked(await admin.storage.from('post_media').upload(previewPath, new Blob([preview], { type: 'image/webp' }), {
      contentType: 'image/webp', cacheControl: '86400',
    }), 'upload preview');
    checked(await admin.from('posts').insert({
      id: postId, user_id: ownerId, visibility: 'private', category: 'image', source_kind: 'external',
      post_format: 'media', title: `Public copies ${label}`, showcase_asset_path: originalPath,
    }), 'post');
    checked(await admin.from('post_media').insert({
      post_id: postId, storage_path: originalPath, preview_storage_path: previewPath, preview_status: 'ready',
      media_kind: 'image', content_type: 'image/jpeg', original_name: `${label}.jpg`, width, height, sort_order: 0,
    }), 'post media');
    checked(await admin.from('posts').update({ visibility: 'public' }).eq('id', postId), 'make public');
    return { postId, originalPath, previewPath };
  }

  async function descriptor(postId: string) {
    const item = (await loadPostMediaItemsMap(admin, [postId])).get(postId)?.[0];
    if (!item) throw new Error('No media descriptor');
    return item;
  }

  async function routeView(path: string, authorization?: string) {
    const started = performance.now();
    const request = new Request(`http://localhost:3000/api/media?${new URLSearchParams({ bucket: 'post_media', path })}`, {
      headers: authorization ? { Authorization: authorization } : {},
    });
    const response = await getPostMediaRouteResponse(request, {
      createServiceClient: () => admin,
      createMediaSupabaseClient: async () => (authorization
        ? createClient(url, configuration.ANON_KEY, {
          auth: { persistSession: false },
          global: { headers: { Authorization: authorization } },
        })
        : anon),
    });
    const routed = performance.now();
    if (response.status !== 302) throw new Error(`/api/media answered ${response.status}`);
    const media = await fetch(response.headers.get('location')!);
    const bytes = (await media.arrayBuffer()).byteLength;
    return { routeMs: routed - started, totalMs: performance.now() - started, bytes, status: media.status };
  }

  async function directView(mediaUrl: string) {
    const started = performance.now();
    const media = await fetch(mediaUrl);
    const bytes = (await media.arrayBuffer()).byteLength;
    return { totalMs: performance.now() - started, bytes, status: media.status };
  }

  const report: Record<string, unknown> = { iterations, originalBytes: original.byteLength, previewBytes: preview.byteLength };

  // ---- Before: the authorized route --------------------------------------
  const measured = await seedPost('measured');
  const before = await descriptor(measured.postId);
  report.beforeUrls = { url: before.url, previewUrl: before.previewUrl };
  if (!before.url.startsWith('/api/media?')) throw new Error('Expected the authorized route before any copy');

  resetPostMediaSignaturesForTests();
  let requestsBefore = snapshot();
  const coldSignedOut = await routeView(measured.originalPath);
  report.beforeColdSignedOut = { ...coldSignedOut, requests: delta(requestsBefore) };

  const warm: Array<{ routeMs: number; totalMs: number }> = [];
  requestsBefore = snapshot();
  for (let index = 0; index < iterations; index += 1) warm.push(await routeView(measured.originalPath));
  report.beforeWarmSignedOut = {
    routeMedianMs: median(warm.map((view) => view.routeMs)),
    totalMedianMs: median(warm.map((view) => view.totalMs)),
    totalP95Ms: p95(warm.map((view) => view.totalMs)),
    requestsPerView: Object.fromEntries(Object.entries(delta(requestsBefore)).map(([kind, value]) => [kind, value / iterations])),
    functionInvocationsPerView: 1,
  };

  const viewerPassword = randomUUID();
  const viewer = checked(await admin.auth.admin.createUser({
    email: `viewer-${randomUUID()}@example.invalid`, password: viewerPassword, email_confirm: true,
  }), 'viewer');
  const session = checked(await anon.auth.signInWithPassword({
    email: viewer.data.user!.email!, password: viewerPassword,
  }), 'viewer sign-in');
  const bearer = `Bearer ${session.data.session!.access_token}`;
  resetPostMediaSignaturesForTests();
  const signedIn: Array<{ routeMs: number; totalMs: number }> = [];
  requestsBefore = snapshot();
  for (let index = 0; index < iterations; index += 1) signedIn.push(await routeView(measured.originalPath, bearer));
  report.beforeSignedIn = {
    routeMedianMs: median(signedIn.map((view) => view.routeMs)),
    totalMedianMs: median(signedIn.map((view) => view.totalMs)),
    totalP95Ms: p95(signedIn.map((view) => view.totalMs)),
    requestsPerView: Object.fromEntries(Object.entries(delta(requestsBefore)).map(([kind, value]) => [kind, value / iterations])),
    functionInvocationsPerView: 1,
  };

  // ---- The copy publish makes ---------------------------------------------
  requestsBefore = snapshot();
  const syncStarted = performance.now();
  const synced = await syncPostMediaPublicCopies(admin, measured.postId);
  report.sync = { ...synced, ms: Number((performance.now() - syncStarted).toFixed(1)), requests: delta(requestsBefore) };

  // ---- After: the public copy ----------------------------------------------
  const after = await descriptor(measured.postId);
  report.afterUrls = { url: after.url, previewUrl: after.previewUrl };
  if (!after.url.includes('/storage/v1/object/public/showcase_media/public-posts/')) throw new Error('Expected the public copy');
  const direct: Array<{ totalMs: number; bytes: number }> = [];
  requestsBefore = snapshot();
  for (let index = 0; index < iterations; index += 1) direct.push(await directView(after.url));
  report.after = {
    totalMedianMs: median(direct.map((view) => view.totalMs)),
    totalP95Ms: p95(direct.map((view) => view.totalMs)),
    bytes: direct[0].bytes,
    requestsPerView: Object.fromEntries(Object.entries(delta(requestsBefore)).map(([kind, value]) => [kind, value / iterations])),
    functionInvocationsPerView: 0,
  };

  // ---- Every reverse path, on the real database and Storage -----------------
  async function publicObjectsOf(postId: string) {
    const listed = checked(await admin.storage.from('showcase_media').list(`public-posts/${postId}/0`), 'list copies');
    return (listed.data ?? []).map((entry) => entry.name).sort();
  }
  async function expectServed(postId: string, served: boolean, label: string) {
    const item = await descriptor(postId);
    const isCopy = item.url.includes('/public-posts/');
    if (isCopy !== served) throw new Error(`${label}: expected ${served ? 'the copy' : '/api/media'}, got ${item.url}`);
  }
  const paths: Record<string, unknown> = {};
  async function reversePath(label: string, end: (post: Awaited<ReturnType<typeof seedPost>>) => Promise<void>) {
    const post = await seedPost(label.replace(/\W+/g, '-'));
    await syncPostMediaPublicCopies(admin, post.postId);
    const copiedBefore = await publicObjectsOf(post.postId);
    const copyUrl = (await descriptor(post.postId)).url;
    await end(post);
    const queued = checked(await admin.from('post_media_public_copy_queue').select('public_path, reason').eq('post_id', post.postId), 'queue');
    const recordedAfterWrite = checked(await admin.from('post_media').select('public_copy_paths').eq('post_id', post.postId), 'rows');
    const removal = await removeQueuedPostMediaPublicCopies(admin, { postId: post.postId });
    const left = await publicObjectsOf(post.postId);
    const fetchedAfter = (await nativeFetch(copyUrl)).status;
    if (copiedBefore.length !== 2 || left.length !== 0 || fetchedAfter < 400) {
      throw new Error(`${label}: copies ${copiedBefore.length} → ${left.length}, public URL answered ${fetchedAfter}`);
    }
    paths[label] = {
      queuedReasons: [...new Set((queued.data ?? []).map((row) => (row as { reason: string }).reason))],
      recordedAfterWrite: (recordedAfterWrite.data ?? []).reduce((sum, row) => sum + ((row as { public_copy_paths: string[] }).public_copy_paths?.length ?? 0), 0),
      removed: removal.removed,
      publicObjectsLeft: left.length,
      publicUrlStatusAfter: fetchedAfter,
    };
    return post;
  }

  const madePrivate = await reversePath('made private', async ({ postId }) => {
    checked(await admin.from('posts').update({ visibility: 'private' }).eq('id', postId), 'private');
    await expectServed(postId, false, 'made private');
  });
  // Back to public: publish's path makes the copies again.
  checked(await admin.from('posts').update({ visibility: 'public' }).eq('id', madePrivate.postId), 'public again');
  const again = await syncPostMediaPublicCopies(admin, madePrivate.postId);
  await expectServed(madePrivate.postId, true, 'public again');
  paths['made public again'] = { committed: again.committed };

  await reversePath('archived', async ({ postId }) => {
    checked(await admin.from('posts').update({ archived_at: new Date().toISOString() }).eq('id', postId), 'archive');
  });
  await reversePath('hidden by moderation', async ({ postId }) => {
    checked(await admin.from('posts').update({ review_status: 'hidden' }).eq('id', postId), 'hide');
  });
  await reversePath('marked NSFW', async ({ postId }) => {
    checked(await admin.from('posts').update({ is_nsfw: true }).eq('id', postId), 'nsfw');
  });
  await reversePath('tombstoned', async ({ postId }) => {
    const now = new Date().toISOString();
    checked(await admin.from('posts').update({ tombstoned_at: now, archived_at: now, visibility: 'private' }).eq('id', postId), 'tombstone');
  });
  await reversePath('gallery replaced', async ({ postId }) => {
    checked(await admin.from('post_media').delete().eq('post_id', postId), 'gallery delete');
  });
  await reversePath('deleted', async ({ postId }) => {
    checked(await admin.from('posts').delete().eq('id', postId), 'delete');
  });
  const leaver = checked(await admin.auth.admin.createUser({
    email: `leaver-${randomUUID()}@example.invalid`, password: randomUUID(), email_confirm: true,
  }), 'leaver');
  const ownerBefore = ownerId;
  await reversePath('owner deleting the account', async ({ postId }) => {
    checked(await admin.from('posts').update({ user_id: leaver.data.user!.id }).eq('id', postId), 'hand to leaver');
    checked(await admin.from('profiles').update({ identity_state: 'deleting' }).eq('id', leaver.data.user!.id), 'deleting');
  });
  report.reversePaths = paths;
  report.ownerId = ownerBefore;
  report.measuredPostId = measured.postId;

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  globalThis.fetch = nativeFetch;
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
