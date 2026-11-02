import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemixSourceBundle } from '@/lib/remix-source';
import { useRemixLinkRenewal } from '@/lib/use-remix-link-renewal';
import { PAST_THE_HOUR_MS, advancePageClock, movePageClock, signedStorageLink, storageOpens, storedObjectOf } from './fixtures/signed-storage-links';

// The browser's auth client: whose session it holds, and its token.
const browser = vi.hoisted(() => ({ session: { access_token: 'browser-token', user: { id: 'user-1' } } as { access_token: string; user: { id: string } } | null }));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: browser.session } })) } },
}));

const OPENED_AT = Date.UTC(2026, 10, 2, 9, 0, 0);
const RESULT = 'generated_videos/user-1/result.mp4';
const CLIP = 'generation_inputs/user-1/gen-1/01-motion_reference_video.mp4';
const PICTURE = 'generation_inputs/user-1/gen-1/00-character_image.png';

/** The remix source's answer, signed as it answers. */
function answerNow(): RemixSourceBundle {
  return {
    generation: { id: 'gen-1', title: 'Rooftop', prompt: 'Dance', category: 'video', model: 'kling-2.6' },
    result: { mediaType: 'video', url: signedStorageLink(RESULT) },
    inputs: {
      motion: {
        characterImage: { kind: 'image', label: 'Character image', storagePath: PICTURE, sourceGenerationId: null, url: signedStorageLink(PICTURE) },
        referenceVideo: { kind: 'video', label: 'Clip', storagePath: CLIP, sourceGenerationId: null, url: signedStorageLink(CLIP) },
      },
    },
    workflowSettings: {},
    restoreIssues: [],
  };
}

let answer: () => Response | Promise<Response>;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  void input;
  void init;
  return answer();
});

function remixReads() {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: String(input),
    authorization: new Headers(init?.headers).get('Authorization'),
  }));
}

function renew({ formAccount = 'user-1', remixId = 'gen-1' as string | null } = {}) {
  return renderHook(() => useRemixLinkRenewal({ remixId, remixPostId: 'post-1', formAccount, pageToken: 'page-token' })).result.current;
}

beforeEach(() => {
  movePageClock(OPENED_AT);
  browser.session = { access_token: 'browser-token', user: { id: 'user-1' } };
  answer = () => new Response(JSON.stringify(answerNow()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRemixLinkRenewal', () => {
  it('gives a link that lasts back as it is, reading nothing', async () => {
    const link = signedStorageLink(CLIP);
    await expect(renew()(link)).resolves.toBe(link);
    // Nor a link that does not lapse, on any page.
    await expect(renew()('blob:clip')).resolves.toBe('blob:clip');
    expect(remixReads()).toEqual([]);
  });

  it('renews a lapsed link by reading the remix again with the browser’s session, for the same file', async () => {
    const lapsed = signedStorageLink(CLIP);
    advancePageClock(PAST_THE_HOUR_MS);

    const renewed = await renew()(lapsed);

    expect(storedObjectOf(renewed)).toBe(CLIP);
    expect(storageOpens(renewed)).toBe(true);
    expect(remixReads()).toEqual([{ url: '/api/remix-source?id=gen-1&postId=post-1', authorization: 'Bearer browser-token' }]);
  });

  it('reads with the page’s session where the browser’s is another account’s', async () => {
    browser.session = { access_token: 'other-token', user: { id: 'user-2' } };
    const lapsed = signedStorageLink(CLIP);
    advancePageClock(PAST_THE_HOUR_MS);

    await renew()(lapsed);

    expect(remixReads().map(({ authorization }) => authorization)).toEqual(['Bearer page-token']);
  });

  it('serves every lapsed link from one read, those asked together included', async () => {
    const opened = answerNow();
    advancePageClock(PAST_THE_HOUR_MS);
    const renewLink = renew();

    const [clip, picture] = await Promise.all([
      renewLink(opened.inputs.motion!.referenceVideo!.url!),
      renewLink(opened.inputs.motion!.characterImage!.url!),
    ]);
    const result = await renewLink(opened.result!.url!, { result: true });

    expect([clip, picture, result].map(storedObjectOf)).toEqual([CLIP, PICTURE, RESULT]);
    expect([clip, picture, result].every((link) => storageOpens(link))).toBe(true);
    expect(remixReads()).toHaveLength(1);
  });

  it('reads again once the answer it holds has lapsed too', async () => {
    const opened = answerNow();
    const renewLink = renew();
    advancePageClock(PAST_THE_HOUR_MS);
    await renewLink(opened.result!.url!);
    advancePageClock(PAST_THE_HOUR_MS);

    const renewed = await renewLink(opened.result!.url!);

    expect(storageOpens(renewed)).toBe(true);
    expect(remixReads()).toHaveLength(2);
  });

  it('leaves the link as it was where the read fails, and reads again at the next use', async () => {
    const lapsed = signedStorageLink(CLIP);
    advancePageClock(PAST_THE_HOUR_MS);
    answer = () => new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    const renewLink = renew();

    await expect(renewLink(lapsed)).resolves.toBe(lapsed);

    answer = () => new Response(JSON.stringify(answerNow()), { status: 200 });
    expect(storageOpens(await renewLink(lapsed))).toBe(true);
    expect(remixReads()).toHaveLength(2);
  });

  it('reads no more for a file the answer it holds does not hand out', async () => {
    const elsewhere = signedStorageLink('uploads/user-1/hero.png');
    const lapsedClip = signedStorageLink(CLIP);
    advancePageClock(PAST_THE_HOUR_MS);
    const renewLink = renew();
    await renewLink(lapsedClip);

    await expect(renewLink(elsewhere)).resolves.toBe(elsewhere);
    expect(remixReads()).toHaveLength(1);
  });

  it('renews nothing off a remix page', async () => {
    const lapsed = signedStorageLink(CLIP);
    advancePageClock(PAST_THE_HOUR_MS);

    await expect(renew({ remixId: null })(lapsed)).resolves.toBe(lapsed);
    expect(remixReads()).toEqual([]);
  });
});
