import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { FeedCardShell } from '../components/feed-card-shell';
import {
  CREATOR_PROFILE_PRESS_DELAY_MS,
  creatorProfilePress,
  setCreatorProfilePreparer,
  type CreatorProfilePress,
} from '../lib/creator-profile-opening';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: resolvePressableStyle(style),
  }, children),
  StyleSheet: { hairlineWidth: 0.5, absoluteFillObject: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } },
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  MoreVertical: (props: MockProps) => React.createElement('icon', props),
}));

vi.mock('@/components/ui', () => ({
  CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props),
}));

vi.mock('@/lib/haptics', () => ({
  haptic: { light: () => {} },
}));

vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  usePressMotion: () => ({ animatedStyle: {}, onPressIn: () => {}, onPressOut: () => {} }),
}));

type Instance = renderer.ReactTestInstance;

function textOf(node: Instance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

async function renderShell(props: {
  categoryLabel: string;
  modelLabel?: string | null;
  creatorPress?: CreatorProfilePress | null;
  media?: React.ReactNode;
  body?: React.ReactNode;
  readMore?: React.ReactNode;
  creditLine?: React.ReactNode | null;
}) {
  let tree: renderer.ReactTestRenderer | null = null;
  await act(async () => {
    tree = renderer.create(
      <FeedCardShell
        actions={null}
        creatorAvatar={null}
        creatorLabel="@ana"
        creatorName="Ana"
        creatorPress={creatorProfilePress('ana', () => {})}
        onMorePress={() => {}}
        moreAccessibilityLabel="More options for A launch frame"
        openAccessibilityLabel="Open A launch frame"
        timeLabel="2h"
        title="A launch frame"
        {...props}
      />,
    );
  });
  return tree!;
}

function isHost(node: Instance, type: string) {
  return node.type === type;
}

/** The nearest host element of a type above a node: the mocks wrap each host in a component. */
function hostAbove(node: Instance, type: string) {
  let current = node.parent;
  while (current && current.type !== type) current = current.parent;
  if (!current) throw new Error(`No ${type} above the node`);
  return current;
}

/** The text nodes of the card's top row that read as the post's kind. */
function metadataLines(tree: renderer.ReactTestRenderer, kind: string) {
  return tree.root.findAll((node) => isHost(node, 'text') && textOf(node).startsWith(kind));
}

describe('FeedCardShell metadata line', () => {
  it('names the model after the category, on one line', async () => {
    const tree = await renderShell({ categoryLabel: 'Video', modelLabel: 'Kling 2.5' });

    const lines = metadataLines(tree, 'Video');
    expect(lines.map(textOf)).toEqual(['Video · Kling 2.5']);
    expect(lines[0].props.numberOfLines).toBe(1);

    await act(async () => tree.unmount());
  });

  it.each([undefined, null, ''])('reads the category alone when the post names no model (%s)', async (modelLabel) => {
    const tree = await renderShell({ categoryLabel: 'Image', modelLabel });

    expect(metadataLines(tree, 'Image').map(textOf)).toEqual(['Image']);

    await act(async () => tree.unmount());
  });

  it('keeps a long model line to half the row, so it cannot crowd the byline out', async () => {
    const tree = await renderShell({ categoryLabel: 'Video', modelLabel: 'Grok Imagine Video 1.5' });

    // The byline takes what the row has left (`flex: 1` sizes it from zero),
    // so a line with no limit of its own would leave it nothing.
    const [line] = metadataLines(tree, 'Video');
    expect(line.props.numberOfLines).toBe(1);
    expect(hostAbove(line, 'view').props.style).toMatchObject({ flexShrink: 1, maxWidth: '50%' });
    const byline = tree.root.find((node) => isHost(node, 'pressable') && node.props.accessibilityLabel === 'Open @ana');
    expect(byline.props.style).toMatchObject({ flex: 1 });

    await act(async () => tree.unmount());
  });
});

describe('FeedCardShell byline', () => {
  // The creator's page is read once the finger has rested on the byline, and
  // opened only by the press itself (`creatorProfilePress`).
  it('presses as a creator opener: the page read after the wait, opened by the press', async () => {
    const prepared: string[] = [];
    const removePreparer = setCreatorProfilePreparer((username) => prepared.push(username));
    const open = vi.fn();
    const tree = await renderShell({ categoryLabel: 'Image', creatorPress: creatorProfilePress('ana', open) });
    const byline = tree.root.find((node) => isHost(node, 'pressable') && node.props.accessibilityLabel === 'Open @ana');

    expect(byline.props.unstable_pressDelay).toBe(CREATOR_PROFILE_PRESS_DELAY_MS);
    await act(async () => (byline.props.onPressIn as () => void)());
    expect(prepared).toEqual(['ana']);
    expect(open).not.toHaveBeenCalled();

    await act(async () => (byline.props.onPress as () => void)());
    expect(open).toHaveBeenCalledTimes(1);

    removePreparer();
    await act(async () => tree.unmount());
  });

  it('is plain text, pressing nothing, for a card that opens no creator page', async () => {
    const tree = await renderShell({ categoryLabel: 'Image', creatorPress: null });
    const byline = tree.root.find((node) => isHost(node, 'pressable') && node.props.accessibilityLabel === '@ana · 2h');

    expect(byline.props.disabled).toBe(true);
    expect(byline.props.accessibilityRole).toBeUndefined();
    expect(byline.props.onPressIn).toBeUndefined();
    expect(byline.props.onPress).toBeUndefined();

    await act(async () => tree.unmount());
  });
});

// A remix's credit (owner, 2026-11-05) under a card's title: a media card holds it in its heading;
// a written card's heading holds its text, so the credit follows the text and its Read more. A card
// that is no remix gets no line, and no space held for one.
describe('FeedCardShell remix credit', () => {
  const host = (type: string, testID: string, text?: string) => React.createElement(type, { testID }, text);
  const credit = host('text', 'credit', 'Remix of “Sunset beach” by @cora');
  const order = (tree: renderer.ReactTestRenderer) => tree.root
    .findAll((node) => isHost(node, 'text') && ['body', 'read-more', 'credit'].includes(String(node.props.testID)))
    .map((node) => String(node.props.testID));

  it('follows a written post\'s text and its Read more', async () => {
    const tree = await renderShell({
      categoryLabel: 'Note',
      body: host('text', 'body', 'A long note'),
      readMore: host('text', 'read-more', 'Read more'),
      creditLine: credit,
    });

    expect(order(tree)).toEqual(['body', 'read-more', 'credit']);

    await act(async () => tree.unmount());
  });

  it('leaves no space on a written post that is no remix', async () => {
    const withCredit = await renderShell({ categoryLabel: 'Note', body: host('text', 'body', 'A long note'), creditLine: credit });
    const without = await renderShell({ categoryLabel: 'Note', body: host('text', 'body', 'A long note'), creditLine: null });
    const views = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => isHost(node, 'view')).length;

    expect(views(withCredit) - views(without)).toBe(1);
    expect(without.root.findAll((node) => node.props.testID === 'credit')).toHaveLength(0);

    await act(async () => { withCredit.unmount(); without.unmount(); });
  });

  it('sits under a media post\'s title, inside its heading', async () => {
    const tree = await renderShell({
      categoryLabel: 'Image',
      media: host('view', 'media'),
      body: host('text', 'body', 'A caption'),
      creditLine: credit,
    });

    expect(order(tree)).toEqual(['credit', 'body']);

    await act(async () => tree.unmount());
  });
});
