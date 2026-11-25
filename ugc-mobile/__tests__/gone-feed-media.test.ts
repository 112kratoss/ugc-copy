import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: { apiBaseUrl: 'https://magicbooklet.com', supabaseUrl: 'https://project.supabase.co', siteUrl: 'https://magicbooklet.com' },
}));

import {
  checkFeedMediaAvailability,
  feedMediaAvailabilityRequest,
  filterGoneFeedMedia,
  holdsGoneFeedMedia,
  rememberGoneFeedMedia,
  resetGoneFeedMediaForTests,
} from '../lib/gone-feed-media';
import type { ShowcaseFeedItem } from '../lib/types';

const API = 'https://magicbooklet.com';
const STORAGE = 'https://project.supabase.co';
const T0 = Date.parse('2026-11-25T10:00:00.000Z');
const HOUR_MS = 60 * 60_000;
const ROUTED = '/api/media?bucket=post_media&path=private-posts%2Fpost-1%2Fphoto.jpg';
const PUBLIC_COPY = `${STORAGE}/storage/v1/object/public/showcase_media/public-posts/post-1/photo.jpg`;
const context = { apiBaseUrl: API, storageBaseUrl: STORAGE, accessToken: 'viewer-token', now: T0 };

/** A Storage address signed the way the lists sign one, ending at `endsAt`. */
function signed(file: string, endsAt: number, signature = `sig-${endsAt}`) {
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ url: `generated_images/user-1/${file}`, exp: Math.floor(endsAt / 1000) })).toString('base64url'),
    signature,
  ].join('.');
  return `${STORAGE}/storage/v1/object/sign/generated_images/user-1/${file}?token=${token}`;
}

function post(id: string, urls: string[]): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: urls[0],
    mediaKind: 'image',
    mediaItems: urls.map((url, index) => ({
      id: `${id}:${index}`,
      url,
      previewUrl: null,
      gridReady: true,
      mediaKind: 'image',
      contentType: 'image/jpeg',
      originalName: null,
      width: 800,
      height: 1000,
      durationSeconds: null,
      sortOrder: index,
    })),
    title: id,
    creator: { id: `creator-${id}`, username: id, name: id, avatar: null },
  } as unknown as ShowcaseFeedItem;
}

afterEach(() => {
  resetGoneFeedMediaForTests();
});

describe('the request a failed picture is asked about with', () => {
  it('sends the media route the session, as the picture was loaded', () => {
    expect(feedMediaAvailabilityRequest(ROUTED, context)).toEqual({
      uri: `${API}${ROUTED}`,
      headers: { Authorization: 'Bearer viewer-token' },
    });
  });

  it('sends Storage nothing of the session', () => {
    expect(feedMediaAvailabilityRequest(PUBLIC_COPY, context)).toEqual({ uri: PUBLIC_COPY });
  });

  it('asks the media route for a signed address near its end, as the picture would have', () => {
    const ending = signed('photo.jpg', T0 + 30_000);
    const request = feedMediaAvailabilityRequest(ending, context);
    expect(new URL(request.uri).pathname).toBe('/api/media');
    expect(new URL(request.uri).searchParams.get('path')).toBe('user-1/photo.jpg');
    expect(request.headers).toEqual({ Authorization: 'Bearer viewer-token' });
  });

  it('asks a signed address with time left directly', () => {
    const fresh = signed('photo.jpg', T0 + HOUR_MS);
    expect(feedMediaAvailabilityRequest(fresh, context)).toEqual({ uri: fresh });
  });

  it('asks for one byte with the session, and reads a refusal as gone', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 404 }));

    await expect(checkFeedMediaAvailability(ROUTED, context, fetchImpl)).resolves.toBe('gone');

    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(input).toBe(`${API}${ROUTED}`);
    expect(init?.headers).toEqual({ Authorization: 'Bearer viewer-token', Range: 'bytes=0-0' });
  });

  // React Native's fetch follows the media route's redirect to the file itself.
  it('reads a followed redirect that answers its byte as readable', async () => {
    const fetchImpl = vi.fn(async () => new Response('i', { status: 206 }));

    await expect(checkFeedMediaAvailability(ROUTED, context, fetchImpl)).resolves.toBe('readable');
  });
});

describe('media found gone, for the rest of the launch', () => {
  it('keeps out every post that still names it, and only those', () => {
    rememberGoneFeedMedia(PUBLIC_COPY);
    const gone = post('gone', [PUBLIC_COPY]);
    const second = post('second-slide', [`${STORAGE}/storage/v1/object/public/showcase_media/other.jpg`, PUBLIC_COPY]);
    const kept = post('kept', [`${STORAGE}/storage/v1/object/public/showcase_media/kept.jpg`]);

    expect(filterGoneFeedMedia([gone, kept, second]).map((item) => item.id)).toEqual(['kept']);
    expect(holdsGoneFeedMedia(second)).toBe(true);
  });

  // Every read of a signed list signs each file again.
  it('knows a file by its path, whatever signature a later page carries', () => {
    rememberGoneFeedMedia(signed('photo.jpg', T0 + HOUR_MS, 'first'));

    expect(holdsGoneFeedMedia(post('resigned', [signed('photo.jpg', T0 + 2 * HOUR_MS, 'second')]))).toBe(true);
    expect(holdsGoneFeedMedia(post('other-file', [signed('other.jpg', T0 + HOUR_MS)]))).toBe(false);
  });

  it('hands the same list back while nothing has been found gone', () => {
    const items = [post('a', [PUBLIC_COPY])];
    expect(filterGoneFeedMedia(items)).toBe(items);
  });
});
