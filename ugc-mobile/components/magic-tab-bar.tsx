import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
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

const VISIBLE_TABS = [
  { route: 'index', label: 'Home', Icon: Home },
  { route: 'showcase', label: 'Feed', Icon: Users },
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
        intensity={38}
        tint="dark"
        style={{
          minHeight: barHeight,
          overflow: 'hidden',
          borderRadius: barHeight / 2,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: 'rgba(168,85,247,0.28)',
          backgroundColor: 'rgba(5,7,20,0.86)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: isCompact ? 6 : 10, paddingVertical: isCompact ? 8 : 10 }}>
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
          opacity: pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
          zIndex: 2,
          elevation: 8,
          boxShadow: '0 16px 38px rgba(168,85,247,0.54)',
        })}
      >
        <LinearGradient
          colors={['#f032d0', '#7c3cff']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ position: 'absolute', inset: 0, zIndex: 0, borderRadius: centerSize / 2 }}
        />
        <View style={{ zIndex: 1 }}>
          <Plus size={isCompact ? 34 : 38} color="#ffffff" strokeWidth={2.4} />
        </View>
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
  const color = active ? '#d946ef' : appTheme.colors.muted;

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minWidth: 0,
        minHeight: iconSize > 22 ? 58 : 54,
        alignItems: 'center',
        justifyContent: 'center',
        gap: iconSize > 22 ? 4 : 3,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Icon size={iconSize} color={color} strokeWidth={active ? 2.7 : 2.1} fill={active ? 'rgba(217,70,239,0.24)' : 'transparent'} />
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.76} style={{ color, fontSize: labelSize, fontWeight: active ? '800' : '600' }}>{item.label}</Text>
    </Pressable>
  );
}
