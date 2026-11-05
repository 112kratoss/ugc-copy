import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  buildRemixCredit,
  readRemixCredit,
  remixCreditLabel,
  remixCreditSegments,
  remixCreditUserIds,
  remixingNotice,
  withoutBlockedRemixCredit,
  type RemixCredit,
} from '../../ugc-mobile/lib/remix-credit/remix-credit';
import {
  loadPostRemixCredit,
  loadRemixCreditParents,
  postRemixCredit,
  postRemixCreditUserIds,
  remixCreditParentTitle,
} from '@/lib/post-remix-credit';
import { attachViewerStateToFeed } from '@/lib/showcase-feed';
import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

/**
 * Owner, 2026-11-05 (A posts, B remixes A, C remixes B): every remix post says
 * "Remix of “title” by @A", and "· Original by @A" when its chain began with
 * someone else; a post remixed that is gone or no longer public keeps "Original
 * by @A" and loses its link; nobody with a block between them and the viewer is
 * named.
 */

const cora = { id: 'user-cora', username: 'cora' };
const maya = { id: 'user-maya', username: 'maya' };
const lee = { id: 'user-lee', username: 'lee' };

describe('the credit a remix post carries', () => {
  it('names the post remixed and its creator', () => {
    const credit = buildRemixCredit({
      postCreatorId: maya.id,
      parentPost: { id: 'post-a', title: 'Sunset beach', linkable: true },
      parentCreator: cora,
      originCreator: cora,
    });
    expect(credit).toEqual({ parent: { postId: 'post-a', title: 'Sunset beach', creator: cora }, original: null });
    expect(remixCreditLabel(credit!)).toBe('Remix of “Sunset beach” by @cora');
  });

  it('adds the original when the chain began with someone else', () => {
    const credit = buildRemixCredit({
      postCreatorId: lee.id,
      parentPost: { id: 'post-b', title: 'Sunset, again', linkable: true },
      parentCreator: maya,
      originCreator: cora,
    });
    expect(remixCreditLabel(credit!)).toBe('Remix of “Sunset, again” by @maya · Original by @cora');
    expect(remixCreditSegments(credit!)).toEqual([
      { kind: 'text', text: 'Remix of ' },
      { kind: 'post', text: '“Sunset, again”', postId: 'post-b' },
      { kind: 'text', text: ' by ' },
      { kind: 'creator', text: '@maya', username: 'maya' },
      { kind: 'text', text: ' · ' },
      { kind: 'text', text: 'Original by ' },
      { kind: 'creator', text: '@cora', username: 'cora' },
    ]);
  });

  it.each([
    ['private, removed or archived', { id: 'post-a', title: 'Sunset beach', linkable: false }],
    ['deleted', null],
  ])('keeps "Original by" and drops the link to a post remixed that is %s', (_case, parentPost) => {
    const credit = buildRemixCredit({ postCreatorId: maya.id, parentPost, parentCreator: cora, originCreator: cora });
    expect(credit).toEqual({ parent: null, original: cora });
    expect(remixCreditLabel(credit!)).toBe('Original by @cora');
  });

  it('never names a post\'s own creator back to them as its original alone', () => {
    expect(buildRemixCredit({ postCreatorId: maya.id, parentPost: null, parentCreator: null, originCreator: maya })).toBeNull();
  });

  it('names a post\'s own creator as the original beside the post they remixed', () => {
    // Maya remixed Cora's remix of Maya's own post.
    const credit = buildRemixCredit({
      postCreatorId: maya.id,
      parentPost: { id: 'post-c', title: 'Back to me', linkable: true },
      parentCreator: cora,
      originCreator: maya,
    });
    expect(remixCreditLabel(credit!)).toBe('Remix of “Back to me” by @cora · Original by @maya');
  });

  it('carries nothing with nobody to name', () => {
    expect(buildRemixCredit({
      postCreatorId: maya.id,
      parentPost: { id: 'post-a', title: 'Sunset beach', linkable: true },
      parentCreator: null,
      originCreator: null,
    })).toBeNull();
  });

  it('leaves out anyone blocked either way, their post and their name both', () => {
    const credit: RemixCredit = {
      parent: { postId: 'post-b', title: 'Sunset, again', creator: maya },
      original: cora,
    };
    expect(remixCreditUserIds(credit)).toEqual([maya.id, cora.id]);
    expect(withoutBlockedRemixCredit(credit, (id) => id === maya.id)).toEqual({ parent: null, original: cora });
    expect(withoutBlockedRemixCredit(credit, (id) => id === cora.id)).toEqual({ parent: credit.parent, original: null });
    expect(withoutBlockedRemixCredit(credit, () => true)).toBeNull();
    expect(withoutBlockedRemixCredit(credit, () => false)).toBe(credit);
  });

  it('reads a credit from a response and nothing malformed', () => {
    const credit = { parent: { postId: 'post-a', title: ' Sunset beach ', creator: cora }, original: null };
    expect(readRemixCredit(credit)).toEqual({ parent: { postId: 'post-a', title: 'Sunset beach', creator: cora }, original: null });
    expect(readRemixCredit(undefined)).toBeNull();
    expect(readRemixCredit({ parent: { postId: 'post-a', title: 'x', creator: { id: 'u', username: '../x' } } })).toBeNull();
    expect(readRemixCredit({ parent: null, original: { id: 'u', username: 'cora' } })).toEqual({ parent: null, original: { id: 'u', username: 'cora' } });
  });
});

