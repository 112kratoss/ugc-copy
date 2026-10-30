import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { secureNsfwPostMedia } from '@/lib/nsfw-media-security';
const id = 'ab290002-1000-4000-8000-000000000003';
const path = `posts/${id}/photo.jpg`;
function fixture({
  alreadyCopied = false,
  commitFails = false,
  removeFails = false,
  post = {} as Record<string, unknown>,
  publicPath = path,
} = {}) {
  const events: string[] = [];
  const copy = vi.fn(async () => { events.push('copy'); return { error: null }; });
  const remove = vi.fn(async () => { events.push('remove'); return { error: removeFails ? new Error('offline') : null }; });
  const client = {
    from(table: string) {
      let update = false;
      let selected: string[] | null = null;
      const postRow: Record<string, unknown> = {
        id, user_id: 'owner', generation_id: null, showcase_asset_path: alreadyCopied ? `private-${publicPath}` : publicPath, ...post,
      };
      const data = table === 'post_media' ? [] : [{ public_path: publicPath }];
      const query = {
        select: (columns?: string) => { selected = columns ? columns.split(',').map((column) => column.trim()) : null; return query; },
        eq: () => query, like: () => query, is: () => query,
        update: () => { update = true; return query; },
        // The post with only the columns the read asked for, as PostgREST answers.
        maybeSingle: async () => ({
          data: Object.fromEntries((selected ?? Object.keys(postRow)).map((column) => [column, postRow[column]])),
          error: null,
        }),
        then: (resolve: (value: unknown) => void) => { if (update) events.push('settled'); resolve({ data, error: null }); },
      };
      return query;
    },
    rpc: vi.fn(async () => { events.push('commit'); return { error: commitFails ? new Error('unverified') : null }; }),
    storage: { from: () => ({ copy, remove, exists: async () => ({ data: false, error: null }) }) },
  };
  return { client: client as unknown as SupabaseClient, events, copy, remove };
}
it('commits verified descriptors before removing public bytes', async () => {
  const { client, events } = fixture();
  await secureNsfwPostMedia(client, id, 'owner');
  expect(events).toEqual(['copy', 'commit', 'remove', 'settled']);
});
it('does not delete public media when the atomic copy commit fails', async () => {
  const { client, remove } = fixture({ commitFails: true });
  await expect(secureNsfwPostMedia(client, id, 'owner')).rejects.toThrow('unverified');
  expect(remove).not.toHaveBeenCalled();
});
it('retries durable revocations after a previous request moved the descriptors', async () => {
  const { client, copy, events } = fixture({ alreadyCopied: true });
  await secureNsfwPostMedia(client, id, 'owner');
  expect(copy).not.toHaveBeenCalled();
  expect(events).toEqual(['remove', 'settled']);
});
it('leaves failed revocation pending and rejects the label change', async () => {
  const { client, events } = fixture({ alreadyCopied: true, removeFails: true });
  await expect(secureNsfwPostMedia(client, id, 'owner')).rejects.toThrow('revoke');
  expect(events).toEqual(['remove']);
});
// Deleting a creation keeps its post and the copy in the creation's folder;
// the post records the creation in `deleted_generation_id`.
const deletedCreationCopy = 'showcase/ab290009-1000-4000-8000-000000000009/output.abc123.jpg';
it('secures the copy a post keeps of its deleted creation', async () => {
  const { client, events, copy } = fixture({
    post: { deleted_generation_id: 'ab290009-1000-4000-8000-000000000009' },
    publicPath: deletedCreationCopy,
  });
  await secureNsfwPostMedia(client, id, 'owner');
  expect(copy).toHaveBeenCalledWith(
    deletedCreationCopy,
    expect.stringMatching(new RegExp(`^private-posts/${id}/[0-9a-f]{16}-output\\.abc123\\.jpg$`)),
    { destinationBucket: 'post_media' },
  );
  expect(events).toEqual(['copy', 'commit', 'remove', 'settled']);
});
it('still refuses a creation folder the post did not record', async () => {
  const { client, copy } = fixture({ publicPath: deletedCreationCopy });
  await expect(secureNsfwPostMedia(client, id, 'owner')).rejects.toThrow('Unsupported post media location.');
  expect(copy).not.toHaveBeenCalled();
});
