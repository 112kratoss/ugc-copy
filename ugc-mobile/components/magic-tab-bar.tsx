import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import { router } from 'expo-router';
import { Bell, Home, Plus, Users, User } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MagicCreateMenu } from '@/components/magic-create-menu';
import { getCreateMenuActionHref, type CreateMenuActionId } from '@/lib/create-menu-view-model';
import { resolvedBottomInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { appTheme } from '@/lib/theme';

const PRIMARY = appTheme.colors.primary ?? '#FF7A59';
const PRIMARY_STRONG = appTheme.colors.primaryStrong ?? '#FF8A6D';
const PRIMARY_PRESSED = appTheme.colors.pressed ?? 'rgba(255,122,89,0.13)';
const ON_PRIMARY = appTheme.colors.onPrimary ?? '#1A0E0A';

const VISIBLE_TABS = [
  { route: 'index', label: 'Home', Icon: Home },
  { route: 'showcase', label: 'Showcase', Icon: Users },
  { route: 'studio', label: 'Alerts', Icon: Bell },
  { route: 'profile', label: 'Profile', Icon: User },
] as const;

export function MagicTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [createMenuVisible, setCreateMenuVisible] = useState(false);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const metrics = getMagicTabBarMetrics(width, bottomInset);
  const activeRoute = state.routes[state.index]?.name;
  const { isCompact, centerSize, barHeight, centerGap, tabIconSize, tabLabelSize } = metrics;

  const navigateTo = (routeName: string) => {
    const event = navigation.emit({
      type: 'tabPress',
      target: state.routes.find((route) => route.name === routeName)?.key,
      canPreventDefault: true,
    });

    if (!event.defaultPrevented) {
      navigation.navigate(routeName);
    }
  };

  const navigateToCreateTab = () => {
    const createRoute = state.routes.find((route) => route.name === 'creator');
    const event = navigation.emit({
      type: 'tabPress',
      target: createRoute?.key,
      canPreventDefault: true,
    });

    if (!event.defaultPrevented) {
      const tabNavigation = navigation as typeof navigation & { jumpTo?: (name: string) => void };
      if (typeof tabNavigation.jumpTo === 'function') {
        tabNavigation.jumpTo('creator');
      } else {
        navigation.navigate('creator');
      }
    }
  };

  const handleCreateMenuAction = (actionId: CreateMenuActionId) => {
    setCreateMenuVisible(false);

    if (actionId === 'create') {
      navigateToCreateTab();
      return;
    }

    router.push(getCreateMenuActionHref('post') as never);
  };

  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        paddingHorizontal: metrics.horizontalPadding,
        paddingBottom: metrics.bottomPadding,
        paddingTop: metrics.topPadding,
      }}
    >
      <MagicCreateMenu
        visible={createMenuVisible}
        onClose={() => setCreateMenuVisible(false)}
        onAction={handleCreateMenuAction}
        horizontalInset={metrics.horizontalPadding}
        bottomInset={metrics.bottomPadding}
      />
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: metrics.bottomInset,
          backgroundColor: 'transparent',
        }}
      />
      <BlurView
        intensity={16}
        tint="dark"
        style={{
          minHeight: barHeight,
          overflow: 'hidden',
          borderRadius: barHeight / 2,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: appTheme.colors.border,
          backgroundColor: 'rgba(17,18,21,0.96)',
          boxShadow: '0 12px 30px rgba(0,0,0,0.34)',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: isCompact ? 6 : 8, paddingVertical: isCompact ? 4 : 6 }}>
          <TabButton item={VISIBLE_TABS[0]} active={activeRoute === 'index'} iconSize={tabIconSize} labelSize={tabLabelSize} onPress={() => navigateTo('index')} />
          <TabButton item={VISIBLE_TABS[1]} active={activeRoute === 'showcase'} iconSize={tabIconSize} labelSize={tabLabelSize} onPress={() => navigateTo('showcase')} />
          <View style={{ width: centerGap, flexShrink: 0 }} />
          <TabButton item={VISIBLE_TABS[2]} active={activeRoute === 'studio'} iconSize={tabIconSize} labelSize={tabLabelSize} onPress={() => navigateTo('studio')} />
          <TabButton item={VISIBLE_TABS[3]} active={activeRoute === 'profile'} iconSize={tabIconSize} labelSize={tabLabelSize} onPress={() => navigateTo('profile')} />
        </View>
      </BlurView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open create menu"
        accessibilityHint="Choose whether to create media or publish a post"
        accessibilityState={{ expanded: createMenuVisible }}
        onPress={() => setCreateMenuVisible(true)}
        style={({ pressed }) => ({
          position: 'absolute',
          top: 0,
          alignSelf: 'center',
          width: centerSize,
          height: centerSize,
          borderRadius: centerSize / 2,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          borderWidth: 2,
          borderColor: appTheme.colors.panel,
          backgroundColor: pressed ? PRIMARY_STRONG : PRIMARY,
          opacity: pressed ? 0.85 : 1,
          zIndex: 2,
          elevation: 5,
          boxShadow: '0 8px 20px rgba(0,0,0,0.36)',
        })}
      >
        <Plus size={isCompact ? 23 : 25} color={ON_PRIMARY} strokeWidth={2.7} />
        <Text style={{ color: ON_PRIMARY, fontSize: 9, lineHeight: 11, fontWeight: '800' }}>Create</Text>
      </Pressable>
    </View>
  );
}

function TabButton({
  item,
  active,
  iconSize,
  labelSize,
  onPress,
}: {
  item: (typeof VISIBLE_TABS)[number];
  active: boolean;
  iconSize: number;
  labelSize: number;
  onPress: () => void;
}) {
  const Icon = item.Icon;
  const color = active ? PRIMARY : appTheme.colors.muted;

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        position: 'relative',
        flex: 1,
        minWidth: 0,
        minHeight: 52,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        borderRadius: 18,
        borderCurve: 'continuous',
        backgroundColor: active ? PRIMARY_PRESSED : pressed ? appTheme.colors.surfaceStrong : 'transparent',
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {active ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 2,
            width: 18,
            height: 3,
            borderRadius: 2,
            backgroundColor: PRIMARY,
          }}
        />
      ) : null}
      <Icon size={iconSize} color={color} strokeWidth={active ? 2.5 : 2.1} />
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.76} style={{ color, fontSize: labelSize, fontWeight: active ? '800' : '600' }}>{item.label}</Text>
    </Pressable>
  );
}