describe('what a remix\'s creator says', () => {
  it('names who and what is remixed, and that they will hear of it', () => {
    expect(remixingNotice({ username: 'cora', title: 'Sunset beach' })).toEqual({
      label: 'Remixing @cora’s “Sunset beach”',
      line: 'When your remix is done, @cora is told you made it.',
    });
    expect(remixingNotice({ username: 'cora', title: ' ' })?.label).toBe('Remixing @cora’s post');
  });

  it('says nothing of the kind for a remix of one\'s own creation', () => {
    expect(remixingNotice(null)).toBeNull();
    expect(remixingNotice({ username: null, title: 'Sunset beach' })).toBeNull();
  });
});

type Row = Record<string, unknown>;

/** Tables filtered as PostgREST filters them; `failing` answers with an error. */
function database(tables: Record<string, Row[]>, failing: string[] = []) {
  const reads: Array<{ table: string; column: string; values: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    const rows = tables[table];
    if (!rows) throw new Error(`Unexpected table: ${table}`);
    const filters: Array<(row: Row) => boolean> = [];
    const query = {
      select: () => query,
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return query;
      },
      in(column: string, values: unknown[]) {
        reads.push({ table, column, values });
        filters.push((row) => values.includes(row[column]));
        return query;
      },
      then<T>(resolve: (value: { data: Row[] | null; error: unknown }) => T) {
        return Promise.resolve(failing.includes(table)
          ? { data: null, error: { message: 'timeout' } }
          : { data: rows.filter((row) => filters.every((filter) => filter(row))), error: null }).then(resolve);
      },
    };
    return query;
  });
  return { client: { from } as unknown as SupabaseClient, reads };
}

const parentRow = {
  id: 'post-a',
  title: 'Sunset beach',
  body: null,
  post_format: 'media',
  visibility: 'public',
  review_status: 'visible',
  archived_at: null,
  is_nsfw: false,
};

describe('reading a remix post\'s credit', () => {
  const remixRow = { id: 'post-b', user_id: maya.id, remix_parent_post_id: 'post-a', remix_parent_user_id: cora.id, remix_origin_user_id: cora.id };
  const creatorOf = (id: string) => [cora, maya, lee].find((person) => person.id === id) ?? null;

  it('names the people its rows store, for the page\'s one profile read', () => {
    expect(postRemixCreditUserIds([remixRow, { remix_parent_user_id: maya.id, remix_origin_user_id: cora.id }, {}]))
      .toEqual([cora.id, maya.id]);
  });

  it('reads the posts remixed once for a page, and not at all with no remix on it', async () => {
    const db = database({ posts: [parentRow] });
    expect(await loadRemixCreditParents(db.client, [{}, {}])).toEqual(new Map());
    expect(db.reads).toEqual([]);

    const parents = await loadRemixCreditParents(db.client, [remixRow, { ...remixRow, id: 'post-c' }]);
    expect(parents?.get('post-a')).toEqual({ id: 'post-a', title: 'Sunset beach', linkable: true });
    expect(db.reads).toEqual([{ table: 'posts', column: 'id', values: ['post-a'] }]);
  });

  it.each([
    ['private', { visibility: 'private' }],
    ['unlisted', { visibility: 'unlisted' }],
    ['removed by moderation', { review_status: 'hidden' }],
    ['archived', { archived_at: '2026-11-05T00:00:00.000Z' }],
  ])('does not link a post remixed that is %s', async (_case, fields) => {
    const db = database({ posts: [{ ...parentRow, ...fields }] });
    const parents = await loadRemixCreditParents(db.client, [remixRow]);
    expect(parents?.get('post-a')?.linkable).toBe(false);
    expect(postRemixCredit(remixRow, parents, creatorOf)).toEqual({ parent: null, original: cora });
  });

  it('never uncovers a post remixed under its NSFW cover, nor names it by its prompt', () => {
    expect(remixCreditParentTitle({ title: 'Something', body: null, post_format: 'media', is_nsfw: true })).toBe('Mature content');
    expect(remixCreditParentTitle({ title: ' ', body: null, post_format: 'media', is_nsfw: false })).toBe('Untitled Creation');
  });

  it('leaves the credit out, unknown, when the posts remixed could not be read', async () => {
    const db = database({ posts: [] }, ['posts']);
    const parents = await loadRemixCreditParents(db.client, [remixRow]);
    expect(parents).toBeNull();
    expect(postRemixCredit(remixRow, parents, creatorOf)).toBeUndefined();
  });

  it('carries none for a post that is no remix', () => {
    expect(postRemixCredit({ user_id: maya.id }, new Map(), creatorOf)).toBeUndefined();
  });

  it('reads one post\'s credit with its people for a page that reads the post alone', async () => {
    const db = database({
      posts: [{ ...parentRow, id: 'post-b', title: 'Sunset, again' }],
      profiles: [{ id: cora.id, username: 'cora' }, { id: maya.id, username: 'maya' }],
    });
    await expect(loadPostRemixCredit(db.client, {
      user_id: lee.id,
      remix_parent_post_id: 'post-b',
      remix_parent_user_id: maya.id,
      remix_origin_user_id: cora.id,
    })).resolves.toEqual({ parent: { postId: 'post-b', title: 'Sunset, again', creator: maya }, original: cora });
  });
});

