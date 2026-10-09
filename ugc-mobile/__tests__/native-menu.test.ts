import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import hideCreatorLabelContract from '../../contracts/hide-creator-label-v1.json';

import { buildCommentMenu } from '../lib/comment-menu';
import { buildFeedFeedbackMenu, canHideFeedCreator, isOwnFeedPost } from '../lib/feed-feedback-menu';
import { hideCreatorLabel, hideCreatorLabelFromCardLabel } from '../lib/hide-creator-label';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import {
  actionSheetFromMenu,
  compactNativeMenu,
  hasNativeMenuItems,
  menuAction,
  menuSubmenu,
  nativeMenuRows,
  nativeMenuSectionRows,
  type NativeMenuAction,
  type NativeMenuModel,
} from '../lib/native-menu';
import { buildPostVisibilityMenu, postVisibilityChoices } from '../lib/post-visibility-menu';
import { getViewerSafetyActions, isDestructiveViewerAction } from '../lib/viewer-actions';
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

  it('lists every row with the quick actions first and a divider between groups', () => {
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

  it("leaves the quick actions out of the rows under Android's icon row, and opens with no divider", () => {
    const flat = vi.fn();
    const rows = nativeMenuSectionRows({
      quickActions: [action('q1'), action('q2')],
      sections: [
        { id: 'one', items: [action('a'), menuSubmenu({ id: 'visibility', label: 'Change visibility', items: [action('public')], onSelectFlat: flat })] },
        { id: 'empty', items: [] },
        { id: 'two', items: [action('c')] },
      ],
    });

    expect(rows.map((row) => (row.kind === 'divider' ? '—' : row.action.id))).toEqual(['a', 'visibility', '—', 'c']);
    expect(nativeMenuSectionRows({ quickActions: [action('q1')], sections: [] })).toEqual([]);
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
    const menu = buildFeedFeedbackMenu({ creator: { username: 'maya', name: 'Maya R' }, canHideCreator: true, viewerIsOwner: false, sessionOnly: false, ...handlers });

    expect(menu.sections.map((section) => section.title)).toEqual([undefined, 'Safety']);
    expect(menu.sections[0].items.map((item) => item.label)).toEqual(['Not interested', 'Hide @maya']);
    expect(menu.sections[1].items).toEqual([
      expect.objectContaining({ label: 'Report content', destructive: true }),
      expect.objectContaining({ label: 'Report user', destructive: true }),
      expect.objectContaining({ label: 'Block user', destructive: true }),
    ]);
  });

  it("tells a guest the choice lasts for the visit, as a heading on iOS and a line on each row elsewhere", () => {
    const menu = buildFeedFeedbackMenu({ creator: { username: 'maya', name: 'Maya R' }, canHideCreator: true, viewerIsOwner: false, sessionOnly: true, ...handlers });

    expect(menu.sections[0].title).toBe('For this visit');
    expect(menu.sections[0].items.map((item) => (item.kind === 'action' ? item.subtitle : null)))
      .toEqual(['For this visit', 'For this visit']);
  });

  // Nothing can make hiding, reporting or blocking yourself possible, and a
  // report on your own post asks for a review of no one. The rows are left out,
  // not dimmed: the reel's menu and the web's do the same. Report content
  // stayed on your own post in the app until 2026-10-09.
  it('leaves the creator rows and Report content out on your own post, whatever handlers it was given', () => {
    const menu = buildFeedFeedbackMenu({ creator: { username: 'me', name: 'Me' }, canHideCreator: false, viewerIsOwner: true, sessionOnly: false, ...handlers });

    expect(rowIds(menu)).toEqual(['not-interested']);
    // No row is left under the Safety heading, so no heading is drawn.
    expect(compactNativeMenu(menu).sections.map((section) => section.id)).toEqual(['preferences']);
    expect(menu.sections.flatMap((section) => section.items).some((item) => item.disabled)).toBe(false);
  });

  it("keeps Report content on a post with no creator account, which is no one's own", () => {
    const menu = buildFeedFeedbackMenu({ creator: {}, canHideCreator: false, viewerIsOwner: false, sessionOnly: false, ...handlers });

    expect(menu.sections.map((section) => section.items.map((item) => item.label)))
      .toEqual([['Not interested'], ['Report content']]);
  });

  it('leaves out the safety rows it was not given', () => {
    const menu = buildFeedFeedbackMenu({
      creator: { username: 'maya', name: 'Maya R' },
      canHideCreator: true,
      viewerIsOwner: false,
      sessionOnly: false,
      onNotInterested: noop,
      onHideCreator: noop,
      onReportContent: noop,
    });

    expect(menu.sections[1].items.map((item) => item.label)).toEqual(['Report content']);
  });

  // One meaning for red across the two menus that share these rows: a feed
  // card's and the reel's. Hide was red in the reel and plain on a card.
  it("colours each row as the reel's menu colours the same row", () => {
    const menu = buildFeedFeedbackMenu({ creator: { username: 'maya', name: 'Maya R' }, canHideCreator: true, viewerIsOwner: false, sessionOnly: false, ...handlers });
    const rows = menu.sections.flatMap((section) => section.items);

    expect(rows.map((row) => row.id)).toEqual(['not-interested', 'hide-creator', 'report-content', 'report-user', 'block-user']);
    expect(rows.map((row) => Boolean(row.kind === 'action' && row.destructive)))
      .toEqual(rows.map((row) => isDestructiveViewerAction(row.id)));
    expect(isDestructiveViewerAction('hide-creator')).toBe(false);
  });
});

