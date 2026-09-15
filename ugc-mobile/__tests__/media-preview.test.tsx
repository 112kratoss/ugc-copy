import { buildMediaSource } from '../lib/media-source';
// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
const imageState = vi.hoisted(() => ({ prefetch: vi.fn(async () => true) }));
const appState = vi.hoisted(() => ({
  currentState: 'active' as string,
  listeners: [] as Array<(state: string) => void>,
}));

// This suite exercises image caching/retry; native video recovery has its own suite.
vi.mock('@/components/recoverable-video-preview', () => ({
  RecoverableVideoPreview: (props: MockProps) => React.createElement('video-preview', props),
}));

vi.mock('@/lib/use-media-source', () => ({
  useMediaSource: (url: string) => ({ source: buildMediaSource(url, 'https://magicbooklet.com', 'test-session'), requestKey: '' }),
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.push(listener);
      return {
        remove: () => {
          appState.listeners = appState.listeners.filter((entry) => entry !== listener);
        },
      };
    },
  },
  Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('expo-image', () => ({
  Image: Object.assign(
    (props: MockProps) => React.createElement('image', props),
    { prefetch: imageState.prefetch }
  ),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children),
}));

vi.mock('expo-video', () => ({
  useVideoPlayer: () => ({ id: 'player' }),
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

vi.mock('lucide-react-native', () => ({
  ImageOff: (props: MockProps) => React.createElement('image-off', props),
}));

import { StableMediaImage } from '../components/media-preview';
import { clearMediaDiagnosticsForTests, readMediaDiagnostics } from '../lib/media-diagnostics';
import { MEDIA_DISPLAY_DEADLINE_MS, MEDIA_RECOVERY_WAIT_MS, mediaRecoveryBudget } from '../lib/media-recovery';

// Fires onError and advances timers until the failure latches, so these tests
// hold for the never-retry placeholder policy and any bounded auto-retry
// policy in imageRetryDelayMs alike.
function exhaustImageLoad(tree: renderer.ReactTestRenderer) {
  for (let guard = 0; guard < 25; guard += 1) {
    // Only images with onError are loading real sources; the failure tile's
    // thumbhash placeholder renders as an <image> without one.
    const images = tree.root
      .findAllByType('image')
      .filter((node) => typeof node.props.onError === 'function');
    if (images.length === 0) return;
    renderer.act(() => images[0].props.onError());
    renderer.act(() => {
      vi.runAllTimers();
    });
  }
  throw new Error('image load never latched failure — is the retry policy unbounded?');
}

describe('StableMediaImage', () => {
  beforeEach(() => {
    imageState.prefetch.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes authentication to a private fallback image', () => {
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<StableMediaImage
      url="https://magicbooklet.com/api/media?path=private.webp" cacheKey="private" />); });
    expect(tree!.root.findByType('image').props.source).toEqual({
      uri: 'https://magicbooklet.com/api/media?path=private.webp',
      cacheKey: 'private', headers: { Authorization: 'Bearer test-session' },
    });
    renderer.act(() => tree.unmount());
  });

  it('uses stable storage identity and an asset-derived ThumbHash placeholder', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <StableMediaImage
          url="https://signed.example.com/preview.webp?token=one"
          cacheKey="generated_images/user-1/preview.hash.webp"
          thumbhash="thumbhash-base64"
          contentFit="cover"
        />
      );
    });

    const image = tree!.root.findByType('image');
    expect(image.props.source).toEqual({
      uri: 'https://signed.example.com/preview.webp?token=one',
      cacheKey: 'generated_images/user-1/preview.hash.webp',
    });
    expect(image.props.placeholder).toEqual({ thumbhash: 'thumbhash-base64' });
    expect(image.props.recyclingKey).toBe('generated_images/user-1/preview.hash.webp');
    expect(imageState.prefetch).not.toHaveBeenCalled();
  });

  it('resets an errored recycled cell when its stable cache key changes', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/one.webp" cacheKey="one" />);
    });
    exhaustImageLoad(tree!);
    expect(tree!.root.findAllByType('image')).toHaveLength(0);

    renderer.act(() => {
      tree!.update(<StableMediaImage url="https://cdn/two.webp" cacheKey="two" />);
    });
    expect(tree!.root.findByType('image').props.recyclingKey).toBe('two');
  });

  it('releases the failure latch when only the url changes (fallback source swap)', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/preview.webp" cacheKey="stable-key" />);
    });
    exhaustImageLoad(tree!);
    expect(tree!.root.findAllByType('image')).toHaveLength(0);

    renderer.act(() => {
      tree!.update(<StableMediaImage url="https://cdn/original.webp" cacheKey="stable-key" />);
    });
    const image = tree!.root.findByType('image');
    expect(image.props.source).toEqual({ uri: 'https://cdn/original.webp', cacheKey: 'stable-key' });
  });

  it('recovers from a latched failure via tap-to-retry', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/one.webp" cacheKey="one" />);
    });
    exhaustImageLoad(tree!);

    renderer.act(() => tree!.root.find((node) => String(node.type) === 'pressable').props.onPress());
    expect(tree!.root.findByType('image').props.source).toEqual({
      uri: 'https://cdn/one.webp',
      cacheKey: 'one',
    });
  });

  it('renews a failed image on retry without duplicate pending requests', async () => {
    let finish: (url: string) => void = () => undefined;
    const resolveRetryUrl = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<StableMediaImage url="https://cdn/stale.jpg" cacheKey="reference" resolveRetryUrl={resolveRetryUrl} />); });
    exhaustImageLoad(tree!);
    const retry = tree!.root.findByType('pressable' as never).props.onPress;
    renderer.act(() => { retry(); retry(); });
    expect(resolveRetryUrl).toHaveBeenCalledTimes(1);
    expect(tree!.root.findByType('pressable' as never).props.disabled).toBe(true);
    expect(JSON.stringify(tree!.toJSON())).toContain('Refreshing image…');
    await renderer.act(async () => { finish('https://cdn/fresh.jpg'); });
    expect(tree!.root.findByType('image').props.source).toEqual({ uri: 'https://cdn/fresh.jpg', cacheKey: 'reference' });
    renderer.act(() => tree.unmount());
  });

  it('keeps renewal failure visible and allows another retry', async () => {
    const resolveRetryUrl = vi.fn().mockRejectedValueOnce(new Error('Denied')).mockResolvedValueOnce('https://cdn/fresh.jpg');
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<StableMediaImage url="https://cdn/stale.jpg" cacheKey="reference" resolveRetryUrl={resolveRetryUrl} />); });
    exhaustImageLoad(tree!);
    await renderer.act(async () => { tree!.root.findByType('pressable' as never).props.onPress(); });
    expect(JSON.stringify(tree!.toJSON())).toContain('Couldn’t refresh image. Try again.');
    expect(tree!.root.findByType('pressable' as never).props.disabled).toBe(false);
    expect(tree!.root.findAllByType('image')).toHaveLength(0);
    await renderer.act(async () => { tree!.root.findByType('pressable' as never).props.onPress(); });
    expect(tree!.root.findByType('image').props.source.uri).toBe('https://cdn/fresh.jpg');
    renderer.act(() => tree.unmount());
  });

  it('does not replace a newly selected image with an old renewal response', async () => {
    let finish: (url: string) => void = () => undefined;
    const resolveRetryUrl = () => new Promise<string>(resolve => { finish = resolve; });
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<StableMediaImage url="https://cdn/stale.jpg" cacheKey="reference" resolveRetryUrl={resolveRetryUrl} />); });
    exhaustImageLoad(tree!);
    renderer.act(() => { tree!.root.findByType('pressable' as never).props.onPress(); });
    renderer.act(() => { tree!.update(<StableMediaImage url="https://cdn/other.jpg" cacheKey="reference" resolveRetryUrl={resolveRetryUrl} />); });
    await renderer.act(async () => { finish('https://cdn/fresh.jpg'); });
    expect(tree!.root.findByType('image').props.source.uri).toBe('https://cdn/other.jpg');
    renderer.act(() => tree.unmount());
  });

  it('ignores renewal after the image is closed', async () => {
    let finish: (url: string) => void = () => undefined;
    const resolveRetryUrl = () => new Promise<string>(resolve => { finish = resolve; });
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<StableMediaImage url="https://cdn/stale.jpg" cacheKey="reference" resolveRetryUrl={resolveRetryUrl} />); });
    exhaustImageLoad(tree!);
    renderer.act(() => { tree!.root.findByType('pressable' as never).props.onPress(); });
    renderer.act(() => tree.unmount());
    await renderer.act(async () => { finish('https://cdn/fresh.jpg'); });
    expect(tree!.toJSON()).toBeNull();
  });

  it('keeps the thumbhash visible in the failure tile when one exists', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <StableMediaImage url="https://cdn/one.webp" cacheKey="one" thumbhash="thumbhash-base64" />
      );
    });
    exhaustImageLoad(tree!);

    const placeholderImages = tree!.root
      .findAllByType('image')
      .filter((node) => node.props.placeholder?.thumbhash === 'thumbhash-base64' && !node.props.source);
    expect(placeholderImages).toHaveLength(1);
  });
});

