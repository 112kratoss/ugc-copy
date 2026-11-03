(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('@/lib/env', () => ({
  env: { apiBaseUrl: 'https://magicbooklet.com', supabaseUrl: 'https://project.supabase.co', siteUrl: 'https://magicbooklet.com' },
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ session: null }) }));
// Counted: the file an address names is worked out once per address.
vi.mock('@/lib/use-stable-signed-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/use-stable-signed-url')>();
  return { ...actual, signedMediaIdentity: vi.fn(actual.signedMediaIdentity) };
});
vi.mock('@/components/recoverable-video-preview', () => ({
  RecoverableVideoPreview: (props: MockProps) => React.createElement('video-preview', props),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('expo-video', () => ({
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));
vi.mock('lucide-react-native', () => ({
  ImageOff: (props: MockProps) => React.createElement('image-off', props),
  Play: (props: MockProps) => React.createElement('play', props),
}));

import { FeedMediaFrame } from '../components/feed-media-frame';
import { StableMediaImage } from '../components/media-preview';
import { decodedImageAspectRatio } from '../lib/decoded-image-aspect-ratio';
import { signedMediaIdentity } from '../lib/use-stable-signed-url';

const STORAGE = 'https://project.supabase.co';
const T0 = Date.parse('2026-11-03T10:00:00.000Z');
const MINUTE_MS = 60_000;

/** A Storage address signed the way the owner list signs one, ending at `endsAt`. */
function signed(file: string, endsAt: number, signature = `sig-${endsAt}`) {
  const token = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ url: `generated_images/user-1/${file}`, exp: Math.floor(endsAt / 1000) })).toString('base64url'),
    signature,
  ].join('.');
  return `${STORAGE}/storage/v1/object/sign/generated_images/user-1/${file}?token=${token}`;
}

/** The native image the session draws: one with a source, not the failure plate's thumbhash. */
function picture(tree: renderer.ReactTestRenderer) {
  const drawn = tree.root.findAll((node) => node.type === 'image' && Boolean(node.props.source));
  return drawn.length === 1 ? drawn[0] : null;
}

function mount(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => { tree = renderer.create(element); });
  return tree;
}

/**
 * Fails the image drawn from `address` until its retries are spent and it
 * gives up on it. Each retry waits a few seconds; the clock moves by those
 * alone, far from any address's end.
 */
function failWhileDrawing(tree: renderer.ReactTestRenderer, address: string) {
  for (let guard = 0; guard < 25; guard += 1) {
    const image = picture(tree);
    if (!image || image.props.source.uri !== address) return;
    renderer.act(() => (image.props.onError as () => void)());
    renderer.act(() => { vi.advanceTimersByTime(5_000); });
  }
  throw new Error('the image never gave up on the address');
}

