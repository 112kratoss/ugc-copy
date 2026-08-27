import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => Promise.resolve(storage.get(key) ?? null),
    setItem: (key: string, value: string) => {
      storage.set(key, value);
      return Promise.resolve();
    },
  },
}));

import { isDestructiveViewerAction } from '../lib/viewer-actions';
import { hasImmersiveAudibleMedia } from '../lib/immersive-preview-view-model';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import {
  hydrateViewerAudioMuted,
  isViewerAudioMuted,
  resetViewerAudioMutedForTests,
  setViewerAudioMuted,
  subscribeViewerAudioMuted,
  toggleViewerAudioMuted,
} from '../lib/viewer-audio';
import {
  VIEWER_TOP_CONTROL_SIZE,
  viewerTopBadgeTop,
  viewerTopControlTop,
} from '../lib/viewer-chrome';

/**
 * S6's rules, in the form a suite can hold. Sources: Going full screen, Playing
 * video, Playing audio, Page controls, Status bars, Gestures — plus Action
 * sheets on what the destructive style is for.
 */

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

const viewer = read('app/viewer.tsx');

describe('S6 — the status bar over full-bleed media', () => {
  // Status bars: "Obscure content under the status bar ... Be sure to keep the
  // status bar readable." The reel is the only full-bleed screen in the app and
  // the strip behind the clock is a blurred cover crop of the media itself.
  it('draws the same top scrim the scrolling screens draw', () => {
    expect(viewer).toContain("from '@/components/top-scrim'");
    // `over="media"` is the point: the app variant is half-faded by the rows the
    // clock is drawn on, which protects nothing when the content is a photo.
    expect(viewer).toContain('<TopScrim topInset={topInset} over="media" />');
    const scrim = read('components/top-scrim.tsx');
    expect(scrim).toContain('MEDIA_SCRIM_HOLD = 0.6');
    expect(scrim).toContain('locations={over === \'media\' ? [0, MEDIA_SCRIM_HOLD, 1] : undefined}');
  });

  it('keeps the scrim between the reel and the sheets it must not band', () => {
    const scrim = viewer.indexOf('<TopScrim topInset={topInset} over="media" />');
    const list = viewer.indexOf('<FlatList');
    const firstSheet = viewer.indexOf('<ViewerActionSheet');
    expect(list).toBeGreaterThan(-1);
    expect(scrim).toBeGreaterThan(list);
    expect(scrim).toBeLessThan(firstSheet);
  });
});

describe('S6 — the viewer top strip is laid out from the safe area', () => {
  // Layout: essential content sits inside the safe area. The counter used to be
  // pinned at a flat `top: 68` and the refresh spinner at `topInset + 24`, so
  // the two were drawn over each other on every inset above 34pt.
  it.each([0, 20, 24, 34, 44, 59, 62])('never overlaps its two rows at inset %i', (inset) => {
    const controlBottom = viewerTopControlTop(inset) + VIEWER_TOP_CONTROL_SIZE;
    expect(viewerTopControlTop(inset)).toBeGreaterThanOrEqual(inset);
    expect(viewerTopBadgeTop(inset)).toBeGreaterThan(controlBottom);
  });

  it('places every top-strip element through the shared geometry', () => {
    expect(viewer).not.toContain('top: 68');
    expect(viewer).not.toContain('top: topInset + 24');
    expect(viewer).not.toContain('top: topInset + 10');
    expect(viewer.match(/viewerTopControlTop\(topInset\)/g)?.length).toBe(3);
    expect(viewer.match(/viewerTopBadgeTop\(topInset\)/g)?.length).toBe(2);
  });

  it('puts the spinner and the counter on opposite edges of the badge row', () => {
    const spinner = viewer.slice(viewer.indexOf('sourceQuery.isFetching && activeItem'));
    expect(spinner).toContain('left: 30');
    const counter = viewer.slice(viewer.indexOf('Media count indicator'), viewer.indexOf('Right rail'));
    expect(counter).toContain('right: 18');
  });
});