describe('StableMediaImage display watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearMediaDiagnosticsForTests();
    appState.currentState = 'active';
    appState.listeners = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const eventsOf = (event: string) => readMediaDiagnostics().events.filter((entry) => entry.event === event);
  const advance = (ms: number) => renderer.act(() => {
    vi.advanceTimersByTime(ms);
  });
  const setAppState = (state: string) => {
    appState.currentState = state;
    renderer.act(() => {
      appState.listeners.forEach((listener) => listener(state));
    });
  };

  it('reloads an image that neither displays nor fails, then hands it to the reader to retry', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/stuck.webp" cacheKey="stuck" watchdog />);
    });

    // Two bounded reloads, one per deadline...
    advance(MEDIA_DISPLAY_DEADLINE_MS);
    advance(MEDIA_DISPLAY_DEADLINE_MS);
    expect(eventsOf('stall')).toHaveLength(2);
    expect(eventsOf('retry')).toHaveLength(2);
    expect(tree.root.findAllByType('image')).toHaveLength(1);

    // ...then the reader gets a retry control instead of an endless placeholder.
    advance(MEDIA_DISPLAY_DEADLINE_MS);
    expect(eventsOf('latched')).toHaveLength(1);
    expect(JSON.stringify(tree.toJSON())).toContain('Taking too long to load');

    renderer.act(() => tree.root.findByType('pressable' as never).props.onPress());
    expect(tree.root.findByType('image').props.source).toEqual({ uri: 'https://cdn/stuck.webp', cacheKey: 'stuck' });

    renderer.act(() => tree.unmount());
    expect(mediaRecoveryBudget.activeCount()).toBe(0);
  });

  it('stands down once the image displays', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/shown.webp" cacheKey="shown" watchdog />);
    });

    renderer.act(() => tree.root.findByType('image').props.onDisplay());
    advance(MEDIA_DISPLAY_DEADLINE_MS * 3);

    expect(eventsOf('stall')).toHaveLength(0);
    renderer.act(() => tree.unmount());
  });

  it('counts foreground time only', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/slow.webp" cacheKey="slow" watchdog />);
    });

    advance(10_000);
    setAppState('background');
    advance(60_000);
    expect(eventsOf('stall')).toHaveLength(0);

    setAppState('active');
    advance(MEDIA_DISPLAY_DEADLINE_MS - 1);
    expect(eventsOf('stall')).toHaveLength(0);
    advance(1);
    expect(eventsOf('stall')).toHaveLength(1);

    renderer.act(() => tree.unmount());
  });

  it('never times an image whose caller did not ask, such as a page the system may detach', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<StableMediaImage url="https://cdn/offscreen.webp" cacheKey="offscreen" />);
    });

    advance(MEDIA_DISPLAY_DEADLINE_MS * 4);

    expect(readMediaDiagnostics().events).toHaveLength(0);
    expect(tree.root.findAllByType('image')).toHaveLength(1);
    renderer.act(() => tree.unmount());
  });

  it('reloads only two stalled images at a time', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <>
          <StableMediaImage url="https://cdn/a.webp" cacheKey="a" watchdog />
          <StableMediaImage url="https://cdn/b.webp" cacheKey="b" watchdog />
          <StableMediaImage url="https://cdn/c.webp" cacheKey="c" watchdog />
        </>
      );
    });

    advance(MEDIA_DISPLAY_DEADLINE_MS);
    expect(eventsOf('stall')).toHaveLength(3);
    expect(eventsOf('retry')).toHaveLength(2);

    // One recovered image frees its slot for the one that was waiting.
    const [first] = tree.root.findAllByType('image');
    renderer.act(() => first.props.onDisplay());
    advance(MEDIA_RECOVERY_WAIT_MS);
    expect(eventsOf('retry')).toHaveLength(3);

    renderer.act(() => tree.unmount());
    expect(mediaRecoveryBudget.activeCount()).toBe(0);
  });

  it('records what stalled without its address or token', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <StableMediaImage
          url="https://storage.example/object/sign/generated_images/owner-1/private.webp?token=secret-token"
          cacheKey="owner-1/private.webp"
          watchdog
          diagnosticsSurface="profile-grid"
        />
      );
    });

    advance(MEDIA_DISPLAY_DEADLINE_MS);

    expect(eventsOf('stall')[0]).toMatchObject({ kind: 'image', surface: 'profile-grid', attempt: 0, stage: 'no-response' });
    const serialized = JSON.stringify(readMediaDiagnostics());
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('owner-1');
    renderer.act(() => tree.unmount());
  });
});
