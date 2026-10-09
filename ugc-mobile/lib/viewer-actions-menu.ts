import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import {
  menuAction,
  menuSubmenu,
  type NativeMenuAction,
  type NativeMenuItem,
  type NativeMenuModel,
  type NativeMenuSection,
} from '@/lib/native-menu';
import type { PostLifecycleVisibility } from '@/lib/post-lifecycle-policy';
import { postVisibilityChoices } from '@/lib/post-visibility-menu';
import { getViewerActionGroupLabel, getViewerActionLabel, isDestructiveViewerAction } from '@/lib/viewer-actions';

/**
 * The actions the reel's rail already shows. The menu opens with them as one
 * row of icons (the owner's call, 2026-09-26) rather than full rows, and keeps
 * them there on the screens that have no rail. The row holds three: iOS moved
 * a fourth (Remix) out of it on its own (simulator, 2026-09-27), so Remix and
 * Unlock lead the first section instead, by choice rather than by overflow.
 */
const QUICK_ACTIONS = new Set(['save', 'unsave', 'comment', 'share']);

/**
 * SF Symbols for the iOS rows, one for each Lucide icon the sheet draws. Android
 * draws that Lucide icon again, looked up by the symbol's name
 * (`lib/native-menu-icons.ts`).
 */
export const VIEWER_ACTION_SYMBOLS: Readonly<Record<string, string>> = {
  save: 'bookmark',
  unsave: 'bookmark.slash',
  comment: 'bubble.right',
  share: 'square.and.arrow.up',
  recreate: 'wand.and.stars',
  'unlock-remix': 'lock',
  publish: 'doc.badge.plus',
  archive: 'archivebox',
  restore: 'tray.and.arrow.up',
  'delete-post': 'trash',
  'edit-post': 'pencil',
  'change-visibility': 'eye',
  'view-linked': 'arrow.up.right.square',
  'edit-linked': 'pencil',
  'edit-linked-resources': 'slider.horizontal.3',
  'change-linked-visibility': 'eye',
  'open-original': 'arrow.up.right.square',
  'view-details': 'info.circle',
  download: 'arrow.down.circle',
  'not-interested': 'eye.slash',
  'hide-creator': 'person.crop.circle.badge.xmark',
  'report-content': 'flag',
  'report-user': 'exclamationmark.shield',
  'block-user': 'nosign',
  'report-ai-output': 'exclamationmark.shield',
};

/**
 * The sheet heads every group. In a menu a heading costs a row, so the catch-all
 * group goes without one; the rest name what sets their rows apart.
 */
const UNTITLED_GROUPS = new Set(['Media actions']);

export interface ViewerActionsMenuInput {
  item: ImmersivePreviewItem;
  /** What the item offers, in order (`useViewerActionHandlers`). */
  actions: string[];
  onAction: (action: string) => void;
  /**
   * The item's own post visibility and how to change it, which turns Change
   * visibility into a submenu of the three choices with the current one
   * checked. Without them it stays a row that opens the picker sheet.
   */
  visibility?: PostLifecycleVisibility;
  onPickVisibility?: (next: PostLifecycleVisibility) => void;
}

/**
 * The menu a viewer item's ••• opens (`lib/native-menu.ts`): the rows of
 * `ViewerActionSheet`, in its groups and order. A disabled row keeps its reason
 * as its one line; the other explanations the sheet gave are left to the rows'
 * names, as a menu has room for.
 */
export function buildViewerActionsMenu({
  item,
  actions,
  onAction,
  visibility,
  onPickVisibility,
}: ViewerActionsMenuInput): NativeMenuModel {
  const unique = Array.from(new Set(actions));

  const toAction = (action: string): NativeMenuAction => {
    const disabledReason = item.disabledActions[action];
    return menuAction({
      id: action,
      label: getViewerActionLabel(action, item.sourceType),
      subtitle: disabledReason,
      systemImage: VIEWER_ACTION_SYMBOLS[action],
      destructive: isDestructiveViewerAction(action),
      disabled: Boolean(disabledReason),
      onSelect: () => onAction(action),
    });
  };

  const toItem = (action: string): NativeMenuItem => {
    if (action === 'change-visibility' && visibility && onPickVisibility && !item.disabledActions[action]) {
      return menuSubmenu({
        id: action,
        label: getViewerActionLabel(action, item.sourceType),
        systemImage: VIEWER_ACTION_SYMBOLS[action],
        items: postVisibilityChoices(visibility, onPickVisibility),
        onSelectFlat: () => onAction(action),
      });
    }
    return toAction(action);
  };

  const sections: NativeMenuSection[] = [];
  for (const action of unique) {
    if (QUICK_ACTIONS.has(action)) continue;
    const group = getViewerActionGroupLabel(action);
    let section = sections.find((candidate) => candidate.id === group);
    if (!section) {
      section = { id: group, title: UNTITLED_GROUPS.has(group) ? undefined : group, items: [] };
      sections.push(section);
    }
    section.items.push(toItem(action));
  }

  return {
    quickActions: unique.filter((action) => QUICK_ACTIONS.has(action)).map(toAction),
    sections,
  };
}
