import { Link, Stack } from 'expo-router';
import { Pressable, Text } from 'react-native';

import { Card, Screen, SectionTitle } from '@/components/ui';
import { appTheme } from '@/lib/theme';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <Screen>
        <SectionTitle eyebrow="404" title="That screen is not here." body="Jump back to the creator launchpad and keep moving." />
        <Link href="/creator" asChild>
          <Pressable
            style={({ pressed }) => ({
              opacity: pressed ? 0.82 : 1,
            })}
          >
            <Card accent="motion">
              <Text style={{ color: appTheme.colors.text, fontSize: 17, fontWeight: '800' }}>Go to Create</Text>
            </Card>
          </Pressable>
        </Link>
      </Screen>
    </>
  );
}
