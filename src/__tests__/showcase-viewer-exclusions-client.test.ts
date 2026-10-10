import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS } from '@/lib/showcase';
import { fetchShowcaseViewerExclusions } from '@/lib/showcase-viewer-exclusions-client';

const post = (id: string, creatorId: string | null = 'creator-1') => ({ id, creator: { id: creatorId } });
const answer = { blockedCreatorIds: ['creator-1'], hiddenCreatorIds: [], hiddenPostIds: ['post-2'] };

function answerWith(body: unknown, ok = true) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    void url;
    void init;
    return { ok, status: ok ? 200 : 500, json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('asking the server what the viewer\'s own feed leaves out', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the posts with their creators as the signed-in viewer, and hands back the answer', async () => {
    const fetchMock = answerWith(answer);

    await expect(fetchShowcaseViewerExclusions({
      items: [post('post-1'), post('post-2', null)],
      accessToken: 'viewer-token',
    })).resolves.toEqual(answer);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/showcase/viewer-exclusions');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer viewer-token', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      items: [{ postId: 'post-1', creatorId: 'creator-1' }, { postId: 'post-2', creatorId: null }],
    });
  });

  it('asks about no more posts than the server reads', async () => {
    const fetchMock = answerWith(answer);
    const items = Array.from({ length: SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS + 9 }, (_, index) => post(`post-${index}`));

    await fetchShowcaseViewerExclusions({ items, accessToken: 'viewer-token' });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).items).toHaveLength(SHOWCASE_VIEWER_EXCLUSIONS_MAX_ITEMS);
  });

  it('asks nothing about no posts', async () => {
    const fetchMock = answerWith(answer);

    await expect(fetchShowcaseViewerExclusions({ items: [], accessToken: 'viewer-token' })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // `null` tells the page to keep what it drew. An answer of the wrong shape must
  // not read as "nothing to leave out", and neither may a refusal.
  it.each([
    ['the server refuses', { error: 'Unauthorized' }, false],
    ['the answer is not the three lists', { blockedCreatorIds: ['creator-1'] }, true],
    ['a list holds something that is not an id', { ...answer, hiddenPostIds: [7] }, true],
    ['the answer is empty', null, true],
  ])('answers null when %s', async (_label, body, ok) => {
    answerWith(body, ok);

    await expect(fetchShowcaseViewerExclusions({ items: [post('post-1')], accessToken: 'viewer-token' })).resolves.toBeNull();
  });

  it('answers null when the request cannot be made', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));

    await expect(fetchShowcaseViewerExclusions({ items: [post('post-1')], accessToken: 'viewer-token' })).resolves.toBeNull();
  });
});
