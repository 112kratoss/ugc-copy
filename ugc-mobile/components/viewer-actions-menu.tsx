/**
 * The viewer's ••• as a native menu (`lib/native-menu.ts`): the reel's rail, a
 * post's details page, the text post page and the profile's own cards all open
 * the same actions for their item, which `ViewerActionSheet` draws where native
 * menus are missing.
 *
 * The menu has to be built where its button is — a native menu grows out of
 * the button that owns it, and cannot be opened from elsewhere — but the
 * screen owns half of every action (opening comments, leaving the reel after a
 * delete). So the screen provides that half for any item, and each button asks
 * for its own item's, without it being threaded through every slide component.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';

import { NativeMenu, type NativeMenuProps } from '@/components/native-menu';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import { useViewerActionHandlers, type ViewerActionCallbacks } from '@/lib/use-viewer-action-handlers';
import { buildViewerActionsMenu } from '@/lib/viewer-actions-menu';

type CallbacksFor = (item: ImmersivePreviewItem) => ViewerActionCallbacks;

const ViewerActionsMenuContext = createContext<CallbacksFor | null>(null);

/** Gives every viewer ••• below it the screen's side of its item's actions. */
export function ViewerActionsMenuProvider({ callbacksFor, children }: { callbacksFor: CallbacksFor; children: ReactNode }) {
  return <ViewerActionsMenuContext.Provider value={callbacksFor}>{children}</ViewerActionsMenuContext.Provider>;
}

type ViewerActionsMenuProps = Omit<NativeMenuProps, 'model'> & {
  item: ImmersivePreviewItem;
  /**
   * False draws the plain button, whose press opens the sheet. The reel keeps
   * its neighbouring slides that way, so a swipe does not build a native menu
   * for a slide nobody can tap yet.
   */
  enabled?: boolean;
};

export function ViewerActionsMenu({ item, enabled = true, ...menu }: ViewerActionsMenuProps) {
  const callbacksFor = useContext(ViewerActionsMenuContext);
  if (!callbacksFor || !enabled) {
    return <View style={menu.style}>{menu.renderButton(menu.onFallbackPress)}</View>;
  }
  return <ItemActionsMenu item={item} callbacks={callbacksFor(item)} {...menu} />;
}

function ItemActionsMenu({
  item,
  callbacks,
  ...menu
}: Omit<NativeMenuProps, 'model'> & { item: ImmersivePreviewItem; callbacks: ViewerActionCallbacks }) {
  const { actions, handleAction, lifecyclePost, updateVisibility } = useViewerActionHandlers({ item, ...callbacks });
  const model = buildViewerActionsMenu({
    item,
    actions,
    onAction: handleAction,
    visibility: lifecyclePost.visibility,
    onPickVisibility: (next) => void updateVisibility(lifecyclePost, next),
  });
  return <NativeMenu model={model} {...menu} />;
}
