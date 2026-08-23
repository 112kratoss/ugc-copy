import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  Modal: ({ children, visible, ...props }: MockProps) =>
    React.createElement('modal', { visible, ...props }, visible ? children : null),
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', { ...props, style: resolvePressableStyle(style) }, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 40, bottom: 20, left: 0, right: 0 }),
}));

vi.mock('expo-video', () => ({
  useVideoPlayer: (url: string) => ({ url }),
  VideoView: (props: MockProps) => React.createElement('video-view', props),
}));

vi.mock('lucide-react-native', () => ({
  ChevronLeft: (props: MockProps) => React.createElement('chevron-left-icon', props),
  ChevronRight: (props: MockProps) => React.createElement('chevron-right-icon', props),
  X: (props: MockProps) => React.createElement('x-icon', props),
}));

vi.mock('@/components/media-preview', () => ({
  StableMediaImage: (props: MockProps) => React.createElement('stable-image', props),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));

import { MediaLightbox, type LightboxMediaItem } from '@/components/media-lightbox';

const items: LightboxMediaItem[] = [
  { id: 'alisa', url: 'https://cdn.example.com/alisa.jpg', mediaKind: 'image', label: '@alisa', caption: 'Character reference' },
  { id: 'camera', url: 'https://cdn.example.com/camera.mp4', mediaKind: 'video', label: 'Camera movement' },
];

function render(activeIndex: number | null, handlers: { onClose?: () => void; onNavigate?: (index: number) => void } = {}) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(
      <MediaLightbox
        items={items}
        activeIndex={activeIndex}
        onClose={handlers.onClose ?? vi.fn()}
        onNavigate={handlers.onNavigate ?? vi.fn()}
      />
    );
  });
  return tree!;
}

function buttons(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label);
}

function textValues(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text')
    .flatMap((node) => typeof node.props.children === 'string' ? [node.props.children] : []);
}

describe('MediaLightbox', () => {
  it('stays closed and renders nothing without an active item', () => {
    const tree = render(null);

    expect(tree.root.findByType('modal' as never).props.visible).toBe(false);
    expect(tree.root.findAll((node) => String(node.type) === 'stable-image')).toHaveLength(0);
  });

  it('shows an image on a contained stage with its label and counter', () => {
    const tree = render(0);

    const image = tree.root.findByType('stable-image' as never);
    expect(image.props.url).toBe('https://cdn.example.com/alisa.jpg');
    expect(image.props.contentFit).toBe('contain');
    expect(textValues(tree)).toEqual(expect.arrayContaining(['@alisa', '1 of 2 · Character reference']));
    expect(buttons(tree, 'Show next media')).toHaveLength(1);
    expect(buttons(tree, 'Show previous media')).toHaveLength(0);
  });

  it('plays a video with native controls', () => {
    const tree = render(1);

    const video = tree.root.findByType('video-view' as never);
    expect(video.props.nativeControls).toBe(true);
    expect(video.props.player).toEqual({ url: 'https://cdn.example.com/camera.mp4' });
    expect(tree.root.findAll((node) => String(node.type) === 'stable-image')).toHaveLength(0);
  });

  it('closes and steps between neighbours', () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const tree = render(0, { onClose, onNavigate });

    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Show next media' }).props.onPress();
      tree.root.findByProps({ accessibilityLabel: 'Close media preview' }).props.onPress();
    });

    expect(onNavigate).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
