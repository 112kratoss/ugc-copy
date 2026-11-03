(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoPlayer } from 'expo-video';

/**
 * The player a tile lent the reel is the slide's to play while the slide plays
 * the same file (`useMediaZoomLentVideo`). A library read re-signs every
 * address it hands over, so the slide's address and the one the tile lent
 * under differ in their signature alone: about a second after the reel opens,
 * and at the open itself when the tile drew an older read than the reel's.
 * Matched address for address, the slide dropped the lent player for one of its
 * own, and the clip started over.
 */

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  StatusBar: { currentHeight: 0 },
  StyleSheet: { absoluteFill: { position: 'absolute', inset: 0 } },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 402, height: 874 }),
}));
vi.mock('expo-image', () => ({ Image: (props: MockProps) => React.createElement('expo-image', props) }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ addListener: () => () => {}, isFocused: () => true }) }));
vi.mock('expo-video', () => ({ VideoView: (props: MockProps) => React.createElement('video-view', props) }));
vi.mock('@/components/letterbox-bands', () => ({
  LetterboxBands: (props: MockProps) => React.createElement('letterbox-bands', props),
}));
vi.mock('@/components/top-scrim', () => ({ TopScrim: (props: MockProps) => React.createElement('top-scrim', props) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) }));
vi.mock('@/lib/env', () => ({
  env: { apiBaseUrl: 'https://magicbooklet.com', supabaseUrl: 'https://project.supabase.co', siteUrl: 'https://magicbooklet.com' },
}));

import { MediaZoomStage, useMediaZoomLentVideo, useMediaZoomStage, type MediaZoomLentVideo } from '../components/media-zoom';
import { clearPendingZoomOrigin, resetMediaZoomTransitions, setPendingZoomOrigin } from '../lib/media-zoom-transition';

const STORAGE = 'https://project.supabase.co';
const SCREEN = { width: 402, height: 874 };

/** A signed Storage address of `file`, from one read of the library. */
function signed(file: string, read: string) {
  const token = `head.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString('base64url')}.${read}`;
  return `${STORAGE}/storage/v1/object/sign/generated_videos/owner/${file}?token=${token}`;
}

const player = { id: 'tile-player' } as unknown as VideoPlayer;

/** The tile lends the player it plays `url` on, and the reel opens from it (Android's flight, landed). */
function openFromTile(url: string) {
  setPendingZoomOrigin({
    surfaceId: 'profile',
    itemId: 'post-1',
    rect: { x: 16, y: 300, width: 180, height: 240 },
    radius: 12,
    aspectRatio: 9 / 16,
    preview: null,
    video: { player, url },
    flightId: -1,
    native: false,
    recordedAt: Date.now(),
  });
}

/** What the slide playing `url` is handed, render by render. */
const seen: (MediaZoomLentVideo | null)[] = [];

function VideoSlide({ url }: { url: string }) {
  seen.push(useMediaZoomLentVideo(url));
  return null;
}

function Reel({ url }: { url: string }) {
  const stage = useMediaZoomStage({
    screen: SCREEN,
    initialItemId: 'post-1',
    activeItemId: 'post-1',
    aspectRatio: 9 / 16,
    reducedMotion: false,
    ready: true,
    expectsNeighbours: false,
    onExit: () => {},
  });
  return (
    <MediaZoomStage stage={stage} screen={SCREEN}>
      <VideoSlide url={url} />
    </MediaZoomStage>
  );
}

const mounted: renderer.ReactTestRenderer[] = [];
function mount(url: string) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<Reel url={url} />);
  });
  mounted.push(tree);
  return tree;
}

afterEach(() => {
  mounted.splice(0).forEach((tree) => renderer.act(() => tree.unmount()));
  seen.length = 0;
  clearPendingZoomOrigin();
  resetMediaZoomTransitions();
});

describe('the player a tile lent the reel', () => {
  it('is the slide\'s when the slide opens on a newer signature of the file the tile played', () => {
    openFromTile(signed('clip.mp4', 'tile-read'));
    mount(signed('clip.mp4', 'reel-read'));
    expect(seen.at(-1)?.video.player).toBe(player);
  });

  it('stays the slide\'s when a read re-signs the slide\'s address while it plays', () => {
    const tileRead = signed('clip.mp4', 'tile-read');
    openFromTile(tileRead);
    const tree = mount(tileRead);
    expect(seen.at(-1)?.video.player).toBe(player);
    renderer.act(() => tree.update(<Reel url={signed('clip.mp4', 'later-read')} />));
    expect(seen.at(-1)?.video.player).toBe(player);
  });

  it('is not for a slide playing another file', () => {
    openFromTile(signed('clip.mp4', 'tile-read'));
    mount(signed('other-clip.mp4', 'tile-read'));
    expect(seen.at(-1)).toBeNull();
  });

  it('is not for another address of a file outside Storage\'s signatures', () => {
    openFromTile('https://cdn.example/clip.m3u8?v=1');
    mount('https://cdn.example/clip.m3u8?v=2');
    expect(seen.at(-1)).toBeNull();
  });
});
