import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import { type GestureResponderEvent, View } from 'react-native';

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

interface WorkspaceSideMenuGestureLayerProps {
  bottomOffset?: number;
  children?: React.ReactNode;
  edgeWidth?: number;
  enabled?: boolean;
  topOffset?: number;
}

export function WorkspaceSideMenuGestureLayer({
  children,
  edgeWidth = DEFAULT_WORKSPACE_SIDE_MENU_EDGE_WIDTH,
  enabled = true,
  topOffset = 0,
}: WorkspaceSideMenuGestureLayerProps) {
  const { api, credits, signOut, user } = useAuth();
  const [menuVisible, setMenuVisible] = useState(false);
  const touchStartRef = useRef<WorkspaceSideMenuTouchPoint | null>(null);

  const profileQuery = useQuery({
    queryKey: ['workspace-menu-profile', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.getProfile(),
    staleTime: 1000 * 60 * 5,
  });

  const sellerPostsQuery = useQuery({
    queryKey: ['workspace-menu-seller-posts', user?.id],
    enabled: Boolean(user),
    queryFn: () => api.listOwnerPosts({ includeArchived: true, visibility: 'all' }),
    staleTime: 1000 * 60 * 2,
  });

  const salesSummary = useMemo(
    () => getOwnerPostSalesSummary(sellerPostsQuery.data?.posts),
    [sellerPostsQuery.data]
  );

  const handleTouchStart = (event: GestureResponderEvent) => {
    const touch = event.nativeEvent.touches[0];
    const start = touch ? { x: touch.pageX, y: touch.pageY } : null;
    touchStartRef.current = shouldTrackWorkspaceSideMenuTouchStart({
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

  return (
    <>
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
    </>
  );
}
