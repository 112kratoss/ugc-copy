(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const { push, device } = vi.hoisted(() => ({ push: vi.fn(), device: { fontScale: 1 } }));

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
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: device.fontScale }),
}));
vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(`${name}-icon`, props);
  return Object.fromEntries(['FileText', 'Heart', 'MessageCircle', 'MoreHorizontal', 'Share', 'Share2'].map((name) => [name, icon(name)]));
});
vi.mock('@/components/ui', () => ({ CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props) }));
vi.mock('@/lib/platform-glyphs', () => ({ ShareGlyph: (props: MockProps) => React.createElement('share-glyph', props) }));
// The menu itself is the reel's; the card hands it its note and where a press goes without one.
vi.mock('@/components/viewer-actions-menu', () => ({
  ViewerActionsMenu: ({ item, enabled, excludeActions, onFallbackPress, renderButton }: {
    item: { id: string };
    enabled: boolean;
    excludeActions?: string[];
    onFallbackPress: () => void;
    renderButton: (onPress: () => void) => React.ReactElement;
  }) => React.createElement('actions-menu', { itemId: item.id, enabled, excludeActions }, renderButton(onFallbackPress)),
}));

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
    onActionsOpen: vi.fn(),
    onHorizontalScrollToggle: vi.fn(),
  };
  const element = (more: Partial<React.ComponentProps<typeof ReelNotesSlide>> = {}) => (
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
      {...more}
    />
  );
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element());
  });
  const update = (more: Partial<React.ComponentProps<typeof ReelNotesSlide>>) => renderer.act(() => tree.update(element(more)));
  return { tree, props, update };
}

const labelled = (tree: renderer.ReactTestRenderer, label: string) => tree.root.find((node) => (
  String(node.type) === 'pressable' && node.props.accessibilityLabel === label
));
const texts = (tree: renderer.ReactTestRenderer) => tree.root
  .findAll((node) => String(node.type) === 'text' && typeof node.props.children === 'string')
  .map((node) => node.props.children as string);
const row = (tree: renderer.ReactTestRenderer) => tree.root.find((node) => String(node.type) === 'scroll-view');
/** A scroll event of the row: a 320pt card and a 12pt gap, so a card every 332pt. */
const scrolledTo = (offsetX: number) => ({ nativeEvent: { contentOffset: { x: offsetX, y: 0 } } });
const send = (tree: renderer.ReactTestRenderer, handler: string, event?: unknown) => renderer.act(() => {
  (row(tree).props[handler] as (event?: unknown) => void)(event);
});
/** The dots under the row, by what a screen reader is told of them. */
const dots = (tree: renderer.ReactTestRenderer, label: string) => tree.root
  .findAll((node) => String(node.type) === 'view' && node.props.accessibilityLabel === label);
/** Each card's action row, in order: whether a finger and a screen reader can reach it. */
const actionRows = (tree: renderer.ReactTestRenderer) => tree.root
  .findAll((node) => String(node.type) === 'view' && (node.props.pointerEvents === 'auto' || node.props.pointerEvents === 'none'))
  .map((node) => [node.props.pointerEvents, node.props.importantForAccessibility]);