function card(id: string, overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: `https://cdn.example.com/${id}.png`,
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: id,
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-11-05T00:00:00.000Z',
    creator: { id: lee.id, username: 'lee', name: 'Lee', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: `gen-${id}`,
    asset: null,
    canRemix: true,
    remixCapability: 'public',
    remixTarget: 'image',
    ...overrides,
  };
}

describe('a card\'s credit for a signed-in viewer', () => {
  const credit: RemixCredit = { parent: { postId: 'post-b', title: 'Sunset, again', creator: maya }, original: cora };
  const page: ShowcaseFeedPage = {
    items: [card('post-c', { remixCredit: credit }), card('post-d')],
    pageInfo: { hasMore: false, nextOffset: null, limit: 2, offset: 0 },
  };

  it('asks about the people it names in the page\'s one block read, and leaves out the one blocked', async () => {
    const db = database({
      user_blocks: [{ blocker_user_id: 'viewer', blocked_user_id: maya.id }],
      post_saves: [],
      post_resource_bundle_purchases: [],
    });
    const result = await attachViewerStateToFeed(page, 'viewer', db.client as never);

    expect(result.items.map((item) => item.id)).toEqual(['post-c', 'post-d']);
    expect(result.items[0].remixCredit).toEqual({ parent: null, original: cora });
    expect(result.items[1]).not.toHaveProperty('remixCredit');
    const blockReads = db.reads.filter((read) => read.table === 'user_blocks');
    expect(blockReads).toHaveLength(2);
    for (const read of blockReads) expect(read.values).toEqual(expect.arrayContaining([lee.id, maya.id, cora.id]));
  });

  it('drops the credit whole when it names no one the viewer may see', async () => {
    const db = database({
      user_blocks: [
        { blocker_user_id: maya.id, blocked_user_id: 'viewer' },
        { blocker_user_id: 'viewer', blocked_user_id: cora.id },
      ],
      post_saves: [],
      post_resource_bundle_purchases: [],
    });
    const result = await attachViewerStateToFeed(page, 'viewer', db.client as never);
    expect(result.items[0]).not.toHaveProperty('remixCredit');
  });

  it('keeps it whole for a signed-out reader', async () => {
    const db = database({ user_blocks: [], post_saves: [], post_resource_bundle_purchases: [] });
    expect((await attachViewerStateToFeed(page, null, db.client as never)).items[0].remixCredit).toBe(credit);
  });
});

// The fixture both suites read: the three ways a credit reads, built by the
// rule the server serves them with.
describe('the remix credit in the mobile contract', () => {
  const variants = mobileApiContract.endpoints.getShowcasePost.responseVariants;
  const creator = { id: 'user-1', username: 'creator' };

  it.each([
    ['remix', variants.remix.item.remixCredit, 'Remix of “Launch frame” by @creator'],
    ['remixOfRemix', variants.remixOfRemix.item.remixCredit, 'Remix of “Launch frame, at night” by @maya · Original by @creator'],
    ['remixOfRemovedPost', variants.remixOfRemovedPost.item.remixCredit, 'Original by @creator'],
  ])('pins %s as the server builds it', (_variant, pinned, label) => {
    expect(readRemixCredit(pinned)).toEqual(pinned);
    expect(remixCreditLabel(pinned as RemixCredit)).toBe(label);
  });

  it('is what the server builds from the rows behind it', () => {
    expect(buildRemixCredit({
      postCreatorId: 'user-3',
      parentPost: { id: 'post-remix-1', title: 'Launch frame, at night', linkable: true },
      parentCreator: { id: 'user-2', username: 'maya' },
      originCreator: creator,
    })).toEqual(variants.remixOfRemix.item.remixCredit);
    expect(buildRemixCredit({
      postCreatorId: 'user-3',
      parentPost: null,
      parentCreator: { id: 'user-2', username: 'maya' },
      originCreator: creator,
    })).toEqual(variants.remixOfRemovedPost.item.remixCredit);
  });

  it('lists a post\'s remixes as cards that carry their credit', () => {
    const listed = mobileApiContract.endpoints.listPostRemixes;
    expect(listed).toMatchObject({ method: 'GET', path: '/api/showcase/posts/:postId/remixes', auth: 'optional' });
    expect(listed.response.items.every((item) => readRemixCredit(item.remixCredit)?.parent?.postId === 'post-1')).toBe(true);
  });
});
