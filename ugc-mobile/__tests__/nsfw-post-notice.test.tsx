// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  appStateListeners: [] as Array<(state: string) => void>,
  revealNsfwPost: vi.fn(),
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.appStateListeners.push(listener);
      return { remove: () => undefined };
    },
  },
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios' },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Pill: (props: MockProps) => React.createElement('pill', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
}));
vi.mock('@/components/showcase-media-preview', () => ({
  ShowcaseMediaPreview: (props: MockProps) => React.createElement('media-preview', props),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ api: { revealNsfwPost: mocks.revealNsfwPost }, user: { id: 'viewer-1' } }),
}));
vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://magicbooklet.test' } }));

import { NsfwPostNotice } from '@/components/nsfw-post-notice';

function renderNotice(onRevealedChange: (revealed: boolean) => void) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<NsfwPostNotice postId="post-1" width={360} onRevealedChange={onRevealedChange} />);
  });
  return tree;
}

function button(tree: renderer.ReactTestRenderer, type: 'primary-button' | 'secondary-button', label: string) {
  const found = tree.root.findAll((node) => String(node.type) === type && node.props.label === label)[0];
  if (!found) throw new Error(`No ${type} "${label}"`);
  return found;
}

async function reveal(tree: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    await (button(tree, 'primary-button', 'Reveal post').props.onPress as () => Promise<void>)();
  });
}

beforeEach(() => {
  mocks.appStateListeners.length = 0;
  mocks.revealNsfwPost.mockReset();
  mocks.revealNsfwPost.mockResolvedValue({
    success: true,
    item: { id: 'post-1', title: 'The original', body: 'What the creator wrote.', mediaItems: [], nsfwRevealed: true },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NsfwPostNotice', () => {
  it('tells the page when the original appears and when Hide covers it again', async () => {
    const onRevealedChange = vi.fn();
    const tree = renderNotice(onRevealedChange);
    expect(onRevealedChange).toHaveBeenLastCalledWith(false);

    await reveal(tree);
    expect(onRevealedChange).toHaveBeenLastCalledWith(true);
    const texts = tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
    expect(texts).toContain('The original');

    renderer.act(() => { (button(tree, 'secondary-button', 'Hide this post').props.onPress as () => void)(); });
    expect(onRevealedChange).toHaveBeenLastCalledWith(false);
  });

  it('covers the post again after ten minutes, and says so', async () => {
    vi.useFakeTimers();
    const onRevealedChange = vi.fn();
    const tree = renderNotice(onRevealedChange);
    await reveal(tree);
    expect(onRevealedChange).toHaveBeenLastCalledWith(true);

    renderer.act(() => { vi.advanceTimersByTime(10 * 60 * 1000 - 1); });
    expect(onRevealedChange).toHaveBeenLastCalledWith(true);
    renderer.act(() => { vi.advanceTimersByTime(1); });
    expect(onRevealedChange).toHaveBeenLastCalledWith(false);
  });

  it('covers the post when the app leaves the foreground, and says so', async () => {
    const onRevealedChange = vi.fn();
    const tree = renderNotice(onRevealedChange);
    await reveal(tree);

    renderer.act(() => { for (const listener of mocks.appStateListeners) listener('background'); });
    expect(onRevealedChange).toHaveBeenLastCalledWith(false);
  });

  it('fills the column it is given with the revealed media', async () => {
    mocks.revealNsfwPost.mockResolvedValue({
      success: true,
      item: { id: 'post-1', title: 'The original', body: '', mediaItems: [{ id: 'm1', url: 'https://cdn.test/a.jpg', mediaKind: 'image' }], nsfwRevealed: true },
    });
    const tree = renderNotice(vi.fn());
    await reveal(tree);

    const preview = tree.root.findAll((node) => String(node.type) === 'media-preview')[0];
    expect(preview?.props.width).toBe(360);
  });
});
