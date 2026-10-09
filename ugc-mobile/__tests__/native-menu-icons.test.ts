import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { buildCommentMenu } from '../lib/comment-menu';
import { buildFeedFeedbackMenu } from '../lib/feed-feedback-menu';
import type { NativeMenuModel } from '../lib/native-menu';
import { NATIVE_MENU_ICONS, nativeMenuIcon } from '../lib/native-menu-icons';
import { VIEWER_ACTION_SYMBOLS } from '../lib/viewer-actions-menu';

const noop = () => undefined;

function symbolsIn(model: NativeMenuModel): string[] {
  return [
    ...model.quickActions,
    ...model.sections.flatMap((section) => section.items.flatMap((item) => (
      item.kind === 'submenu' ? [item, ...item.items] : [item]
    ))),
  ].flatMap((item) => (item.systemImage ? [item.systemImage] : []));
}

/** Every SF Symbol a menu hands iOS: the viewer's table, and the rows the feed and comment menus build. */
const namedSymbols = new Set([
  ...Object.values(VIEWER_ACTION_SYMBOLS),
  ...symbolsIn(buildFeedFeedbackMenu({
    creatorLabel: '@creator',
    hideCreatorDisabled: false,
    sessionOnly: false,
    onNotInterested: noop,
    onHideCreator: noop,
    onReportContent: noop,
    onReportUser: noop,
    onBlockUser: noop,
  })),
  ...symbolsIn(buildCommentMenu({
    canDelete: true,
    canRemove: true,
    canReport: true,
    onDelete: noop,
    onRemove: noop,
    onReport: noop,
  })),
]);

describe("the icons Android's menu draws", () => {
  it('has one for every symbol a menu row names, so no row reaches Android bare', () => {
    expect(namedSymbols.size).toBeGreaterThan(15);
    expect([...namedSymbols].filter((symbol) => !nativeMenuIcon(symbol))).toEqual([]);
  });

  it('keeps none for a symbol no menu names any more', () => {
    expect(Object.keys(NATIVE_MENU_ICONS).filter((symbol) => !namedSymbols.has(symbol))).toEqual([]);
  });

  it('draws nothing for a row with no symbol, or one it does not know', () => {
    expect(nativeMenuIcon(undefined)).toBeUndefined();
    expect(nativeMenuIcon('sparkles.tv')).toBeUndefined();
  });
});
