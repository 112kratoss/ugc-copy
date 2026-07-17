import { Tabs } from 'expo-router';

import { MagicTabBar } from '@/components/magic-tab-bar';
import { useReducedMotion } from '@/lib/motion';
import { appTheme } from '@/lib/theme';

export default function TabLayout() {
  const reducedMotion = useReducedMotion();

  return (
    <Tabs
      backBehavior="history"
      tabBar={(props) => <MagicTabBar {...props} />}
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
  );
}