// One wording for the row that hides a creator, wherever it is drawn. It read
// "Hide fluffy" on Home, "Hide @fluffy" on Explore and "Hide this creator" in
// the reel until 2026-10-09. The web's twin of this rule answers the same
// contract in src/__tests__/hide-creator-label-parity.test.ts.
describe('the Hide row', () => {
  it.each(hideCreatorLabelContract.cases)('words $creator as "$label", as the web does', ({ creator, label }) => {
    expect(hideCreatorLabel(creator)).toBe(label);
  });

  it('names the creator by handle, by display name without one, and never by nothing', () => {
    expect(hideCreatorLabel({ username: 'maya', name: 'Maya R' })).toBe('Hide @maya');
    expect(hideCreatorLabel({ username: ' @maya ', name: 'Maya R' })).toBe('Hide @maya');
    expect(hideCreatorLabel({ username: null, name: ' Maya R ' })).toBe('Hide Maya R');
    expect(hideCreatorLabel({ username: '  ', name: '' })).toBe('Hide this creator');
    expect(hideCreatorLabel({})).toBe('Hide this creator');
  });

  it("reads the same from the label a post's card shows", () => {
    expect(hideCreatorLabelFromCardLabel('@maya')).toBe('Hide @maya');
    expect(hideCreatorLabelFromCardLabel('Maya R')).toBe('Hide Maya R');
    expect(hideCreatorLabelFromCardLabel('@creator')).toBe('Hide this creator');
    expect(hideCreatorLabelFromCardLabel('  ')).toBe('Hide this creator');
  });

  it("is the same row on a feed card's menu and in the reel's, for the same creator", () => {
    const card = buildFeedFeedbackMenu({
      creator: { username: 'maya', name: 'Maya R' },
      canHideCreator: true,
      viewerIsOwner: false,
      sessionOnly: false,
      onNotInterested: noop,
      onHideCreator: noop,
    });
    const reel = buildViewerActionsMenu({
      item: viewerItem({ creatorLabel: '@maya' }),
      actions: ['not-interested', 'hide-creator'],
      onAction: noop,
    });
    const label = (menu: NativeMenuModel) => menu.sections.flatMap((section) => section.items).find((row) => row.id === 'hide-creator')?.label;

    expect(label(card)).toBe('Hide @maya');
    expect(label(reel)).toBe('Hide @maya');
  });
});

