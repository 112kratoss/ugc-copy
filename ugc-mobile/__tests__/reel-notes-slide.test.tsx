(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('expo-router', () => ({ router: { push } }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(`${name}-icon`, props);
  return Object.fromEntries(['FileText', 'Heart', 'MessageCircle', 'Share', 'Share2'].map((name) => [name, icon(name)]));
});
vi.mock('@/components/ui', () => ({ CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props) }));
vi.mock('@/lib/platform-glyphs', () => ({ ShareGlyph: (props: MockProps) => React.createElement('share-glyph', props) }));

import { ReelNotesSlide } from '../components/reel-notes-slide';

function note(id: string, overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id,
    source: 'showcase-feed',
    sourceType: 'showcase',
    previewKind: 'text',
    title: `Note ${id}`,
    displayText: `Writing of ${id}`,
    mediaUrl: null,
    mediaKind: null,
    mediaItems: [],
    creatorLabel: '@luna',
    creatorAvatar: null,
    creatorUsername: 'luna',
    badge: 'Free recipe',
    saveCount: 2,
    commentCount: 0,
    canComment: true,
    isSaved: false,
    canSave: true,
    canShare: true,
    showcasePostId: id,
    ...overrides,
  } as ImmersivePreviewItem;
}

const notes = [note('n1'), note('n2'), note('n3')];

function render(overrides: Partial<React.ComponentProps<typeof ReelNotesSlide>> = {}) {
  // Kept apart from the overrides, so each stays a mock to the tests.
  const props = {
    onFrontNoteChange: vi.fn(),
    onSave: vi.fn(),
    onComments: vi.fn(),
    onShare: vi.fn(),
    onCreatorOpen: vi.fn(),
    onHorizontalScrollToggle: vi.fn(),
  };
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <ReelNotesSlide
        active
        setKey="n1"
        notes={notes}
        frontNoteId="n1"
        label="Notes for you"
        width={400}
        height={800}
        topInset={50}
        bottomInset={30}
        savingPostId={null}
        {...props}
        {...overrides}
      />,
    );
  });
  return { tree, props };
}

const labelled = (tree: renderer.ReactTestRenderer, label: string) => tree.root.find((node) => (
  String(node.type) === 'pressable' && node.props.accessibilityLabel === label
));
const texts = (tree: renderer.ReactTestRenderer) => tree.root
  .findAll((node) => String(node.type) === 'text' && typeof node.props.children === 'string')
  .map((node) => node.props.children as string);
/** The row's scroll events, at the offset of the nth card: a 320pt card and a 12pt gap. */
const scrolledTo = (index: number) => ({ nativeEvent: { contentOffset: { x: index * 332, y: 0 } } });

describe('a page of notes in the reel', () => {
  beforeEach(() => push.mockClear());

  it('draws every note of the set as a card that names its writer, and says what the set is', () => {
    const { tree } = render();
    expect(texts(tree)).toEqual(expect.arrayContaining(['Note n1', 'Writing of n1', 'Note n2', 'Note n3', '@luna', 'Notes for you', '3 notes']));
    expect(labelled(tree, 'Read the note Note n2, by @luna')).toBeTruthy();
  });

  it('opens a note on its own page', () => {
    const { tree } = render();
    renderer.act(() => (labelled(tree, 'Read the note Note n1, by @luna').props.onPress as () => void)());
    expect(push).toHaveBeenCalledWith('/post/n1');
  });

  it('tells the reel which card landed, and nothing for the card already in front', () => {
    const { tree, props } = render();
    const row = tree.root.find((node) => String(node.type) === 'scroll-view');

    renderer.act(() => (row.props.onMomentumScrollEnd as (event: unknown) => void)(scrolledTo(2)));
    expect(props.onFrontNoteChange).toHaveBeenCalledWith('n1', notes[2]);

    props.onFrontNoteChange.mockClear();
    renderer.act(() => (row.props.onMomentumScrollEnd as (event: unknown) => void)(scrolledTo(0)));
    expect(props.onFrontNoteChange).not.toHaveBeenCalled();
  });

  it('holds the reel still while the row is dragged', () => {
    const { tree, props } = render();
    const row = tree.root.find((node) => String(node.type) === 'scroll-view');
    renderer.act(() => (row.props.onScrollBeginDrag as () => void)());
    renderer.act(() => (row.props.onMomentumScrollEnd as (event: unknown) => void)(scrolledTo(1)));
    expect(props.onHorizontalScrollToggle.mock.calls).toEqual([[true], [false]]);
  });

  it('saves, comments on and shares the note its card belongs to', () => {
    const { tree, props } = render();
    renderer.act(() => (labelled(tree, 'Save Note n1').props.onPress as () => void)());
    renderer.act(() => (labelled(tree, 'Comments on Note n1').props.onPress as () => void)());
    renderer.act(() => (labelled(tree, 'Share Note n1').props.onPress as () => void)());
    expect(props.onSave).toHaveBeenCalledWith(notes[0]);
    expect(props.onComments).toHaveBeenCalledWith(notes[0]);
    expect(props.onShare).toHaveBeenCalledWith(notes[0]);
  });

  // The comments sheet and the save belong to the reel's current post, which
  // is the card in front: a neighbour's buttons wait until it is swiped to.
  it('keeps a neighbouring card\'s actions out of reach until it is in front', () => {
    const { tree } = render();
    const rows = tree.root.findAll((node) => String(node.type) === 'view' && (node.props.pointerEvents === 'auto' || node.props.pointerEvents === 'none'));
    expect(rows.map((row) => row.props.pointerEvents)).toEqual(['auto', 'none', 'none']);
  });

  it('has nothing to swipe, and no dots, for a set of one', () => {
    const { tree } = render({ notes: [notes[0]] });
    const row = tree.root.find((node) => String(node.type) === 'scroll-view');
    expect(row.props.scrollEnabled).toBe(false);
    expect(texts(tree)).toContain('1 note');
    expect(tree.root.findAll((node) => node.props.accessibilityLabel === 'Note 1 of 1')).toHaveLength(0);
  });

  it('does not say a title twice when the writing only repeats it', () => {
    const { tree } = render({ notes: [note('n1', { title: 'Same words', displayText: 'Same words' })] });
    expect(texts(tree).filter((text) => text === 'Same words')).toHaveLength(1);
  });
});
