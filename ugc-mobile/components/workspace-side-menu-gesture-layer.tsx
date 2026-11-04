import { Menu } from 'lucide-react-native';
import type React from 'react';
import { createContext, useContext, useMemo, useRef } from 'react';
import { type GestureResponderEvent, useWindowDimensions, View } from 'react-native';

import { WorkspaceSideMenu } from '@/components/workspace-side-menu';
import { EDGE_SWIPE_START_WIDTH } from '@/lib/edge-swipe-menu';
import { useWorkspaceSideMenuState } from '@/lib/side-menu-host';
import {
  shouldOpenWorkspaceSideMenu,
  shouldTrackWorkspaceSideMenuTouchStart,
  type WorkspaceSideMenuTouchPoint,
} from '@/lib/workspace-side-menu-gesture';

export const DEFAULT_WORKSPACE_SIDE_MENU_EDGE_WIDTH = EDGE_SWIPE_START_WIDTH;

/**
 * The one glyph and the one label for "open the workspace menu", so the screens
 * that offer it cannot drift apart. Sidebars: "Avoid hiding the sidebar by
 * default to ensure that it remains discoverable"; Gestures: "Use shortcut
 * gestures to supplement standard gestures, not replace them ... people also
 * need simple, familiar ways to navigate and perform actions, even if it means
 * an extra tap or two."
 */
export const WorkspaceSideMenuGlyph = Menu;
export const WORKSPACE_SIDE_MENU_LABEL = 'Open menu';

const WorkspaceSideMenuContext = createContext<{ open: () => void } | null>(null);

/**
 * The layer's opener, for a header control inside it. Null when no layer is
 * mounted above — a screen without the menu should render no button for it.
 */
export function useWorkspaceSideMenu() {
  return useContext(WorkspaceSideMenuContext);
}

interface WorkspaceSideMenuGestureLayerProps {
  bottomOffset?: number;
  children?: React.ReactNode;
  edgeWidth?: number;
  enabled?: boolean;
  topOffset?: number;
}

export function WorkspaceSideMenuGestureLayer({
  bottomOffset = 0,
  children,
  edgeWidth = DEFAULT_WORKSPACE_SIDE_MENU_EDGE_WIDTH,
  enabled = true,
  topOffset = 0,
}: WorkspaceSideMenuGestureLayerProps) {
  const { height } = useWindowDimensions();
  // Drawn by the tab bar under the tabs layout, which outlives this tab
  // (lib/side-menu-host.ts); drawn here anywhere else.
  const sideMenu = useWorkspaceSideMenuState();
  const openMenu = sideMenu.open;
  const touchStartRef = useRef<WorkspaceSideMenuTouchPoint | null>(null);

  const handleTouchStart = (event: GestureResponderEvent) => {
    const touch = event.nativeEvent.touches[0];
    const start = touch ? { x: touch.pageX, y: touch.pageY } : null;
    const startsAbovePersistentChrome = !start || start.y <= height - Math.max(0, bottomOffset);
    touchStartRef.current = startsAbovePersistentChrome && shouldTrackWorkspaceSideMenuTouchStart({
      edgeWidth,
      enabled,
      menuVisible: sideMenu.isOpen(),
      start,
      topOffset,
    })
      ? start
      : null;
  };

  const handleTouchEnd = (event: GestureResponderEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const touch = event.nativeEvent.changedTouches[0];
    const end = touch ? { x: touch.pageX, y: touch.pageY } : null;

    if (shouldOpenWorkspaceSideMenu({ edgeWidth, enabled, menuVisible: sideMenu.isOpen(), start, end })) {
      openMenu();
    }
  };

  const handleTouchCancel = () => {
    touchStartRef.current = null;
  };

  const menuApi = useMemo(() => ({ open: openMenu }), [openMenu]);

  return (
    <WorkspaceSideMenuContext.Provider value={menuApi}>
      {children ? (
        <View
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchCancel}
          style={{ flex: 1 }}
        >
          {children}
        </View>
      ) : null}
      {sideMenu.hosted ? null : (
        <WorkspaceSideMenu visible={sideMenu.ownMenuVisible} onClose={sideMenu.close} />
      )}
    </WorkspaceSideMenuContext.Provider>
  );
}