describe("whose creator a feed card's menu can act on", () => {
  it('is any account but your own, and a guest has no own', () => {
    expect(canHideFeedCreator('maya', 'me')).toBe(true);
    expect(canHideFeedCreator('maya', undefined)).toBe(true);
    expect(canHideFeedCreator('me', 'me')).toBe(false);
    expect(canHideFeedCreator(null, 'me')).toBe(false);
    expect(canHideFeedCreator(undefined, undefined)).toBe(false);
  });

  it('counts a post as your own only when you are signed in and made it', () => {
    expect(isOwnFeedPost('me', 'me')).toBe(true);
    expect(isOwnFeedPost('maya', 'me')).toBe(false);
    expect(isOwnFeedPost('maya', undefined)).toBe(false);
    expect(isOwnFeedPost(null, 'me')).toBe(false);
    // A guest looking at a post that names no creator: nothing equals nothing,
    // and the post is still not theirs. So is the post a closing sheet has let go.
    expect(isOwnFeedPost(undefined, undefined)).toBe(false);
    expect(isOwnFeedPost(null, null)).toBe(false);
  });

  // The rule is only as good as the two screens that ask it: each builds the
  // menu and its fallback sheet for the post whose ⋮ was pressed.
  it.each(['components/home-dashboard.tsx', 'app/(tabs)/showcase.tsx'])('is asked by %s for the menu and for the sheet', (file) => {
    const source = readFileSync(path.resolve(__dirname, '..', file), 'utf8');

    expect(source).toContain('canHideCreator: canHideFeedCreator(item.creator.id, user?.id),');
    expect(source).toContain('canHideCreator={canHideFeedCreator(feedbackItem?.creator.id, user?.id)}');
    expect(source.match(/canHideCreator[:=]/g)?.length).toBe(2);
    expect(source).toContain('viewerIsOwner: isOwnFeedPost(item.creator.id, user?.id),');
    expect(source).toContain('viewerIsOwner={isOwnFeedPost(feedbackItem?.creator.id, user?.id)}');
    expect(source.match(/viewerIsOwner[:=]/g)?.length).toBe(2);
    // And the Hide row is worded by the one rule, for the menu and for the sheet.
    expect(source).toContain('    creator: item.creator,\n    canHideCreator:');
    expect(source).toContain('hideLabel={hideCreatorLabel(feedbackItem?.creator ?? {})}');
  });
});

// A feed card's ⋮ and the reel's ••• open onto the same post, so whoever is
// looking is offered the same Safety rows by both.
describe('the Safety rows of a post, on its card and in the reel', () => {
  const handlers = { onNotInterested: noop, onHideCreator: noop, onReportContent: noop, onReportUser: noop, onBlockUser: noop };
  const cardSafetyRows = (creatorId: string | null, viewerId: string | undefined) => buildFeedFeedbackMenu({
    creator: {},
    canHideCreator: canHideFeedCreator(creatorId, viewerId),
    viewerIsOwner: isOwnFeedPost(creatorId, viewerId),
    sessionOnly: !viewerId,
    ...handlers,
  }).sections.find((section) => section.id === 'safety')?.items.map((item) => item.id);

  it.each([
    { post: "someone else's", creatorId: 'maya', viewerId: 'me', rows: ['report-content', 'report-user', 'block-user'] },
    { post: "someone else's, seen by a guest", creatorId: 'maya', viewerId: undefined, rows: ['report-content', 'report-user', 'block-user'] },
    { post: 'your own', creatorId: 'me', viewerId: 'me', rows: [] },
    { post: 'one with no creator account', creatorId: null, viewerId: 'me', rows: ['report-content'] },
    { post: 'one with no creator account, seen by a guest', creatorId: null, viewerId: undefined, rows: ['report-content'] },
  ])('are $rows on $post', ({ creatorId, viewerId, rows }) => {
    expect(cardSafetyRows(creatorId, viewerId)).toEqual(rows);
    expect(getViewerSafetyActions({ sourceType: 'showcase', creatorId, generationId: null }, viewerId)).toEqual(rows);
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