describe('a page of notes in the reel', () => {
  beforeEach(() => {
    push.mockClear();
    device.fontScale = 1;
  });

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

  it('tells the reel which card the row came to rest on, and nothing for the card already in front', () => {
    const { tree, props } = render();
    send(tree, 'onMomentumScrollEnd', scrolledTo(664));
    expect(props.onFrontNoteChange).toHaveBeenCalledWith('n1', notes[2]);

    props.onFrontNoteChange.mockClear();
    send(tree, 'onMomentumScrollEnd', scrolledTo(0));
    expect(props.onFrontNoteChange).not.toHaveBeenCalled();
  });

  // Review of #774: the reel's current post moved only on a momentum end, and a
  // drag let go at rest sends none, leaving the middle card with dead buttons.
  it('takes a drag that ends at rest on a card, and waits while the row is between two', () => {
    const { tree, props } = render();
    send(tree, 'onScrollEndDrag', scrolledTo(200));
    expect(props.onFrontNoteChange).not.toHaveBeenCalled();
    send(tree, 'onScrollEndDrag', scrolledTo(332));
    expect(props.onFrontNoteChange).toHaveBeenCalledWith('n1', notes[1]);
  });

  it('holds the reel still while the row is dragged', () => {
    const { tree, props } = render();
    send(tree, 'onScrollBeginDrag');
    send(tree, 'onMomentumScrollEnd', scrolledTo(332));
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

  // Review of #774: a page of notes has no rail, and Not interested, Hide and
  // Report were out of reach for a note in the reel.
  it('keeps the reel\'s menu on each card, built only for the reel\'s current post', () => {
    const { tree, props } = render();
    const menus = tree.root.findAll((node) => String(node.type) === 'actions-menu');
    expect(menus.map((menu) => [menu.props.itemId, menu.props.enabled])).toEqual([['n1', true], ['n2', false], ['n3', false]]);
    // The page has no Details page for "View details" to slide to.
    expect(menus.every((menu) => (menu.props.excludeActions as string[]).includes('view-details'))).toBe(true);
    renderer.act(() => (labelled(tree, 'More options for Note n1').props.onPress as () => void)());
    expect(props.onActionsOpen).toHaveBeenCalledWith('n1');
  });

  // The comments sheet, the save and the menu answer for the reel's current
  // post. A neighbour's row waits for a finger and for a screen reader alike:
  // TalkBack could press a neighbour's Comment, which opened no sheet.
  it('keeps a neighbouring card\'s actions out of reach until it is the reel\'s current post', () => {
    const { tree, update } = render();
    expect(actionRows(tree)).toEqual([['auto', 'auto'], ['none', 'no-hide-descendants'], ['none', 'no-hide-descendants']]);
    update({ frontNoteId: 'n2' });
    expect(actionRows(tree)).toEqual([['none', 'no-hide-descendants'], ['auto', 'auto'], ['none', 'no-hide-descendants']]);
  });

  // Review of #774: the whole card was one button, so VoiceOver read it as one
  // element and its Save, Comment and Share could not be reached.
  it('nests no button inside another', () => {
    const { tree } = render();
    const insideAButton = (node: renderer.ReactTestInstance) => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (String(parent.type) === 'pressable') return true;
      }
      return false;
    };
    const buttons = tree.root.findAll((node) => String(node.type) === 'pressable');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.filter(insideAButton)).toEqual([]);
  });

  it('follows the reel when the card in front changes without a swipe', () => {
    // A block from another page took the first card: the reel's current post
    // is now the set's first, and the dots say so.
    const { tree, update } = render({ frontNoteId: 'n3' });
    expect(dots(tree, 'Note 3 of 3')).toHaveLength(1);
    update({ notes: [notes[1], notes[2]], frontNoteId: 'n2' });
    expect(dots(tree, 'Note 1 of 2')).toHaveLength(1);
    expect(actionRows(tree)).toEqual([['auto', 'auto'], ['none', 'no-hide-descendants']]);
  });

  it('has nothing to swipe, and no dots, for a set of one', () => {
    const { tree } = render({ notes: [notes[0]] });
    expect(row(tree).props.scrollEnabled).toBe(false);
    expect(texts(tree)).toContain('1 note');
    expect(dots(tree, 'Note 1 of 1')).toHaveLength(0);
  });

  it('does not say a title twice when the writing only repeats it', () => {
    const { tree } = render({ notes: [note('n1', { title: 'Same words', displayText: 'Same words' })] });
    expect(texts(tree).filter((text) => text === 'Same words')).toHaveLength(1);
  });

  // Review of #774: at a large text setting a long note outgrew its card and
  // the action row was clipped away. The type stops growing at 1.35 and the
  // writing gives up lines.
  it('gives the writing fewer lines at a larger text size, and stops the type growing past the card', () => {
    const lines = (tree: renderer.ReactTestRenderer) => tree.root
      .find((node) => String(node.type) === 'text' && node.props.children === 'Writing of n1').props.numberOfLines as number;
    const usual = lines(render().tree);
    device.fontScale = 2;
    const large = render().tree;
    expect(lines(large)).toBeLessThan(usual);
    expect(lines(large)).toBeGreaterThanOrEqual(2);
    const scaled = large.root.findAll((node) => String(node.type) === 'text');
    expect(scaled.every((node) => node.props.maxFontSizeMultiplier === 1.35)).toBe(true);
  });
});
