import { BlurTargetView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { useRef } from 'react';
import type { View } from 'react-native';

import { MagicTabBar } from '@/components/magic-tab-bar';
import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

export default function TabLayout() {
  const reducedMotion = useReducedMotion();
  // Android's blur has to be told what to sample; it renders nothing without a
  // target. Everywhere else BlurTargetView is a plain View, so wrapping the
  // navigator costs nothing off-Android.
  const blurTarget = useRef<View>(null);

  return (
    <BlurTargetView ref={blurTarget} style={{ flex: 1 }}>
    <Tabs
      backBehavior="history"
      tabBar={(props) => (
        props.state.routes[props.state.index]?.name === 'creator'
          ? null
          : <MagicTabBar {...props} blurTarget={blurTarget} />
      )}
      screenOptions={{
        animation: reducedMotion ? 'none' : 'fade',
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
          title: 'Showcase',
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
    </BlurTargetView>
  );
}
