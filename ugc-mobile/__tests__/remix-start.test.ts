import { describe, expect, it, vi } from 'vitest';

import { buildImmersiveShowcaseItems } from '@/lib/immersive-preview-view-model';
import { REMIX_UNLOCK_REQUIRED_CODE, showcaseRemixCreateHref, startShowcaseRemix } from '@/lib/remix-start';
import type { ShowcaseFeedItem } from '@/lib/types';

const REMIX_RESPONSE = { success: true, redirectTo: '/create-video?remix=gen-1&remixPost=post-1' };

function apiError(message: string, status: number, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

function createApi({
  unlock = async () => ({ success: true }),
  remix = async () => REMIX_RESPONSE,
}: {
  unlock?: () => Promise<{ success: boolean; alreadyProcessed?: boolean }>;
  remix?: () => Promise<typeof REMIX_RESPONSE>;
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      unlockFreeBundle: vi.fn(async (postId: string) => {
        calls.push(`unlock:${postId}`);
        return unlock();
      }),
      remixShowcasePost: vi.fn(async (postId: string) => {
        calls.push(`remix:${postId}`);
        return remix();
      }),
    },
  };
}

describe('startShowcaseRemix', () => {
  it('starts an open remix with the one request it needs', async () => {
    const { api, calls } = createApi();

    await expect(startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: false })).resolves.toEqual({
      kind: 'started',
      response: REMIX_RESPONSE,
      claimedFreeUnlock: false,
    });
    expect(calls).toEqual(['remix:post-1']);
  });

  it('claims a free unlock first, then starts the remix, in the same tap', async () => {
    const { api, calls } = createApi();

    await expect(startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: true })).resolves.toEqual({
      kind: 'started',
      response: REMIX_RESPONSE,
      claimedFreeUnlock: true,
    });
    // Order matters: the remix endpoint refuses until the unlock is recorded.
    expect(calls).toEqual(['unlock:post-1', 'remix:post-1']);
  });

  it('carries on when the viewer already holds the free unlock', async () => {
    // Unlocked on another device, with this page loaded before it.
    const { api, calls } = createApi({ unlock: async () => ({ success: true, alreadyProcessed: true }) });

    const result = await startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: true });

    expect(result.kind).toBe('started');
    expect(calls).toEqual(['unlock:post-1', 'remix:post-1']);
  });

  it('never starts the remix when the free unlock is refused', async () => {
    const refusal = apiError('This bundle requires payment.', 400);
    const { api, calls } = createApi({ unlock: async () => { throw refusal; } });

    await expect(startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: true })).rejects.toBe(refusal);
    expect(calls).toEqual(['unlock:post-1']);
  });

  it('reports a lock the loaded post did not know about, rather than failing', async () => {
    // The creator attached a remix-gated unlock after this page was fetched.
    const { api, calls } = createApi({
      remix: async () => { throw apiError('Unlock this post to remix it.', 403, REMIX_UNLOCK_REQUIRED_CODE); },
    });

    await expect(startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: false })).resolves.toEqual({
      kind: 'unlock-required',
    });
    // It does not reach for an unlock by itself: that one could cost credits.
    expect(calls).toEqual(['remix:post-1']);
  });

  it('gives up instead of looping when the server still wants an unlock after one was claimed', async () => {
    const stillLocked = apiError('Unlock this post to remix it.', 403, REMIX_UNLOCK_REQUIRED_CODE);
    const { api, calls } = createApi({ remix: async () => { throw stillLocked; } });

    await expect(startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: true })).rejects.toBe(stillLocked);
    expect(calls).toEqual(['unlock:post-1', 'remix:post-1']);
  });

  it('lets every other failure through untouched', async () => {
    const missing = apiError('Creation is private or not found', 404);
    const { api } = createApi({ remix: async () => { throw missing; } });

    await expect(startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: false })).rejects.toBe(missing);

    // The same status without the code is some other refusal, such as a block.
    const forbidden = apiError('Forbidden', 403);
    const second = createApi({ remix: async () => { throw forbidden; } });
    await expect(startShowcaseRemix({ api: second.api, postId: 'post-1', claimFreeUnlock: false })).rejects.toBe(forbidden);
  });
});

/** A motion post as the feed sends it: a video whose creation was a motion run. */
function motionPost(): ShowcaseFeedItem {
  return {
    id: 'post-1',
    title: 'Dance loop',
    prompt: 'A dancer on a rooftop',
    body: '',
    mediaUrl: 'https://cdn.example.test/post-1/source.mp4',
    mediaKind: 'video',
    mediaItems: [{
      id: 'post-1:media',
      url: 'https://cdn.example.test/post-1/source.mp4',
      previewUrl: 'https://cdn.example.test/post-1/poster.webp',
      mediaKind: 'video',
      contentType: 'video/mp4',
      originalName: null,
      width: 720,
      height: 1280,
      durationSeconds: 5,
      sortOrder: 0,
    }],
    category: 'video',
    creationMode: 'motion',
    postFormat: 'media',
    model: 'kling-3.0-motion',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-11-01T09:00:00.000Z',
    creator: { id: 'creator-1', username: 'mover', name: 'Mover', avatar: null },
    generationId: 'gen-1',
    asset: null,
    canRemix: true,
  } as unknown as ShowcaseFeedItem;
}

describe('showcaseRemixCreateHref', () => {
  const route = (href: string | null) => {
    const url = new URL(href!, 'https://magicbooklet.test');
    return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) };
  };
  const [item] = buildImmersiveShowcaseItems('showcase-feed', [motionPost()]);

  // Home's Remix and Make this and the reel's open the creator through this
  // one function, so every one of them names the source in the creator.
  it("opens the server's create link with the row naming the source", () => {
    expect(route(showcaseRemixCreateHref(item, { success: true, redirectTo: '/create-motion?remix=gen-1&remixPost=post-1' })))
      .toEqual({
        pathname: '/create/motion',
        params: {
          remix: 'gen-1',
          remixPost: 'post-1',
          sourceTitle: 'Dance loop',
          sourceCreator: '@mover',
          sourceThumbnail: 'https://cdn.example.test/post-1/poster.webp',
        },
      });
  });

  // Home once fell back to Video for any video post and to the raw prompt; it
  // now takes the reel's answers: the post's own tool and the server's prompt.
  it("falls back to the post's own tool and the server's prompt when the link cannot be mapped", () => {
    expect(route(showcaseRemixCreateHref(item, {
      success: true,
      redirectTo: '/somewhere-else',
      prefill: { prompt: 'A dancer on a rooftop, at dusk' },
    }))).toMatchObject({
      pathname: '/create/motion',
      params: { prompt: 'A dancer on a rooftop, at dusk', sourceTitle: 'Dance loop' },
    });
    expect(route(showcaseRemixCreateHref(item, { success: true }))).toMatchObject({
      pathname: '/create/motion',
      params: { prompt: 'A dancer on a rooftop' },
    });
  });
});