describe('StableMediaImage given a new signature of the file it draws', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const HELD = signed('a.webp', T0 + 60 * MINUTE_MS, 'first-read');
  const LATER = signed('a.webp', T0 + 61 * MINUTE_MS, 'second-read');

  // The card a Creations tile opened went blank, showed its thumbhash and drew
  // again about 1.3 s after it landed, with nothing touched (Pixel 9a emulator,
  // 2026-11-03): its list had been read again, which signs every file anew.
  it('keeps drawing the address it has, in the same native image, when its list signs the file again', () => {
    const tree = mount(<StableMediaImage url={HELD} cacheKey="user-1/previews/a.webp" thumbhash="thumbhash" />);
    const before = picture(tree)!;
    renderer.act(() => (before.props.onDisplay as () => void)());

    renderer.act(() => { tree.update(<StableMediaImage url={LATER} cacheKey="user-1/previews/a.webp" thumbhash="thumbhash" />); });

    const after = picture(tree)!;
    expect(after).toBe(before);
    expect(after.props.source).toEqual({ uri: HELD, cacheKey: 'user-1/previews/a.webp' });
    expect(after.props.placeholder).toEqual({ thumbhash: 'thumbhash' });
    expect(after.props.recyclingKey).toBe('user-1/previews/a.webp');
  });

  it('takes the newer signature as the address it draws comes within a minute of its end', () => {
    const tree = mount(<StableMediaImage url={HELD} cacheKey="k" />);
    const before = picture(tree)!;
    renderer.act(() => { tree.update(<StableMediaImage url={LATER} cacheKey="k" />); });

    renderer.act(() => { vi.advanceTimersByTime(59 * MINUTE_MS - 1); });
    expect(picture(tree)!.props.source.uri).toBe(HELD);

    renderer.act(() => { vi.advanceTimersByTime(1); });
    expect(picture(tree)!.props.source.uri).toBe(LATER);
    expect(picture(tree)).toBe(before);
  });

  it('takes the newer signature at once when the address it draws has failed, whichever came first', () => {
    const failedFirst = mount(<StableMediaImage url={HELD} cacheKey="k" />);
    failWhileDrawing(failedFirst, HELD);
    expect(picture(failedFirst)).toBeNull();
    renderer.act(() => { failedFirst.update(<StableMediaImage url={LATER} cacheKey="k" />); });
    expect(picture(failedFirst)!.props.source.uri).toBe(LATER);

    const onError = vi.fn();
    const signedFirst = mount(<StableMediaImage url={HELD} cacheKey="k" onError={onError} />);
    renderer.act(() => { signedFirst.update(<StableMediaImage url={LATER} cacheKey="k" onError={onError} />); });
    failWhileDrawing(signedFirst, HELD);
    // No plate between the two: the newer signature is drawn as the old one gives up.
    expect(picture(signedFirst)!.props.source.uri).toBe(LATER);
    expect(JSON.stringify(signedFirst.toJSON())).not.toContain('Preview unavailable');
    // The parent still hears that the address it gave first failed, as it always has.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('never trades the address it draws for an older signature', () => {
    const older = signed('a.webp', T0 + 50 * MINUTE_MS, 'older-read');
    const tree = mount(<StableMediaImage url={HELD} cacheKey="k" />);
    renderer.act(() => { tree.update(<StableMediaImage url={older} cacheKey="k" />); });
    failWhileDrawing(tree, HELD);

    expect(picture(tree)).toBeNull();
    expect(JSON.stringify(tree.toJSON())).toContain('Preview unavailable');
  });

  it('keeps a renewal over an older address its parent hands it afterwards', async () => {
    const renewed = signed('a.webp', T0 + 120 * MINUTE_MS, 'renewed');
    const resolveRetryUrl = vi.fn(async () => renewed);
    const tree = mount(<StableMediaImage url={HELD} cacheKey="k" resolveRetryUrl={resolveRetryUrl} />);
    failWhileDrawing(tree, HELD);
    await renderer.act(async () => {
      (tree.root.find((node) => String(node.type) === 'pressable').props.onPress as () => void)();
    });
    expect(picture(tree)!.props.source.uri).toBe(renewed);

    renderer.act(() => { tree.update(<StableMediaImage url={LATER} cacheKey="k" resolveRetryUrl={resolveRetryUrl} />); });
    renderer.act(() => { vi.advanceTimersByTime(60 * MINUTE_MS); });
    expect(picture(tree)!.props.source.uri).toBe(renewed);
  });

  it('files the shape it decoded under the newer address, where the zoom looks it up', () => {
    const tree = mount(<StableMediaImage url={HELD} cacheKey="k" />);
    renderer.act(() => (picture(tree)!.props.onLoad as (event: unknown) => void)({ source: { width: 1600, height: 900 } }));
    expect(decodedImageAspectRatio(HELD)).toBeCloseTo(16 / 9);
    expect(decodedImageAspectRatio(LATER)).toBeNull();

    renderer.act(() => { tree.update(<StableMediaImage url={LATER} cacheKey="k" />); });

    expect(decodedImageAspectRatio(LATER)).toBeCloseTo(16 / 9);
  });

  it('works out the file an address names once, not on every render', () => {
    const identify = vi.mocked(signedMediaIdentity);
    identify.mockClear();
    const tree = mount(<StableMediaImage url={HELD} cacheKey="k" style={{ opacity: 1 }} />);
    for (let render = 0; render < 10; render += 1) {
      renderer.act(() => { tree.update(<StableMediaImage url={HELD} cacheKey="k" style={{ opacity: render % 2 }} />); });
    }

    expect(identify).toHaveBeenCalledTimes(1);
  });
});

describe('StableMediaImage given another file', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads a new file at once, under the same cache key or a new one', () => {
    const tree = mount(<StableMediaImage url={signed('a.webp', T0 + 60 * MINUTE_MS)} cacheKey="k" />);
    const first = picture(tree)!;

    const otherFile = signed('b.webp', T0 + 60 * MINUTE_MS);
    renderer.act(() => { tree.update(<StableMediaImage url={otherFile} cacheKey="k" />); });
    const second = picture(tree)!;
    expect(second).not.toBe(first);
    expect(second.props.source.uri).toBe(otherFile);

    renderer.act(() => { tree.update(<StableMediaImage url={otherFile} cacheKey="k:source" />); });
    const third = picture(tree)!;
    expect(third).not.toBe(second);
    expect(third.props.source).toEqual({ uri: otherFile, cacheKey: 'k:source' });
  });

  it('follows an address it cannot date, as it always has', () => {
    const tree = mount(<StableMediaImage url="https://cdn.example.com/a.webp?v=1" cacheKey="k" />);
    const first = picture(tree)!;
    renderer.act(() => { tree.update(<StableMediaImage url="https://cdn.example.com/a.webp?v=2" cacheKey="k" />); });

    expect(picture(tree)).not.toBe(first);
    expect(picture(tree)!.props.source.uri).toBe('https://cdn.example.com/a.webp?v=2');
  });
});

describe('a feed frame whose list signs its picture again', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Every list that draws through the frame: the card feed and Home cards
  // (`ShowcaseMediaSlide`), the reel's slides, a creation's references.
  it('keeps the picture it drew', () => {
    const held = signed('preview.webp', T0 + 60 * MINUTE_MS, 'first-read');
    const tree = mount(<FeedMediaFrame kind="image" url={held} cacheKey="user-1/previews/preview.webp" thumbhash="thumbhash" />);
    const before = picture(tree)!;

    renderer.act(() => {
      tree.update(<FeedMediaFrame kind="image" url={signed('preview.webp', T0 + 61 * MINUTE_MS, 'second-read')} cacheKey="user-1/previews/preview.webp" thumbhash="thumbhash" />);
    });

    expect(picture(tree)).toBe(before);
    expect(picture(tree)!.props.source.uri).toBe(held);
  });
});
