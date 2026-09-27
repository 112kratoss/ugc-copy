import { describe, expect, it, vi } from 'vitest';

import { buildCommentMenu } from '../lib/comment-menu';
import { buildFeedFeedbackMenu } from '../lib/feed-feedback-menu';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import {
  actionSheetFromMenu,
  compactNativeMenu,
  hasNativeMenuItems,
  menuAction,
  menuSubmenu,
  nativeMenuRows,
  type NativeMenuAction,
  type NativeMenuModel,
} from '../lib/native-menu';
import { buildPostVisibilityMenu, postVisibilityChoices } from '../lib/post-visibility-menu';
import { buildViewerActionsMenu } from '../lib/viewer-actions-menu';

const noop = () => undefined;

function action(id: string, extra: Partial<NativeMenuAction> = {}): NativeMenuAction {
  return menuAction({ id, label: id, onSelect: noop, ...extra });
}

function rowIds(model: NativeMenuModel) {
  return nativeMenuRows(model).map((row) => (row.kind === 'divider' ? '—' : row.action.id));
}

function viewerItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'item-1',
    source: 'showcase-feed',
    sourceType: 'showcase',
    title: 'Item',
    displayText: 'Item',
    mediaUrl: 'https://cdn.test/a.png',
    mediaKind: 'image',
    mediaItems: [],
    creatorLabel: '@creator',
    creatorAvatar: null,
    badge: 'Image',
    saveLabel: '0',
    saveCount: 0,
    commentLabel: '0',
    commentCount: 0,
    canComment: true,
    isSaved: false,
    canSave: true,
    canShare: true,
    sharePath: null,
    recreateTool: 'image',
    recreatePrompt: 'prompt',
    showcasePostId: 'post-1',
    generationId: null,
    ownerPostId: null,
    availableActions: [],
    disabledActions: {},
    ...overrides,
  };
}

describe('native menu model', () => {
  it('drops sections and submenus left with nothing in them', () => {
    const model: NativeMenuModel = {
      quickActions: [],
      sections: [
        { id: 'empty', title: 'Empty', items: [] },
        { id: 'bare-submenu', items: [menuSubmenu({ id: 'sub', label: 'Sub', items: [] })] },
        { id: 'kept', items: [action('a')] },
      ],
    };
    expect(compactNativeMenu(model).sections.map((section) => section.id)).toEqual(['kept']);
    expect(hasNativeMenuItems(model)).toBe(true);
    expect(hasNativeMenuItems({ quickActions: [], sections: [{ id: 'empty', items: [] }] })).toBe(false);
    expect(hasNativeMenuItems({ quickActions: [action('q')], sections: [] })).toBe(true);
  });

  it("lists Android's rows with quick actions first and a divider between groups", () => {
    const model: NativeMenuModel = {
      quickActions: [action('q1'), action('q2')],
      sections: [
        { id: 'one', title: 'One', items: [action('a'), action('b')] },
        { id: 'empty', items: [] },
        { id: 'two', items: [action('c')] },
      ],
    };
    expect(rowIds(model)).toEqual(['q1', 'q2', '—', 'a', 'b', '—', 'c']);
  });

  it('draws a submenu as its one row where it can run a flat stand-in, and as its rows where it cannot', () => {
    const flat = vi.fn();
    const withFlat = menuSubmenu({ id: 'visibility', label: 'Change visibility', items: [action('public')], onSelectFlat: flat });
    const inline = menuSubmenu({ id: 'more', label: 'More', items: [action('x'), action('y')] });
    const rows = nativeMenuRows({ quickActions: [], sections: [{ id: 's', items: [withFlat, inline] }] });

    expect(rows.map((row) => (row.kind === 'action' ? row.action.label : '—'))).toEqual(['Change visibility', 'x', 'y']);
    const flatRow = rows[0];
    if (flatRow.kind !== 'action') throw new Error('expected an action row');
    flatRow.action.onSelect();
    expect(flat).toHaveBeenCalledTimes(1);
  });

  it('carries a disabled submenu down to the rows it lists in place', () => {
    const rows = nativeMenuRows({
      quickActions: [],
      sections: [{ id: 's', items: [menuSubmenu({ id: 'sub', label: 'Sub', disabled: true, items: [action('x')] })] }],
    });
    expect(rows).toEqual([{ kind: 'action', action: expect.objectContaining({ id: 'x', disabled: true }) }]);
  });

  it('becomes the same rows as an action sheet where native menus are missing', () => {
    const onSelect = vi.fn();
    const request = actionSheetFromMenu('Comment options', {
      quickActions: [],
      sections: [
        { id: 'one', items: [action('delete', { label: 'Delete', destructive: true, onSelect })] },
        { id: 'two', items: [action('report', { label: 'Report', subtitle: 'Why', disabled: true })] },
      ],
    });

    expect(request.title).toBe('Comment options');
    expect(request.actions).toEqual([
      { label: 'Delete', detail: undefined, destructive: true, disabled: undefined, onPress: onSelect },
      { label: 'Report', detail: 'Why', destructive: undefined, disabled: true, onPress: noop },
    ]);
  });
});

