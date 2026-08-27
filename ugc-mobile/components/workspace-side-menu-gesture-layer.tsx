import { useQuery } from '@tanstack/react-query';
import { Menu } from 'lucide-react-native';
import type React from 'react';
import { createContext, useContext, useMemo, useRef, useState } from 'react';
import { type GestureResponderEvent, useWindowDimensions, View } from 'react-native';

import { HomeSideMenu } from '@/components/home-side-menu';
import { useAuth } from '@/lib/auth';
import { EDGE_SWIPE_START_WIDTH } from '@/lib/edge-swipe-menu';
import { getOwnerPostSalesSummary } from '@/lib/home-view-model';
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
  const { api, credits, signOut, user } = useAuth();
  const [menuVisible, setMenuVisible] = useState(false);
  const touchStartRef = useRef<WorkspaceSideMenuTouchPoint | null>(null);

  const profileQuery = useQuery({
    queryKey: ['profile', user?.id],
    enabled: Boolean(user && menuVisible),
    queryFn: () => api.getProfile(),
    staleTime: 1000 * 60 * 5,
  });

  const sellerPostsQuery = useQuery({
    queryKey: ['owner-posts-sales-summary', user?.id],
    enabled: Boolean(user && menuVisible),
    queryFn: () => api.listOwnerPosts({ includeArchived: true, includeSummary: true, limit: 1, visibility: 'all' }),
    staleTime: 1000 * 60 * 2,
  });

  const salesSummary = useMemo(
    () => sellerPostsQuery.data?.summary ?? getOwnerPostSalesSummary(sellerPostsQuery.data?.posts),
    [sellerPostsQuery.data]
  );

  const handleTouchStart = (event: GestureResponderEvent) => {
    const touch = event.nativeEvent.touches[0];
    const start = touch ? { x: touch.pageX, y: touch.pageY } : null;
    const startsAbovePersistentChrome = !start || start.y <= height - Math.max(0, bottomOffset);
    touchStartRef.current = startsAbovePersistentChrome && shouldTrackWorkspaceSideMenuTouchStart({
      edgeWidth,
      enabled,
      menuVisible,
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

    if (shouldOpenWorkspaceSideMenu({ edgeWidth, enabled, menuVisible, start, end })) {
      setMenuVisible(true);
    }
  };

  const handleTouchCancel = () => {
    touchStartRef.current = null;
  };

  const menuApi = useMemo(() => ({ open: () => setMenuVisible(true) }), []);

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
      <HomeSideMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        user={user}
        profile={profileQuery.data}
        credits={credits ?? 0}
        totalSalesUsdCents={salesSummary.earningsUsdCents}
        totalSalesLoading={Boolean(user) && sellerPostsQuery.isLoading}
        onSignOut={signOut}
      />
    </WorkspaceSideMenuContext.Provider>
  );
}
