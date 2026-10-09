/**
 * The menu a ••• button opens, described once and drawn by the platform.
 *
 * On iOS the description becomes a SwiftUI `Menu` (`components/native-menu.ios.tsx`).
 * From iOS 26 that menu grows out of the button that was tapped and shrinks back
 * into it when dismissed — the Liquid Glass morph WhatsApp's ••• shows — and the
 * system draws every frame of it. On Android the app draws it: a rounded panel
 * that grows out of the button, with an icon on every row
 * (`components/native-menu.android.tsx`, which says why Material's dropdown was
 * left). An iOS build without Expo UI's native module, and the test runner, keep
 * the sheet the button opened before (`components/native-menu.tsx`).
 *
 * Pull-down buttons is why: the HIG's More button reveals a menu, and an action
 * sheet is for choices that follow an action (see `lib/action-sheet.ts`). A menu
 * closes the moment a row is chosen, so a destructive row still confirms through
 * `showConfirmDialog` afterwards, as that chapter asks.
 */
import type { ActionSheetRequest } from '@/lib/action-sheet';

export interface NativeMenuAction {
  kind: 'action';
  id: string;
  label: string;
  /** One short line under the label. A menu row has room for no more. */
  subtitle?: string;
  /**
   * SF Symbol for the iOS row. Android draws the Lucide icon that stands for it
   * (`lib/native-menu-icons.ts`), so a row names its icon once.
   */
  systemImage?: string;
  destructive?: boolean;
  disabled?: boolean;
  /**
   * Set on every row of a pick-one list, and true on the current value. iOS
   * draws such rows as toggles, with the checkmark on the leading edge where a
   * pop-up button's menu marks its value; Android marks the current row.
   */
  checked?: boolean;
  onSelect: () => void;
}

export interface NativeMenuSubmenu {
  kind: 'submenu';
  id: string;
  label: string;
  systemImage?: string;
  disabled?: boolean;
  items: NativeMenuAction[];
  /**
   * Android's menu does not nest. When this is set, Android draws the submenu
   * as one row that runs it instead (the picker sheet the row opened before
   * native menus); otherwise the submenu's rows are listed in place.
   */
  onSelectFlat?: () => void;
}

export type NativeMenuItem = NativeMenuAction | NativeMenuSubmenu;

export interface NativeMenuSection {
  id: string;
  /** Drawn on iOS. Android separates sections with a divider only. */
  title?: string;
  items: NativeMenuItem[];
}

export interface NativeMenuModel {
  /**
   * The row of icon buttons across the top of an iOS menu (`ControlGroup`, the
   * row Apple Music and Photos open with). It is for actions the screen already
   * shows — the reel's rail — so they cost the menu one row instead of four.
   * Android draws the same row; the action sheet lists them first, as rows.
   */
  quickActions: NativeMenuAction[];
  sections: NativeMenuSection[];
}

export function menuAction(input: Omit<NativeMenuAction, 'kind'>): NativeMenuAction {
  return { kind: 'action', ...input };
}

export function menuSubmenu(input: Omit<NativeMenuSubmenu, 'kind'>): NativeMenuSubmenu {
  return { kind: 'submenu', ...input };
}

/**
 * Drops sections (and submenus) left with nothing in them, so no empty header
 * or doubled divider is drawn when a caller's conditions leave a group bare.
 */
export function compactNativeMenu(model: NativeMenuModel): NativeMenuModel {
  return {
    quickActions: model.quickActions,
    sections: model.sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => item.kind === 'action' || item.items.length > 0),
      }))
      .filter((section) => section.items.length > 0),
  };
}

export function hasNativeMenuItems(model: NativeMenuModel): boolean {
  const compact = compactNativeMenu(model);
  return compact.quickActions.length > 0 || compact.sections.length > 0;
}

/**
 * The same menu as an action sheet (`lib/action-sheet.ts`), for a build without
 * native menus: every row in order, a submenu as its flat row or its own rows,
 * a subtitle as the row's detail line.
 */
export function actionSheetFromMenu(title: string, model: NativeMenuModel): ActionSheetRequest {
  return {
    title,
    actions: nativeMenuRows(model).flatMap((row) => (row.kind === 'action' ? [{
      label: row.action.label,
      detail: row.action.subtitle,
      destructive: row.action.destructive,
      disabled: row.action.disabled,
      onPress: row.action.onSelect,
    }] : [])),
  };
}

export type NativeMenuRow =
  | { kind: 'divider'; id: string }
  | { kind: 'action'; action: NativeMenuAction };

type NativeMenuRowGroup = { id: string; actions: NativeMenuAction[] };

/** A section as flat rows: a submenu is its one row when it has `onSelectFlat`, and its own rows otherwise. */
function sectionRowGroups(sections: NativeMenuSection[]): NativeMenuRowGroup[] {
  return sections.map((section) => ({
    id: section.id,
    actions: section.items.flatMap((item) => {
      if (item.kind === 'action') return [item];
      if (item.onSelectFlat) {
        return [menuAction({
          id: item.id,
          label: item.label,
          systemImage: item.systemImage,
          disabled: item.disabled,
          onSelect: item.onSelectFlat,
        })];
      }
      return item.disabled ? item.items.map((action) => ({ ...action, disabled: true })) : item.items;
    }),
  }));
}

function rowsWithDividers(groups: NativeMenuRowGroup[]): NativeMenuRow[] {
  return groups.flatMap((group, index) => [
    ...(index > 0 ? [{ kind: 'divider' as const, id: `divider:${group.id}` }] : []),
    ...group.actions.map((action) => ({ kind: 'action' as const, action })),
  ]);
}

/**
 * Every row of a menu in order, for a surface with no icon row (the action
 * sheet): the quick actions first, then each section after a divider.
 */
export function nativeMenuRows(model: NativeMenuModel): NativeMenuRow[] {
  const compact = compactNativeMenu(model);
  return rowsWithDividers([
    ...(compact.quickActions.length ? [{ id: 'quick-actions', actions: compact.quickActions }] : []),
    ...sectionRowGroups(compact.sections),
  ]);
}

/**
 * The rows under Android's icon row: each section after a divider, the quick
 * actions left to the row that draws them (`components/anchored-menu.tsx`).
 */
export function nativeMenuSectionRows(model: NativeMenuModel): NativeMenuRow[] {
  return rowsWithDividers(sectionRowGroups(compactNativeMenu(model).sections));
}