describe('feed menu', () => {
  const handlers = {
    onNotInterested: vi.fn(),
    onHideCreator: vi.fn(),
    onReportContent: vi.fn(),
    onReportUser: vi.fn(),
    onBlockUser: vi.fn(),
  };

  it("offers the sheet's rows: preferences first, then the destructive safety rows", () => {
    const menu = buildFeedFeedbackMenu({ creatorLabel: '@maya', hideCreatorDisabled: false, sessionOnly: false, ...handlers });

    expect(menu.sections.map((section) => section.title)).toEqual([undefined, 'Safety']);
    expect(menu.sections[0].items.map((item) => item.label)).toEqual(['Not interested', 'Hide @maya']);
    expect(menu.sections[1].items).toEqual([
      expect.objectContaining({ label: 'Report content', destructive: true }),
      expect.objectContaining({ label: 'Report user', destructive: true }),
      expect.objectContaining({ label: 'Block user', destructive: true }),
    ]);
  });

  it("tells a guest the choice lasts for the visit, as a heading on iOS and a line on each row elsewhere", () => {
    const menu = buildFeedFeedbackMenu({ creatorLabel: '@maya', hideCreatorDisabled: false, sessionOnly: true, ...handlers });

    expect(menu.sections[0].title).toBe('For this visit');
    expect(menu.sections[0].items.map((item) => (item.kind === 'action' ? item.subtitle : null)))
      .toEqual(['For this visit', 'For this visit']);
  });

  it('keeps the creator rows visible but disabled on your own post, and leaves out safety rows it was not given', () => {
    const menu = buildFeedFeedbackMenu({
      creatorLabel: '@me',
      hideCreatorDisabled: true,
      sessionOnly: false,
      onNotInterested: noop,
      onHideCreator: noop,
      onReportContent: noop,
    });

    expect(menu.sections[0].items[1]).toMatchObject({ label: 'Hide @me', disabled: true });
    expect(menu.sections[1].items.map((item) => item.label)).toEqual(['Report content']);
  });
});

describe('comment menu', () => {
  it('offers only what the viewer may do, each row destructive', () => {
    const own = buildCommentMenu({ canDelete: true, canRemove: false, canReport: false, onDelete: noop, onRemove: noop, onReport: noop });
    const onMyPost = buildCommentMenu({ canDelete: false, canRemove: true, canReport: true, onDelete: noop, onRemove: noop, onReport: noop });

    expect(own.sections[0].items.map((item) => item.label)).toEqual(['Delete']);
    expect(onMyPost.sections[0].items.map((item) => item.label)).toEqual(['Remove from post', 'Report']);
    expect(onMyPost.sections[0].items.every((item) => item.kind === 'action' && item.destructive)).toBe(true);
    expect(hasNativeMenuItems(buildCommentMenu({
      canDelete: false, canRemove: false, canReport: false, onDelete: noop, onRemove: noop, onReport: noop,
    }))).toBe(false);
  });
});

