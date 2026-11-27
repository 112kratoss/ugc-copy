import { Stack } from 'expo-router';

import { screenErrorLayout } from '@/components/app-error-boundary';

export default function ShowcaseLayout() {
  return <Stack screenLayout={screenErrorLayout} screenOptions={{ headerShown: false }} />;
}
