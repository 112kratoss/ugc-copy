import { router } from 'expo-router';
import { ShieldCheck } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Linking, View } from 'react-native';

import { AppText, Card, PrimaryButton, Screen, SecondaryButton, SectionTitle } from '@/components/ui';
import {
  CONTENT_POLICY_ACCEPTANCE,
  CONTENT_POLICY_ENFORCEMENT,
  CONTENT_POLICY_INTRO,
  CONTENT_POLICY_RULES,
  CONTENT_POLICY_TITLE,
  acceptContentPolicy,
  useContentPolicy,
} from '@/lib/content-policy';
import { env } from '@/lib/env';
import { haptic } from '@/lib/haptics';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

function leaveCreation() {
  if (router.canGoBack()) router.back();
  else router.replace('/(tabs)' as never);
}

/**
 * Shows the community rules (`lib/content-policy.ts`) in place of a creation
 * screen until they are accepted on this phone. The screen behind it does not
 * mount until then, so none of its loading or drafting starts for someone who
 * turns back.
 */
export function ContentPolicyGate({
  children,
  chrome = 'header',
  onDecline = leaveCreation,
}: {
  children: ReactNode;
  /**
   * What surrounds the screen it stands in for: the Create tab, a stack screen
   * without a header (a creation tool, the post composer), or one with the
   * navigator's header (a template). Decides which insets the rules clear.
   */
  chrome?: 'tab' | 'headerless' | 'header';
  onDecline?: () => void;
}) {
  const theme = useAppTheme();
  const policy = useContentPolicy();

  // Read at launch in the root layout, so this is a frame at most. Waiting
  // keeps someone who already agreed from seeing the rules flash past.
  if (!policy.hydrated) return null;
  if (policy.acceptedAt) return <>{children}</>;

  return (
    <Screen insideTab={chrome === 'tab'} safeTop={chrome === 'headerless'}>
      <SectionTitle eyebrow="Community rules" title={CONTENT_POLICY_TITLE} body={CONTENT_POLICY_INTRO} />

      <Card style={{ gap: 14 }}>
        {CONTENT_POLICY_RULES.map((rule) => (
          <View key={rule} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <ShieldCheck size={appTheme.icon.compact} color={theme.colors.primary} />
            <AppText variant="body" style={{ flex: 1 }}>{rule}</AppText>
          </View>
        ))}
      </Card>

      <AppText variant="bodySm" color="muted">{CONTENT_POLICY_ENFORCEMENT}</AppText>
      <SecondaryButton
        label="Read the Terms of Service"
        onPress={() => void Linking.openURL(`${env.siteUrl}/terms`)}
      />

      <AppText variant="bodySm" color="muted">{CONTENT_POLICY_ACCEPTANCE}</AppText>
      <PrimaryButton
        label="I agree"
        onPress={() => {
          haptic.light();
          void acceptContentPolicy();
        }}
      />
      <SecondaryButton label="Not now" onPress={onDecline} />
    </Screen>
  );
}