describe('post visibility choices', () => {
  it('checks the current value and marks every row as part of a pick-one list', () => {
    const rows = postVisibilityChoices('unlisted', noop);
    expect(rows.map((row) => [row.label, row.checked])).toEqual([
      ['Public', false],
      ['Unlisted', true],
      ['Private', false],
    ]);
  });

  it('changes nothing when the current value is chosen again', () => {
    const onPick = vi.fn();
    const [publicRow, unlistedRow] = postVisibilityChoices('unlisted', onPick);
    unlistedRow.onSelect();
    expect(onPick).not.toHaveBeenCalled();
    publicRow.onSelect();
    expect(onPick).toHaveBeenCalledWith('public');
  });

  it("is titled with the composer's question", () => {
    expect(buildPostVisibilityMenu('public', noop).sections[0].title).toBe('Who can see this?');
  });
});

describe('viewer menu', () => {
  it("opens with the rail's actions as a row of icons and keeps the sheet's groups below", () => {
    const menu = buildViewerActionsMenu({
      item: viewerItem(),
      actions: ['save', 'comment', 'share', 'recreate', 'view-details', 'open-original', 'not-interested', 'report-content', 'report-user', 'block-user'],
      onAction: noop,
    });

    // Three icons: iOS fits no more in the row, so Remix leads the first section.
    expect(menu.quickActions.map((row) => row.label)).toEqual(['Save', 'Comments', 'Share']);
    expect(menu.quickActions.every((row) => Boolean(row.systemImage))).toBe(true);
    expect(menu.sections.map((section) => section.title)).toEqual([undefined, 'Explore preferences', 'Safety']);
    expect(menu.sections[0].items.map((item) => item.label)).toEqual(['Remix', 'View details', 'Open original post']);
    expect(menu.sections[2].items.every((item) => item.kind === 'action' && item.destructive)).toBe(true);
  });

  it('runs the chosen action through the one handler the sheet uses', () => {
    const onAction = vi.fn();
    const menu = buildViewerActionsMenu({ item: viewerItem(), actions: ['share', 'download'], onAction });
    menu.quickActions[0].onSelect();
    const download = menu.sections[0].items[0];
    if (download.kind !== 'action') throw new Error('expected an action row');
    download.onSelect();
    expect(onAction.mock.calls).toEqual([['share'], ['download']]);
  });

  it('turns Change visibility into a pick-one submenu, with the picker sheet as its flat stand-in', () => {
    const onAction = vi.fn();
    const onPickVisibility = vi.fn();
    const menu = buildViewerActionsMenu({
      item: viewerItem({ sourceType: 'owner-post', visibility: 'public' }),
      actions: ['edit-post', 'change-visibility', 'archive'],
      onAction,
      visibility: 'public',
      onPickVisibility,
    });

    const yourPost = menu.sections.find((section) => section.title === 'Your post');
    const submenu = yourPost?.items.find((item) => item.id === 'change-visibility');
    if (submenu?.kind !== 'submenu') throw new Error('expected a submenu');
    expect(submenu.items.map((row) => [row.label, row.checked])).toEqual([
      ['Public', true],
      ['Unlisted', false],
      ['Private', false],
    ]);
    submenu.items[2].onSelect();
    expect(onPickVisibility).toHaveBeenCalledWith('private');
    submenu.onSelectFlat?.();
    expect(onAction).toHaveBeenCalledWith('change-visibility');
  });

  it('keeps a disabled row visible with its reason as its line, and never turns it into a submenu', () => {
    const menu = buildViewerActionsMenu({
      item: viewerItem({
        sourceType: 'owner-post',
        disabledActions: { 'change-visibility': 'This post is archived' },
      }),
      actions: ['change-visibility', 'change-visibility'],
      onAction: noop,
      visibility: 'public',
      onPickVisibility: noop,
    });

    const rows = menu.sections.flatMap((section) => section.items);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'action',
      label: 'Change visibility',
      disabled: true,
      subtitle: 'This post is archived',
    });
  });
});
