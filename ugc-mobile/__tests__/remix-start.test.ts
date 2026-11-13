import { describe, expect, it, vi } from 'vitest';

import { showcaseToHomeFeedCard } from '@/lib/home-feed-view-model';
import { buildImmersiveShowcaseItems } from '@/lib/immersive-preview-view-model';
import {
  REMIX_LAUNCH_PARAM,
  REMIX_UNLOCK_REQUIRED_CODE,
  findRemixLaunch,
  launchShowcaseRemix,
  readRemixSourceTakingFreeRecipe,
  showcasePostRemixSourceContext,
  showcaseRemixCreateHref,
  startShowcaseRemix,
} from '@/lib/remix-start';
import type { RemixSourceBundle, ShowcaseFeedItem } from '@/lib/types';

const REMIX_RESPONSE = { success: true, redirectTo: '/create-video?remix=gen-1&remixPost=post-1' };

function apiError(message: string, status: number, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

function createApi({
  unlock = async () => ({ success: true }),
  remix = async () => REMIX_RESPONSE,
}: {
  unlock?: () => Promise<{ success: boolean; alreadyProcessed?: boolean; alreadyPurchased?: boolean }>;
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

  // Review of #783: a Home shelf card is read for no one, so it says every free recipe is still to
  // take, its creator's and a holder's too. The server answers them `alreadyPurchased`: nothing
  // was taken, so no caches move and no "Recipe unlocked" is said.
  it('says nothing was claimed when the server answers that the viewer held it or owns the post', async () => {
    const { api, calls } = createApi({ unlock: async () => ({ success: true, alreadyPurchased: true }) });

    const result = await startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: true });

    expect(calls).toEqual(['unlock:post-1', 'remix:post-1']);
    expect(result).toMatchObject({ kind: 'started', claimedFreeUnlock: false });
  });

  it('says the unlock was claimed when this tap took it', async () => {
    const { api } = createApi({ unlock: async () => ({ success: true }) });

    await expect(startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: true }))
      .resolves.toMatchObject({ kind: 'started', claimedFreeUnlock: true });
    await expect(startShowcaseRemix({ api, postId: 'post-1', claimFreeUnlock: false }))
      .resolves.toMatchObject({ kind: 'started', claimedFreeUnlock: false });
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

  // The source answers behind the start's own gate: read before a free unlock is
  // recorded, it would be refused as still locked.
  it('says the source may be read beside the start, after any free unlock', async () => {
    const open = createApi();
    await startShowcaseRemix({ api: open.api, postId: 'post-1', claimFreeUnlock: false, onSourceReadable: () => open.calls.push('readable') });
    expect(open.calls).toEqual(['readable', 'remix:post-1']);

    const free = createApi();
    await startShowcaseRemix({ api: free.api, postId: 'post-1', claimFreeUnlock: true, onSourceReadable: () => free.calls.push('readable') });
    expect(free.calls).toEqual(['unlock:post-1', 'readable', 'remix:post-1']);

    const refused = createApi({ unlock: async () => { throw apiError('This bundle requires payment.', 400); } });
    await expect(startShowcaseRemix({ api: refused.api, postId: 'post-1', claimFreeUnlock: true, onSourceReadable: () => refused.calls.push('readable') })).rejects.toThrow();
    expect(refused.calls).toEqual(['unlock:post-1']);
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

// Owner, 2026-11-13: Home's shelf carries posts whose remix comes with a free recipe. A guest who
// signs up from such a card lands in the creator on the remix (`homeShelfGuestReturnTo`), with no
// Remix tap to take the recipe: the creator's own read takes it, as the web's creators do
// (`src/lib/use-remix-source-read.ts`).
describe('readRemixSourceTakingFreeRecipe', () => {
  const BUNDLE = { generation: { id: 'gen-1' } } as unknown as RemixSourceBundle;
  const UNLOCK_REQUIRED = () => apiError('Unlock this post to remix it.', 403, REMIX_UNLOCK_REQUIRED_CODE);
  const WANTED = { isWanted: () => true, onFreeRecipeTaken: () => undefined };

  function sourceApi({ reads, claim = async () => ({ success: true }) }: {
    reads: Array<() => Promise<RemixSourceBundle>>;
    claim?: () => Promise<{ success: boolean; alreadyPurchased?: boolean }>;
  }) {
    const calls: string[] = [];
    const queue = [...reads];
    return {
      calls,
      api: {
        getRemixSourceBundle: vi.fn(async (generationId: string, options: { postId?: string | null } = {}) => {
          calls.push(`read:${generationId}:${options.postId ?? ''}`);
          const next = queue.shift();
          if (!next) throw new Error('no more reads');
          return next();
        }),
        unlockFreeBundle: vi.fn(async (postId: string) => {
          calls.push(`claim:${postId}`);
          return claim();
        }),
      },
    };
  }

  it('reads an open remix once and takes nothing', async () => {
    const { api, calls } = sourceApi({ reads: [async () => BUNDLE] });
    const taken = vi.fn();

    await expect(readRemixSourceTakingFreeRecipe(api, 'gen-1', 'post-1', { isWanted: () => true, onFreeRecipeTaken: taken })).resolves.toBe(BUNDLE);
    expect(calls).toEqual(['read:gen-1:post-1']);
    expect(taken).not.toHaveBeenCalled();
  });

  it('takes the free recipe when the read is refused for it, reads once more, and says it took it', async () => {
    const { api, calls } = sourceApi({ reads: [async () => { throw UNLOCK_REQUIRED(); }, async () => BUNDLE] });
    const taken = vi.fn();

    await expect(readRemixSourceTakingFreeRecipe(api, 'gen-1', 'post-1', { isWanted: () => true, onFreeRecipeTaken: taken })).resolves.toBe(BUNDLE);
    expect(calls).toEqual(['read:gen-1:post-1', 'claim:post-1', 'read:gen-1:post-1']);
    expect(taken).toHaveBeenCalledTimes(1);
  });

  // A paid recipe, a blocked pair, a recipe since retired: the server refuses the claim, and the
  // remix stays refused as it was (the creator offers Retry restore beside it).
  it('leaves the remix refused when the server will not give the recipe', async () => {
    const refusal = UNLOCK_REQUIRED();
    const { api, calls } = sourceApi({
      reads: [async () => { throw refusal; }],
      claim: async () => { throw apiError('This bundle requires payment.', 400); },
    });
    const taken = vi.fn();

    await expect(readRemixSourceTakingFreeRecipe(api, 'gen-1', 'post-1', { isWanted: () => true, onFreeRecipeTaken: taken })).rejects.toBe(refusal);
    expect(calls).toEqual(['read:gen-1:post-1', 'claim:post-1']);
    expect(taken).not.toHaveBeenCalled();
  });

  // The claim only failed to be made: what it says is the reason, and Retry restore asks again.
  it.each([
    ['a 429', apiError('Too many recipes. Try again shortly.', 429)],
    ['a 5xx', apiError('Failed to get the free recipe.', 500)],
    ['the network', apiError('Could not reach Magicbooklet.', 0)],
  ])('says the claim’s own failure after %s', async (_case, failure) => {
    const { api } = sourceApi({
      reads: [async () => { throw UNLOCK_REQUIRED(); }],
      claim: async () => { throw failure; },
    });

    await expect(readRemixSourceTakingFreeRecipe(api, 'gen-1', 'post-1', WANTED)).rejects.toBe(failure);
  });

  it('takes the recipe once: a refusal after the claim is final', async () => {
    const second = UNLOCK_REQUIRED();
    const { api, calls } = sourceApi({
      reads: [async () => { throw UNLOCK_REQUIRED(); }, async () => { throw second; }],
    });

    await expect(readRemixSourceTakingFreeRecipe(api, 'gen-1', 'post-1', WANTED)).rejects.toBe(second);
    expect(calls).toEqual(['read:gen-1:post-1', 'claim:post-1', 'read:gen-1:post-1']);
  });

  // Review of #783: a creator that has closed, or whose restore started over while the read was
  // out, takes nothing; the restore that follows reads for itself.
  it('takes nothing for a creator that no longer wants the remix', async () => {
    const refusal = UNLOCK_REQUIRED();
    const { api, calls } = sourceApi({ reads: [async () => { throw refusal; }] });
    const taken = vi.fn();

    await expect(readRemixSourceTakingFreeRecipe(api, 'gen-1', 'post-1', { isWanted: () => false, onFreeRecipeTaken: taken }))
      .rejects.toBe(refusal);
    expect(calls).toEqual(['read:gen-1:post-1']);
    expect(taken).not.toHaveBeenCalled();
  });

  it('reads again but says nothing was taken when the server says the reader held the recipe', async () => {
    const { api, calls } = sourceApi({
      reads: [async () => { throw UNLOCK_REQUIRED(); }, async () => BUNDLE],
      claim: async () => ({ success: true, alreadyPurchased: true }),
    });
    const taken = vi.fn();

    await expect(readRemixSourceTakingFreeRecipe(api, 'gen-1', 'post-1', { isWanted: () => true, onFreeRecipeTaken: taken }))
      .resolves.toBe(BUNDLE);
    expect(calls).toEqual(['read:gen-1:post-1', 'claim:post-1', 'read:gen-1:post-1']);
    expect(taken).not.toHaveBeenCalled();
  });

  it('takes nothing for any other refusal, or for a remix that names no post', async () => {
    const forbidden = apiError('Forbidden', 403, 'REGISTRATION_REQUIRED');
    const guest = sourceApi({ reads: [async () => { throw forbidden; }] });
    await expect(readRemixSourceTakingFreeRecipe(guest.api, 'gen-1', 'post-1', WANTED)).rejects.toBe(forbidden);
    expect(guest.calls).toEqual(['read:gen-1:post-1']);

    const refusal = UNLOCK_REQUIRED();
    const noPost = sourceApi({ reads: [async () => { throw refusal; }] });
    await expect(readRemixSourceTakingFreeRecipe(noPost.api, 'gen-1', null, WANTED)).rejects.toBe(refusal);
    expect(noPost.calls).toEqual(['read:gen-1:']);
  });
});

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

  // The row read "Untitled Creation" where the post's Home card shows its prompt.
  it('names an untitled post by its prompt, as its Home card does', () => {
    const [untitled] = buildImmersiveShowcaseItems('showcase-feed', [{ ...motionPost(), title: 'Untitled Creation' }]);
    expect(route(showcaseRemixCreateHref(untitled, { success: true, redirectTo: '/create-motion?remix=gen-1&remixPost=post-1' })).params)
      .toMatchObject({ sourceTitle: 'A dancer on a rooftop' });
  });
});

// What the creator draws when its link names the post by id alone: a guest's
// Make this after sign-in, a notification, a deep link.
describe('showcasePostRemixSourceContext', () => {
  it('names a post read by id as the reel and Home name it', () => {
    expect(showcasePostRemixSourceContext(motionPost())).toEqual({
      postId: 'post-1',
      title: 'Dance loop',
      creatorLabel: '@mover',
      thumbnailUrl: 'https://cdn.example.test/post-1/poster.webp',
    });
  });

  it("gives an untitled post its Home card's title", () => {
    const untitled = { ...motionPost(), title: 'Untitled Creation' };
    expect(showcasePostRemixSourceContext(untitled).title).toBe('A dancer on a rooftop');
    expect(showcasePostRemixSourceContext(untitled).title).toBe(showcaseToHomeFeedCard(untitled).title);
  });

  // The row and the Home card name a post through one ladder (`postName`); these are the
  // shapes an untitled post arrives in (the server titles any post with a body from its body).
  it.each([
    ['an image with a prompt', { creationMode: null, category: 'image', mediaKind: 'image', prompt: 'A red bicycle' }, 'A red bicycle'],
    ['an image whose prompt is hidden', { creationMode: null, category: 'image', mediaKind: 'image', prompt: '' }, 'Image creation'],
    ['a video whose prompt is hidden', { creationMode: null, category: 'video', mediaKind: 'video', prompt: '' }, 'Video creation'],
    ['a video upload filed as an image', { creationMode: null, category: 'image', mediaKind: 'video', prompt: '' }, 'Video creation'],
    ['a motion run whose prompt is hidden', { creationMode: 'motion', category: 'video', mediaKind: 'video', prompt: '' }, 'Motion creation'],
  ] as const)('names %s as its Home card does', (_shape, fields, expected) => {
    const post = { ...motionPost(), ...fields, title: 'Untitled Creation' } as ShowcaseFeedItem;
    expect(showcasePostRemixSourceContext(post).title).toBe(expected);
    expect(showcaseToHomeFeedCard(post).title).toBe(expected);
  });
});

// Home's Make this and the reel's Remix open the creator at the tap, before the
// start is answered; the creator finds the tap's launch by its link and waits on it.
describe('launchShowcaseRemix', () => {
  const SOURCE = { generation: { id: 'gen-1' } } as unknown as RemixSourceBundle;
  const [item] = buildImmersiveShowcaseItems('showcase-feed', [motionPost()]);
  /** Where the server's answer for this post opens the creator. */
  const answerHref = showcaseRemixCreateHref(item, { success: true, redirectTo: '/create-motion?remix=gen-1&remixPost=post-1' })!;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const launchOf = (href: string) => new URL(href, 'https://magicbooklet.test').searchParams.get(REMIX_LAUNCH_PARAM);
  /** The remix every tap here launches. */
  const POST_1 = { generationId: 'gen-1', postId: 'post-1' };
  const tap = (tapped = item) => {
    const navigate = vi.fn();
    const api = { getRemixSourceBundle: vi.fn(async (_generationId: string, _options?: { postId?: string | null }) => SOURCE) };
    const control = launchShowcaseRemix({ api, item: tapped, navigate });
    const pushed = navigate.mock.calls[0]?.[0] as string | undefined;
    return { api, control, navigate, pushed, launch: findRemixLaunch(pushed ? launchOf(pushed) : null, POST_1) };
  };

  it("opens the creator at once, on the answer's expected link, which names the launch", () => {
    const { control, navigate, pushed, launch } = tap();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(pushed).toBe(`${answerHref}&${REMIX_LAUNCH_PARAM}=${launchOf(pushed!)}`);
    // Named by the post, for the creator to show while its source loads.
    expect(launch).toMatchObject({ answer: null, modelId: 'kling-3.0-motion' });
    // Each tap's launch is its own.
    const second = tap();
    expect(launchOf(second.pushed!)).not.toBe(launchOf(pushed!));
    expect(second.launch).not.toBe(launch);
    control.land(answerHref);
    second.control.land(answerHref);
  });

  it('carries the creator on when the answer names its link', () => {
    const { control, navigate, launch } = tap();
    const listener = vi.fn();
    launch!.subscribe(listener);

    control.land(answerHref);

    expect(launch!.answer).toEqual({ kind: 'confirmed' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('sends the creator to the link the answer names when it is another', () => {
    const { control, launch } = tap();

    control.land('/create/video?remix=gen-1&remixPost=post-1');

    expect(launch!.answer).toEqual({ kind: 'replaced', href: '/create/video?remix=gen-1&remixPost=post-1' });
  });

  // Any app can open the creator's link: one that names this tap's launch beside another
  // remix opens as any remix link does, and never restores this one's source into it.
  it('is found only by a link that names the remix it launched', () => {
    const { control, pushed, launch } = tap();
    const id = launchOf(pushed!);

    expect(findRemixLaunch(id, POST_1)).toBe(launch);
    expect(findRemixLaunch(id, { generationId: 'gen-2', postId: 'post-1' })).toBeNull();
    expect(findRemixLaunch(id, { generationId: 'gen-1', postId: 'post-2' })).toBeNull();
    expect(findRemixLaunch(id, undefined)).toBeNull();
    expect(findRemixLaunch(null, POST_1)).toBeNull();
    control.land(answerHref);
  });

  // An answer can beat the creator's first render (an offline start fails at once), so
  // the creator still finds it as it opens, and follows it then.
  it('keeps an answer for a creator still opening, and lets it go once that creator has been and gone', () => {
    const { control, pushed, launch } = tap();
    control.land('/create/video?remix=gen-1&remixPost=post-1');
    expect(findRemixLaunch(launchOf(pushed!), POST_1)).toBe(launch);

    const leave = launch!.subscribe(() => undefined);
    leave();
    expect(findRemixLaunch(launchOf(pushed!), POST_1)).toBeNull();
  });

  it('closes the creator, and settles once it has gone', async () => {
    const { control, launch } = tap();
    const leave = launch!.subscribe(() => undefined);

    let gone = false;
    void control.close().then(() => { gone = true; });
    await flush();
    expect(launch!.answer).toEqual({ kind: 'closed' });
    expect(gone).toBe(false);

    leave();
    await flush();
    expect(gone).toBe(true);
    // A second answer changes nothing.
    control.land(answerHref);
    expect(launch!.answer).toEqual({ kind: 'closed' });
  });

  it('settles a close at once when no creator is open to close', async () => {
    const { control } = tap();
    let gone = false;
    void control.close().then(() => { gone = true; });
    await flush();
    expect(gone).toBe(true);
  });

  it('reads the source once it is readable, and lands it only once the start is answered as this remix', async () => {
    const { api, control, launch } = tap();
    let landed: unknown = null;
    void launch!.readSource().then((bundle) => { landed = bundle; });
    await flush();
    expect(api.getRemixSourceBundle).not.toHaveBeenCalled();

    control.sourceReadable();
    await flush();
    expect(api.getRemixSourceBundle).toHaveBeenCalledTimes(1);
    expect(api.getRemixSourceBundle).toHaveBeenCalledWith('gen-1', { postId: 'post-1' });
    expect(landed).toBeNull();

    control.land(answerHref);
    await flush();
    expect(landed).toBe(SOURCE);

    // A later restore (a retry, a restart) reads again.
    await expect(launch!.readSource()).resolves.toBe(SOURCE);
    expect(api.getRemixSourceBundle).toHaveBeenCalledTimes(2);
  });

  it('holds a failed read until the answer, and lands nothing on a creator the answer takes back', async () => {
    const { api, control, launch } = tap();
    const refusal = apiError('Unlock this post to remix it.', 403, REMIX_UNLOCK_REQUIRED_CODE);
    api.getRemixSourceBundle.mockRejectedValueOnce(refusal);
    const outcome = vi.fn();
    void launch!.readSource().then(() => outcome('landed'), () => outcome('failed'));
    control.sourceReadable();
    await flush();
    expect(outcome).not.toHaveBeenCalled();

    void control.close();
    await flush();
    expect(outcome).not.toHaveBeenCalled();
  });

  it('opens on the answer, as before, for a post that cannot name its creation', () => {
    const { control, navigate, launch } = tap({ ...item, generationId: null });

    expect(navigate).not.toHaveBeenCalled();
    expect(launch).toBeNull();
    control.land('/create/motion?prompt=A+dancer');
    expect(navigate).toHaveBeenCalledWith('/create/motion?prompt=A+dancer');
  });
});
