import { ArrowUpRight, Mail, MessageCircle, ShieldCheck } from 'lucide-react-native';
import { Linking, Pressable, View } from 'react-native';

import { AppText, Card, Screen, SectionTitle } from '@/components/ui';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

export default function HelpScreen() {
  const theme = useAppTheme();
  return (
    <Screen>
      <SectionTitle
        eyebrow="Help & Support"
        title="We can help."
        body="Find quick guidance for credits, publishing, unlocks, and account support."
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
        body="Email info@magicbooklet.com for account or purchase help."
        onPress={() => void Linking.openURL('mailto:info@magicbooklet.com?subject=Magicbooklet%20app%20support')}
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
