import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { secureNsfwPostMedia } from '@/lib/nsfw-media-security';
const id = 'ab290002-1000-4000-8000-000000000003';
const path = `posts/${id}/photo.jpg`;
function fixture({
  alreadyCopied = false,
  commitFails = false,
  removeFails = false,
  thumbRemoveFails = false,
  post = {} as Record<string, unknown>,
  publicPath = path,
  media = [] as Array<Record<string, unknown>>,
} = {}) {
  const events: string[] = [];
  const copy = vi.fn(async () => { events.push('copy'); return { error: null }; });
  const remove = vi.fn(async (paths: string[]) => {
    const thumbs = paths.every((candidate) => candidate.includes('.thumb.'));
    events.push(thumbs ? 'remove thumbs' : 'remove');
    return { error: (thumbs ? thumbRemoveFails : removeFails) ? new Error('offline') : null };
  });
  const client = {
    from(table: string) {
      let update = false;
      let selected: string[] | null = null;
      const postRow: Record<string, unknown> = {
        id, user_id: 'owner', generation_id: null, showcase_asset_path: alreadyCopied ? `private-${publicPath}` : publicPath, ...post,
      };
      const data = table === 'post_media' ? media : [{ public_path: publicPath }];
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
// A creation post's cover carries the row thumb search draws (20261123152813).
const creationId = 'ab290009-1000-4000-8000-000000000009';
const coverPreview = `showcase/${creationId}/output.abc123.preview.0123456789abcdef.webp`;
const coverThumb = `showcase/${creationId}/output.abc123.thumb.fedcba9876543210.webp`;
const coverMedia = [{
  storage_path: deletedCreationCopy,
  preview_storage_path: coverPreview,
  display_storage_path: null,
  rendition_storage_path: null,
  teaser_storage_path: null,
  thumb_storage_path: coverThumb,
  external_url: null,
}];
it("removes a labelled post's row thumb from the public bucket and never copies it", async () => {
  const { client, copy, remove, events } = fixture({
    post: { generation_id: creationId },
    publicPath: deletedCreationCopy,
    media: coverMedia,
  });
  await secureNsfwPostMedia(client, id, 'owner');
  // The source and its preview are copied private; the thumb is not.
  expect(copy.mock.calls.map((call) => (call as unknown[])[0]).sort()).toEqual([deletedCreationCopy, coverPreview].sort());
  expect(remove).toHaveBeenLastCalledWith([coverThumb]);
  expect(events.at(-1)).toBe('remove thumbs');
});
it("leaves a thumb it could not remove to the revocation queue rather than fail the label", async () => {
  const { client, events } = fixture({
    post: { generation_id: creationId },
    publicPath: deletedCreationCopy,
    media: coverMedia,
    thumbRemoveFails: true,
  });
  await expect(secureNsfwPostMedia(client, id, 'owner')).resolves.toBeInstanceOf(Map);
  expect(events.at(-1)).toBe('remove thumbs');
});
it("never removes a thumb outside the post's own folders", async () => {
  const { client, remove } = fixture({
    post: { generation_id: creationId },
    publicPath: deletedCreationCopy,
    media: [{ ...coverMedia[0], thumb_storage_path: 'showcase/ab290099-1000-4000-8000-000000000099/other.thumb.ab.webp' }],
  });
  await secureNsfwPostMedia(client, id, 'owner');
  expect(remove.mock.calls.flat(2)).not.toContain('showcase/ab290099-1000-4000-8000-000000000099/other.thumb.ab.webp');
});
