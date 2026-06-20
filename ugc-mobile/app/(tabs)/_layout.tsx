import { Tabs } from 'expo-router';

import { MagicTabBar } from '@/components/magic-tab-bar';
import { appTheme } from '@/lib/theme';

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <MagicTabBar {...props} />}
      screenOptions={{
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
          title: 'Notifications',
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
