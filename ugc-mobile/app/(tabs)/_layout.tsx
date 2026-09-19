import { Tabs, useNavigation } from 'expo-router';
import { useEffect } from 'react';
import { Platform, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { MagicTabBar } from '@/components/magic-tab-bar';
import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { zoomUnderlayHidden } from '@/lib/zoom-underlay';

export default function TabLayout() {
  const reducedMotion = useReducedMotion();
  const navigation = useNavigation();
  // Skipped by the renderer while a settled reel covers it (see zoom-underlay),
  // but only the tabs the reel is covering. Tabs opened on top of a reel — a
  // tab route pushed from a screen the reel led to — are the focused screen,
  // and hiding them too would leave that screen blank.
  const covered = useSharedValue(navigation.isFocused() ? 0 : 1);
  useEffect(() => {
    const offFocus = navigation.addListener('focus', () => covered.set(0));
    const offBlur = navigation.addListener('blur', () => covered.set(1));
    return () => {
      offFocus();
      offBlur();
    };
  }, [covered, navigation]);
  const underlayStyle = useAnimatedStyle(() => ({ opacity: 1 - zoomUnderlayHidden.value * covered.value }));

  return (
    <Animated.View style={[styles.fill, underlayStyle]}>
      <Tabs
        backBehavior="history"
        tabBar={(props) => (
          // Keep one stable tab-bar tree across route fades; MagicTabBar owns
          // invisibility and inertness while the focused creator workspace is up.
          <MagicTabBar
            {...props}
            hidden={props.state.routes[props.state.index]?.name === 'creator'}
          />
        )}
        screenOptions={{
          // Android changes content immediately; the custom dock provides the
          // transition feedback without making the page wait for a fade.
          animation: reducedMotion ? 'none' : Platform.OS === 'android' ? 'none' : 'fade',
          headerShown: false,
          headerStyle: { backgroundColor: appTheme.colors.background },
          headerTintColor: appTheme.colors.text,
          sceneStyle: { backgroundColor: appTheme.colors.background },
        }}>
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
          }}
        />
        <Tabs.Screen
          name="creator"
          options={{
            title: 'Create',
          }}
        />
        <Tabs.Screen
          name="studio"
          options={{
            title: 'Alerts',
          }}
        />
        <Tabs.Screen
          name="showcase"
          options={{
            title: 'Explore',
            href: null,
          }}
        />
        <Tabs.Screen
          name="pricing"
          options={{
            title: 'Credits',
            href: null,
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: 'Profile',
          }}
        />
      </Tabs>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
