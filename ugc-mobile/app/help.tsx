import { useSyncExternalStore } from 'react';
import { ArrowUpRight, Mail, MessageCircle, ShieldCheck } from 'lucide-react-native';
import { Linking, Pressable, View } from 'react-native';

import { AppText, Card, Screen, SectionTitle } from '@/components/ui';
import { formatAppVersionLabel, readAppVersionParts, readUpdateRuntime } from '@/lib/app-version-label';
import { formatSupportDetails, readCreatorSession, subscribeCreatorSession } from '@/lib/creator-session-diagnostics';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

const SUPPORT_EMAIL = 'info@magicbooklet.com';

/**
 * The support mail, with the lines at the foot of Settings below room for the
 * message: which build, update and runtime this phone runs, which support
 * otherwise has to ask for before it can answer.
 */
function supportMailUrl(details: Array<string | null>) {
  const lines = details.filter((line): line is string => Boolean(line));
  const body = lines.length > 0 ? `&body=${encodeURIComponent(`\n\n${lines.join('\n')}`)}` : '';
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Magicbooklet app support')}${body}`;
}

export default function HelpScreen() {
  const theme = useAppTheme();
  const creatorSession = useSyncExternalStore(subscribeCreatorSession, readCreatorSession, readCreatorSession);
  const mailUrl = supportMailUrl([
    formatAppVersionLabel(readAppVersionParts()),
    formatSupportDetails({ ...readUpdateRuntime(), session: creatorSession }),
  ]);

  return (
    <Screen>
      <SectionTitle
        eyebrow="Help & Support"
        title="We can help."
        body="Find quick guidance for creations, unlocks, and contacting support."
      />

      <HelpCard
        icon={<MessageCircle size={appTheme.icon.feature} color={theme.colors.primary} />}
        title="Creation help"
        body="If a generation is processing, you can leave the screen and watch for the mobile notification when it finishes."
      />
      <HelpCard
        icon={<ShieldCheck size={appTheme.icon.feature} color={theme.colors.info} />}
        title="Unlocks and sales"
        body="Reusable resources appear after the public post and listing details pass the quality checks."
      />
      <HelpCard
        icon={<Mail size={appTheme.icon.feature} color={theme.colors.amber} />}
        title="Contact support"
        body={`Email ${SUPPORT_EMAIL} for account or purchase help.`}
        onPress={() => void Linking.openURL(mailUrl)}
      />
    </Screen>
  );
}

function HelpCard({ icon, title, body, onPress }: { icon: React.ReactNode; title: string; body: string; onPress?: () => void }) {
  const theme = useAppTheme();
  const content = (
    <Card style={{ minHeight: 112 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </View>
        <View style={{ flex: 1, gap: 5 }}>
          <AppText variant="cardTitle">{title}</AppText>
          <AppText variant="bodySm" color="muted">{body}</AppText>
        </View>
        {onPress ? <ArrowUpRight size={appTheme.icon.default} color={theme.colors.faint} /> : null}
      </View>
    </Card>
  );

  if (!onPress) return content;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${title}. ${body}`} accessibilityHint="Opens your email app." onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}>
      {content}
    </Pressable>
  );
}
