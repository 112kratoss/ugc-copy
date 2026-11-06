import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const notify = vi.hoisted(() => vi.fn());
const isBlocked = vi.hoisted(() => vi.fn());
vi.mock('@/lib/mobile-notifications', async (importOriginal) => ({
  createMobileNotification: notify,
  buildMobileNotificationDeepLink:
    (await importOriginal<typeof import('@/lib/mobile-notifications')>()).buildMobileNotificationDeepLink,
}));
vi.mock('@/lib/moderation-service', () => ({ isUserRelationshipBlocked: isBlocked }));
vi.mock('@/lib/showcase-feed-events-service', () => ({ recordAuthoritativeFeedEvent: vi.fn() }));

import { notifyPostedRemix, remixAlertWords } from '@/lib/completed-remix-notification';

type PostRow = {
  id: string;
  user_id: string | null;
  generation_id: string | null;
  deleted_generation_id: string | null;
  visibility: string;
  review_status: string | null;
  archived_at: string | null;
  tombstoned_at: string | null;
  remix_parent_post_id: string | null;
  remix_parent_user_id: string | null;
};

/**
 * A database holding `posts` by id, each account's handle, and the guests
 * linked to each account (`profiles.merged_into_user_id`).
 */
function database({
  posts,
  handles = {},
  linked = {},
}: {
  posts: Record<string, PostRow | { id: string }>;
  handles?: Record<string, string>;
  linked?: Record<string, string[]>;
}) {
  const from = vi.fn((table: string) => {
    let filter: { column: string; value: string } | null = null;
    const read = {
      select: () => read,
      eq: (column: string, value: string) => {
        filter = { column, value };
        return read;
      },
      maybeSingle: async () => {
        if (table === 'posts') return { data: (filter && posts[filter.value]) ?? null, error: null };
        if (table === 'profiles' && filter?.column === 'id') {
          return { data: handles[filter.value] ? { username: handles[filter.value] } : null, error: null };
        }
        throw new Error(`Unexpected read of ${table}`);
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({
        data: (table === 'profiles' && filter?.column === 'merged_into_user_id' ? linked[filter.value] ?? [] : [])
          .map((id) => ({ id })),
        error: null,
      }).then(resolve),
    };
    return read;
  });
  return { db: { from } as unknown as SupabaseClient, from };
}

const remixPost: PostRow = {
  id: 'post-b',
  user_id: 'maya',
  generation_id: 'generation-b',
  deleted_generation_id: null,
  visibility: 'public',
  review_status: 'visible',
  archived_at: null,
  tombstoned_at: null,
  remix_parent_post_id: 'post-a',
  remix_parent_user_id: 'cora',
};

describe('the alert for a remix posted publicly', () => {
  beforeEach(() => {
    notify.mockReset().mockResolvedValue(null);
    isBlocked.mockReset().mockResolvedValue(false);
  });

  it('names the remixer to the creator of the post remixed and opens the remix', async () => {
    const { db } = database({ posts: { 'post-b': remixPost, 'post-a': { id: 'post-a' } }, handles: { maya: 'maya' } });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'cora',
      actorUserId: 'maya',
      type: 'post_remixed',
      category: 'social',
      title: '@maya posted a remix of your post',
      body: 'Their version is public now.',
      deepLink: '/showcase/post-b',
      objectType: 'post',
      objectId: 'post-a',
      // Once per creation: taken down and posted again is not news twice.
      dedupeKey: 'posted-remix:generation-b',
    }));
    expect(isBlocked).toHaveBeenCalledWith(expect.objectContaining({ firstUserId: 'cora', secondUserId: 'maya' }));
  });

  // Made private and public again after its creation was deleted, the post is
  // still the one A was told about.
  it('keeps the creation\'s key once the creation is deleted', async () => {
    const { db } = database({
      posts: { 'post-b': { ...remixPost, generation_id: null, deleted_generation_id: 'generation-b' }, 'post-a': { id: 'post-a' } },
      handles: { maya: 'maya' },
    });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'posted-remix:generation-b' }));
  });

  it('keys on the post when it never had a creation on record', async () => {
    const { db } = database({
      posts: { 'post-b': { ...remixPost, generation_id: null }, 'post-a': { id: 'post-a' } },
      handles: { maya: 'maya' },
    });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'posted-remix:post-b' }));
  });

  it('sends it for a post from before review statuses', async () => {
    const { db } = database({
      posts: { 'post-b': { ...remixPost, review_status: null }, 'post-a': { id: 'post-a' } },
      handles: { maya: 'maya' },
    });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('names no one, and opens the post remixed, for a remixer with no handle', async () => {
    const { db } = database({ posts: { 'post-b': remixPost, 'post-a': { id: 'post-a' } } });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Someone posted a remix of your post',
      deepLink: '/showcase/post-a',
    }));
  });

  it.each([
    ['a post that is not public', { ...remixPost, visibility: 'private' }],
    // Its link would open nothing, and the one alert it may send would be spent.
    ['an archived post', { ...remixPost, archived_at: '2026-11-05T10:00:00.000Z' }],
    ['a post taken down', { ...remixPost, tombstoned_at: '2026-11-05T10:00:00.000Z' }],
    ['a post moderation holds', { ...remixPost, review_status: 'hidden' }],
    ['a post that is no remix', { ...remixPost, remix_parent_post_id: null, remix_parent_user_id: null }],
    ['a remix of one\'s own post', { ...remixPost, remix_parent_user_id: 'maya' }],
  ])('sends nothing for %s', async (_case, post) => {
    const { db } = database({ posts: { 'post-b': post, 'post-a': { id: 'post-a' } }, handles: { maya: 'maya' } });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends nothing for a remix by a guest linked to the creator', async () => {
    const { db } = database({
      posts: { 'post-b': { ...remixPost, user_id: 'guest-of-cora' }, 'post-a': { id: 'post-a' } },
      linked: { cora: ['guest-of-cora'] },
    });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).not.toHaveBeenCalled();
  });

  // Deleted while it had buyers, it is kept for them alone: still a row, no longer the creator's post.
  it('sends nothing for a post remixed that its creator deleted and its buyers keep', async () => {
    const { db } = database({
      posts: { 'post-b': remixPost, 'post-a': { id: 'post-a', tombstoned_at: '2026-11-05T10:00:00.000Z' } as { id: string } },
      handles: { maya: 'maya' },
    });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends nothing once the post remixed is deleted', async () => {
    const { db } = database({ posts: { 'post-b': remixPost }, handles: { maya: 'maya' } });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends nothing across a block, either way round', async () => {
    isBlocked.mockResolvedValue(true);
    const { db } = database({ posts: { 'post-b': remixPost, 'post-a': { id: 'post-a' } }, handles: { maya: 'maya' } });
    await notifyPostedRemix(db, { postId: 'post-b' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('never throws, whatever fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    isBlocked.mockRejectedValue(new Error('user_blocks unavailable'));
    const { db } = database({ posts: { 'post-b': remixPost, 'post-a': { id: 'post-a' } } });
    await expect(notifyPostedRemix(db, { postId: 'post-b' })).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

// The database's `unnamed_remix_alert_words` (20261105175342) matches these
// titles to take a name back out: the words here and there change together.
describe('remix alert words', () => {
  it.each([
    ['finished', '@maya remixed your post', '/creators/maya'],
    ['posted', '@maya posted a remix of your post', '/showcase/post-b'],
  ] as const)('names the remixer when %s', (event, title, deepLink) => {
    expect(remixAlertWords(event, { remixerHandle: 'maya', remixedPostId: 'post-a', remixPostId: 'post-b' }))
      .toMatchObject({ title, deepLink });
  });

  it.each([
    ['finished', 'Someone remixed your post'],
    ['posted', 'Someone posted a remix of your post'],
  ] as const)('names no one when %s without a handle, and opens the post remixed', (event, title) => {
    expect(remixAlertWords(event, { remixerHandle: null, remixedPostId: 'post-a', remixPostId: 'post-b' }))
      .toMatchObject({ title, deepLink: '/showcase/post-a' });
  });

  it('matches the patterns the database unnames', async () => {
    const { readFileSync } = await import('node:fs');
    const migration = readFileSync(
      'supabase/migrations/20261105175342_unname_remix_alerts_across_blocks_and_deletion.sql',
      'utf8',
    );
    // The unnaming function's own patterns (the rename's words sit beside it).
    const unnaming = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.unnamed_remix_alert_words('),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.renamed_remix_alert_words('),
    );
    const patterns = [...unnaming.matchAll(/p_title ~ '([^']+)'/g)].map((match) => new RegExp(match[1].replace(/\\\\S/g, '\\S')));
    expect(patterns).toHaveLength(2);
    const named = [
      remixAlertWords('finished', { remixerHandle: 'maya', remixedPostId: 'post-a' }).title,
      remixAlertWords('posted', { remixerHandle: 'maya', remixedPostId: 'post-a', remixPostId: 'post-b' }).title,
    ];
    named.forEach((title, index) => expect(patterns[index].test(title)).toBe(true));
    // And the unnamed words are what it writes back.
    expect(migration).toContain(`'${remixAlertWords('finished', { remixerHandle: null, remixedPostId: 'p' }).title}'`);
    expect(migration).toContain(`'${remixAlertWords('posted', { remixerHandle: null, remixedPostId: 'p' }).title}'`);
  });

  // 20261105175342's words for a remixer's handle, which its insert trigger and
  // 20261105175343's rename write.
  it('matches the words the database writes for a new handle', async () => {
    const { readFileSync } = await import('node:fs');
    const migration = readFileSync('supabase/migrations/20261105175342_unname_remix_alerts_across_blocks_and_deletion.sql', 'utf8');
    const finished = remixAlertWords('finished', { remixerHandle: 'ivy-two', remixedPostId: 'post-a' });
    const posted = remixAlertWords('posted', { remixerHandle: 'ivy-two', remixedPostId: 'post-a', remixPostId: 'post-b' });
    expect(finished.title).toBe('@ivy-two remixed your post');
    expect(finished.deepLink).toBe('/creators/ivy-two');
    expect(posted.title).toBe('@ivy-two posted a remix of your post');
    expect(migration).toContain("title := '@' || v_handle || ' remixed your post';");
    expect(migration).toContain("deep_link := '/creators/' || v_handle;");
    expect(migration).toContain("title := '@' || v_handle || ' posted a remix of your post';");
  });
});
