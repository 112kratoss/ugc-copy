import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { secureNsfwPostMedia } from '@/lib/nsfw-media-security';
const id = 'ab290002-1000-4000-8000-000000000003';
const path = `posts/${id}/photo.jpg`;
function fixture({ alreadyCopied = false, commitFails = false, removeFails = false } = {}) {
  const events: string[] = [];
  const copy = vi.fn(async () => { events.push('copy'); return { error: null }; });
  const remove = vi.fn(async () => { events.push('remove'); return { error: removeFails ? new Error('offline') : null }; });
  const client = {
    from(table: string) {
      let update = false;
      const data = table === 'posts' ? { id, user_id: 'owner', showcase_asset_path: alreadyCopied ? `private-${path}` : path }
        : table === 'post_media' ? [] : [{ public_path: path }];
      const query = {
        select: () => query, eq: () => query, like: () => query, is: () => query,
        update: () => { update = true; return query; },
        maybeSingle: async () => ({ data, error: null }),
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
