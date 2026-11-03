import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemixSourceBundle } from '@/lib/remix-source';
import { REMIX_LINK_READ_TIMEOUT_MS, useRemixLinkRenewal } from '@/lib/use-remix-link-renewal';
import { PAGE_OPENED_AT, advancePastTheHour, expectOpensObject, movePageClock, signedStorageLink } from './fixtures/signed-storage-links';

// The browser's auth client: whose session it holds, and its token.
const browser = vi.hoisted(() => ({ session: { access_token: 'browser-token', user: { id: 'user-1' } } as { access_token: string; user: { id: string } } | null }));

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: browser.session } })) } },
}));

const RESULT = 'generated_videos/user-1/result.mp4';
const CLIP = 'generation_inputs/user-1/gen-1/01-motion_reference_video.mp4';
const PICTURE = 'generation_inputs/user-1/gen-1/00-character_image.png';
/** The original's post's copy, in the public showcase bucket. */
const POSTED = 'showcase_media/showcase/gen-1/result.mp4';
const STORAGE_PUBLIC = 'https://project.supabase.co/storage/v1/object/public';

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

let answer: (init?: RequestInit) => Response | Promise<Response>;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  void input;
  return answer(init);
});

function remixReads() {
  return fetchMock.mock.calls.map(([input, init]) => ({
    url: String(input),
    authorization: new Headers(init?.headers).get('Authorization'),
  }));
}

function renew({ formAccount = 'user-1', originalResult = null as string | null } = {}) {
  return renderHook(() => useRemixLinkRenewal({ remixId: 'gen-1', remixPostId: 'post-1', formAccount, pageToken: 'page-token', originalResult })).result.current;
}

beforeEach(() => {
  movePageClock();
  browser.session = { access_token: 'browser-token', user: { id: 'user-1' } };
  answer = () => new Response(JSON.stringify(answerNow()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRemixLinkRenewal', () => {
  it('renews a lapsed link by reading the remix again with the browser’s session, for the same file', async () => {
    const lapsed = signedStorageLink(CLIP);
    advancePastTheHour();

    const renewed = await renew()(lapsed);

    expectOpensObject(renewed, CLIP);
    expect(remixReads()).toEqual([{ url: '/api/remix-source?id=gen-1&postId=post-1', authorization: 'Bearer browser-token' }]);
  });

  it('reads with the page’s session where the browser’s is another account’s', async () => {
    browser.session = { access_token: 'other-token', user: { id: 'user-2' } };
    const lapsed = signedStorageLink(CLIP);
    advancePastTheHour();

    await renew()(lapsed);

    expect(remixReads().map(({ authorization }) => authorization)).toEqual(['Bearer page-token']);
  });

  it('serves the links asked for while a read is out from that one read', async () => {
    const opened = answerNow();
    advancePastTheHour();
    const renewLink = renew({ originalResult: opened.result!.url! });

    const [clip, picture, result] = await Promise.all([
      renewLink(opened.inputs.motion!.referenceVideo!.url!),
      renewLink(opened.inputs.motion!.characterImage!.url!),
      renewLink(opened.result!.url!),
    ]);

    expectOpensObject(clip, CLIP);
    expectOpensObject(picture, PICTURE);
    expectOpensObject(result, RESULT);
    expect(remixReads()).toHaveLength(1);
  });

  // Each ask made while a read is out is answered by that read, a read that fails or is given up
  // too: each such ask went on to read again for itself, a herd against the remix source's limit of
  // 60 reads in ten minutes.
  it('answers every ask made while a read is out from it, a read that fails included', async () => {
    const opened = answerNow();
    advancePastTheHour();
    answer = () => new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    const renewLink = renew();
    const asked = [
      opened.inputs.motion!.referenceVideo!.url!,
      opened.inputs.motion!.characterImage!.url!,
      opened.result!.url!,
    ];

    await expect(Promise.all(asked.map((link) => renewLink(link)))).resolves.toEqual(asked);
    expect(remixReads()).toHaveLength(1);
  });

  // No answer is kept once its read is over: a link asked for afterwards is read for again, so an
  // answer is never taken for the remix after the remix has changed (its original posted since).
  it('reads again for a link asked for once the last read is over', async () => {
    const opened = answerNow();
    advancePastTheHour();
    const renewLink = renew();

    expectOpensObject(await renewLink(opened.inputs.motion!.referenceVideo!.url!), CLIP);
    expectOpensObject(await renewLink(opened.inputs.motion!.characterImage!.url!), PICTURE);
    expect(remixReads()).toHaveLength(2);
  });

  // A link to the original is renewed as the original is now: once posted, its post's copy, a file
  // of its own. Only the original's own preview asked for that, so a reference made from the
  // original, previewed past the hour after the original was posted, drew a link storage refuses.
  it('renews a link to the original as the original is now: its post’s copy, once it is posted', async () => {
    const opened = answerNow();
    advancePastTheHour();
    answer = () => new Response(JSON.stringify({ ...answerNow(), result: { mediaType: 'video', url: `${STORAGE_PUBLIC}/${POSTED}` } }), { status: 200 });

    const renewed = await renew({ originalResult: opened.result!.url! })(opened.result!.url!);

    expectOpensObject(renewed, POSTED);
  });

  it('leaves the link as it was where the read fails, and reads again at the next use', async () => {
    const lapsed = signedStorageLink(CLIP);
    advancePastTheHour();
    answer = () => new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429 });
    const renewLink = renew();

    await expect(renewLink(lapsed)).resolves.toBe(lapsed);

    answer = () => new Response(JSON.stringify(answerNow()), { status: 200 });
    expectOpensObject(await renewLink(lapsed), CLIP);
    expect(remixReads()).toHaveLength(2);
  });

  // A read that stalls held every later press and preview that asked meanwhile: it is given up at
  // its timeout, the link stays as it was, and the next use reads again.
  it('gives up a read that stalls, leaving the link as it was, and reads again at the next use', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(PAGE_OPENED_AT);
    const lapsed = signedStorageLink(CLIP);
    advancePastTheHour();
    // The remix source answers nothing until the read is given up.
    answer = (init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The read was given up.', 'AbortError')));
    });
    const renewLink = renew();

    const stalled = renewLink(lapsed);
    await vi.advanceTimersByTimeAsync(REMIX_LINK_READ_TIMEOUT_MS);

    await expect(stalled).resolves.toBe(lapsed);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    answer = () => new Response(JSON.stringify(answerNow()), { status: 200 });
    expectOpensObject(await renewLink(lapsed), CLIP);
    expect(remixReads()).toHaveLength(2);
  });

});
