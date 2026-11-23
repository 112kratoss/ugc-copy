import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { applyPostModerationAction, revokePostPublicMedia } from '@/lib/moderation-ops';

const POST = '20000000-0000-4000-8000-000000000002';
const OWNER = '70000000-0000-4000-8000-000000000007';
const REVIEWER = '30000000-0000-4000-8000-000000000003';
const ORIGINAL = `private-posts/${POST}/0/photo.jpg`;
const PREVIEW = `private-posts/${POST}/0/photo.preview.0123456789abcdef.webp`;
const ORIGINAL_COPY = `public-posts/${POST}/0/photo.jpg`;
const PREVIEW_COPY = `public-posts/${POST}/0/photo.preview.0123456789abcdef.webp`;

/**
 * A post made from uploads whose public copies the database already took
 * back (the moderation RPC's own write) and queued: what the operator's
 * actions must remove from the public bucket at once.
 */
function moderatedUploadPost({
  action,
  objectsStay = false,
}: {
  action: 'hide' | 'take_down' | 'restore';
  objectsStay?: boolean;
}) {
  const objects = new Set<string>([
    `post_media/${ORIGINAL}`, `post_media/${PREVIEW}`,
    `showcase_media/${ORIGINAL_COPY}`, `showcase_media/${PREVIEW_COPY}`,
  ]);
  const queue = new Map<string, { public_path: string; post_id: string; claim_token: string | null }>(
    action === 'restore' ? [] : [ORIGINAL_COPY, PREVIEW_COPY].map((path) => [path, { public_path: path, post_id: POST, claim_token: null }]),
  );
  const removed: string[] = [];
  const rpcNames: string[] = [];

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    rpcNames.push(name);
    if (name === 'apply_admin_post_moderation') {
      return {
        data: {
          status: 'applied',
          action,
          action_id: '60000000-0000-4000-8000-000000000006',
          post_id: POST,
          media_revocation_required: action === 'take_down',
        },
        error: null,
      };
    }
    if (name === 'claim_post_media_public_copy_removal') {
      const row = queue.get(args.p_copy_path as string);
      if (!row) return { data: { outcome: 'gone' }, error: null };
      row.claim_token = `token-${row.public_path}`;
      return { data: { outcome: 'claimed', token: row.claim_token }, error: null };
    }
    if (name === 'finish_post_media_public_copy_removal') {
      const row = queue.get(args.p_copy_path as string);
      if (row && row.claim_token === args.p_claim_token) queue.delete(row.public_path);
      return { data: true, error: null };
    }
    if (name === 'reschedule_post_media_public_copy_removal') {
      const row = queue.get(args.p_copy_path as string);
      if (row) row.claim_token = null;
      return { data: null, error: null };
    }
    if (name === 'begin_post_media_public_copies') return { data: [], error: null };
    throw new Error(`unexpected rpc ${name}`);
  });

  const result = (data: unknown) => {
    const query = {
      select: () => query,
      eq: () => query,
      lte: () => query,
      order: () => query,
      maybeSingle: async () => ({ data, error: null }),
      limit: async () => ({ data, error: null }),
      then: (resolve: (value: { data: unknown; error: null }) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
    };
    return query;
  };
  const from = vi.fn((table: string) => {
    if (table === 'posts') {
      return result({
        id: POST, user_id: OWNER, generation_id: null, deleted_generation_id: null,
        showcase_asset_path: ORIGINAL, output_url: null,
      });
    }
    if (table === 'post_media') {
      return result([{
        storage_path: ORIGINAL, preview_storage_path: PREVIEW, display_storage_path: null,
        rendition_storage_path: null, teaser_storage_path: null, external_url: null,
      }]);
    }
    if (table === 'post_media_public_copy_queue') return result([...queue.values()]);
    throw new Error(`Unexpected table ${table}`);
  });
  const storage = {
    from: (bucket: string) => ({
      remove: async (paths: string[]) => {
        for (const path of paths) {
          removed.push(`${bucket}/${path}`);
          if (!objectsStay) objects.delete(`${bucket}/${path}`);
        }
        return { data: [], error: null };
      },
      exists: async (path: string) => ({ data: objects.has(`${bucket}/${path}`), error: null }),
    }),
  };

  return { client: { rpc, from, storage } as unknown as SupabaseClient, objects, queue, removed, rpcNames };
}

describe('moderation and the public copies of a post\'s uploaded media', () => {
  it('a take-down removes the public copies with the private objects, each verified gone', async () => {
    const post = moderatedUploadPost({ action: 'take_down' });

    const result = await revokePostPublicMedia(post.client, POST);

    expect(result).toMatchObject({ revokedMediaCount: 4, mediaRevocationVerified: true });
    expect(post.removed).toEqual(expect.arrayContaining([
      `post_media/${ORIGINAL}`, `post_media/${PREVIEW}`,
      `showcase_media/${ORIGINAL_COPY}`, `showcase_media/${PREVIEW_COPY}`,
    ]));
    expect([...post.objects]).toEqual([]);
    // Their queue rows are settled too.
    expect(post.queue.size).toBe(0);
  });

  it('a take-down fails loudly when a public copy survives the removal', async () => {
    const post = moderatedUploadPost({ action: 'take_down', objectsStay: true });
    await expect(revokePostPublicMedia(post.client, POST)).rejects.toThrow('still exists');
  });

  it('a hide removes the copies it queued at once, keeping the private media for the owner and buyers', async () => {
    const post = moderatedUploadPost({ action: 'hide' });

    const result = await applyPostModerationAction(post.client, {
      postId: POST, reviewerId: REVIEWER, action: 'hide', reason: 'Under review', idempotencyKey: 'hide-1',
    });

    expect(result).toMatchObject({ status: 'applied', action: 'hide' });
    expect(post.removed.sort()).toEqual([`showcase_media/${ORIGINAL_COPY}`, `showcase_media/${PREVIEW_COPY}`]);
    expect(post.objects.has(`post_media/${ORIGINAL}`)).toBe(true);
    expect(post.queue.size).toBe(0);
  });

  it('a hide tells the operator when a copy could not be removed yet', async () => {
    const post = moderatedUploadPost({ action: 'hide', objectsStay: true });

    await expect(applyPostModerationAction(post.client, {
      postId: POST, reviewerId: REVIEWER, action: 'hide', reason: 'Under review', idempotencyKey: 'hide-2',
    })).rejects.toThrow('could not be removed yet');
    // Still queued for the job.
    expect(post.queue.size).toBe(2);
  });

  it('a restore makes the copies again', async () => {
    const post = moderatedUploadPost({ action: 'restore' });

    await applyPostModerationAction(post.client, {
      postId: POST, reviewerId: REVIEWER, action: 'restore', reason: 'Report dismissed', idempotencyKey: 'restore-1',
    });

    expect(post.rpcNames).toContain('begin_post_media_public_copies');
    expect(post.removed).toEqual([]);
  });
});
