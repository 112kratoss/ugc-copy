import { Link, Stack } from 'expo-router';
import { Pressable } from 'react-native';

import { AppText, Card, Screen, SectionTitle } from '@/components/ui';
import { appTheme } from '@/lib/theme';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not Found' }} />
      <Screen>
        <SectionTitle eyebrow="404" title="That screen is not here." body="Jump back to the creator launchpad and keep moving." />
        <Link href="/creator" asChild>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => ({
              opacity: pressed ? appTheme.opacity.pressed : 1,
            })}
          >
            <Card accent="motion">
              <AppText variant="cardTitle">Go to Create</AppText>
            </Card>
          </Pressable>
        </Link>
      </Screen>
    </>
  );
}