describe('S6 — the reel can be silenced without leaving it', () => {
  beforeEach(() => {
    storage.clear();
    resetViewerAudioMutedForTests();
  });

  // Going full screen: "Continue to provide access to essential features and
  // controls so people can complete their task without exiting full-screen mode."
  it('renders a labelled mute control on any slide that can make a sound', () => {
    expect(viewer).toContain("accessibilityLabel={audioMuted ? 'Unmute video' : 'Mute video'}");
    expect(viewer).toContain('hasImmersiveAudibleMedia(activeItem)');
    expect(viewer).toContain('toggleViewerAudioMuted()');
  });

  it('offers the control before the reader swipes onto the video page', () => {
    const item = (overrides: Partial<ImmersivePreviewItem>) => overrides as ImmersivePreviewItem;
    expect(hasImmersiveAudibleMedia(item({ mediaKind: 'video', mediaUrl: 'https://x/a.mp4' }))).toBe(true);
    expect(hasImmersiveAudibleMedia(item({
      mediaKind: 'image',
      mediaItems: [
        { id: 'a', mediaKind: 'image', url: 'https://x/a.jpg' },
        { id: 'b', mediaKind: 'video', url: 'https://x/b.mp4' },
      ],
    } as Partial<ImmersivePreviewItem>))).toBe(true);
    expect(hasImmersiveAudibleMedia(item({ mediaKind: 'image', mediaItems: [] }))).toBe(false);
    expect(hasImmersiveAudibleMedia(undefined)).toBe(false);
  });

  it('answers every slide from one store rather than per-player state', () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeViewerAudioMuted(() => seen.push(isViewerAudioMuted()));
    toggleViewerAudioMuted();
    toggleViewerAudioMuted();
    setViewerAudioMuted(false);
    unsubscribe();
    toggleViewerAudioMuted();
    expect(seen).toEqual([true, false]);
  });

  it('carries the choice into the next visit', async () => {
    setViewerAudioMuted(true);
    resetViewerAudioMutedForTests();
    expect(isViewerAudioMuted()).toBe(false);
    await hydrateViewerAudioMuted();
    expect(isViewerAudioMuted()).toBe(true);
  });

  it('drives the player from the store instead of a hard-coded false', () => {
    expect(viewer).toContain('instance.muted = isViewerAudioMuted();');
    expect(viewer).toContain('player.muted = audioMuted;');
    expect(viewer).not.toContain('instance.muted = false;');
  });
});

describe('S6 — no player holds the audio session while it is silent', () => {
  // Playing audio: "don't make people stop listening to music from another app
  // if you don't need to." expo-video's iOS default is `doNotMix`, which takes
  // the session the moment any player plays; Android's default is already
  // `auto`. Declaring it makes both platforms behave the same way.
  const playerFiles = [
    'app/viewer.tsx',
    'components/feed-video-preview.tsx',
    'components/media-lightbox.tsx',
    'components/media-preview.tsx',
  ];

  it.each(playerFiles)('%s declares a mixing mode for every player it creates', (name) => {
    const source = read(name);
    const created = source.match(/use VideoPlayer|useVideoPlayer\(|createVideoPlayer\(/g)?.length ?? 0;
    const declared = source.match(/audioMixingMode = 'auto'/g)?.length ?? 0;
    expect(created).toBeGreaterThan(0);
    expect(declared).toBe(created);
  });

  it('has no player anywhere else that could take it silently', () => {
    const roots = ['app', 'components', 'lib'];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of require('node:fs').readdirSync(path.join(mobileRoot, dir))) {
        const relative = `${dir}/${entry}`;
        if (require('node:fs').statSync(path.join(mobileRoot, relative)).isDirectory()) {
          walk(relative);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const source = read(relative);
        if (!/useVideoPlayer\(|createVideoPlayer\(/.test(source)) continue;
        if (!playerFiles.includes(relative)) offenders.push(relative);
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});

describe('S6 — one play badge, and one meaning for the destructive style', () => {
  // Icons: one consistent size, level of detail and stroke thickness across the
  // set. The reel drew this badge four times at three treatments.
  it('draws the not-playing badge from a single component', () => {
    expect(viewer.match(/<ViewerPlayBadge \/>/g)?.length).toBe(4);
    expect(viewer.match(/<Play size=/g)?.length).toBe(1);
    expect(viewer).toContain('size={appTheme.icon.hero}');
  });

  // Action sheets: "Use the destructive style for buttons that perform
  // destructive actions."
  it('reserves the destructive style for what it destroys', () => {
    expect(isDestructiveViewerAction('unsave')).toBe(false);
    expect(isDestructiveViewerAction('save')).toBe(false);
    for (const action of ['archive', 'delete-post', 'block-user', 'report-content']) {
      expect(isDestructiveViewerAction(action)).toBe(true);
    }
  });
});

describe('S6 — the counter answers the finger', () => {
  // Gestures: "Handle gestures as responsively as possible ... provide feedback
  // that helps them predict its results." The settled index may only move once
  // a page lands, because it also gates video and hardware back.
  it('reads the dragged page, not the settled one', () => {
    const counter = viewer.slice(viewer.indexOf('Media count indicator'), viewer.indexOf('Right rail'));
    expect(counter).toContain('Math.min(draggedPageIndex + 1, mediaCount)');
    expect(counter).not.toContain('currentHorizontalIndex');
  });

  it('tracks the drag without moving what the reel believes', () => {
    expect(viewer).toContain('scrollEventThrottle={16}');
    expect(viewer).toContain('setDraggedPageIndex(Math.max(0, Math.min(pages.length - 1, page)));');
    const settled = viewer.slice(viewer.indexOf('const updateCurrentHorizontalIndex'));
    expect(settled.slice(0, 300)).toContain('setDraggedPageIndex(pageIndex);');
  });
});
