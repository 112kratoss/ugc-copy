import { Mail, MessageCircle, ShieldCheck } from 'lucide-react-native';
import { Linking, Pressable, View } from 'react-native';

import { AppText, Card, Screen, SectionTitle } from '@/components/ui';
import { appTheme } from '@/lib/theme';

export default function HelpScreen() {
  return (
    <Screen>
      <SectionTitle
        eyebrow="Help & Support"
        title="We can help."
        body="Find quick guidance for credits, publishing, unlocks, and account support."
      />

      <HelpCard
        icon={<MessageCircle size={22} color={appTheme.colors.primary} />}
        title="Creation help"
        body="If a generation is processing, you can leave the screen and watch for the mobile notification when it finishes."
      />
      <HelpCard
        icon={<ShieldCheck size={22} color="#22d3ee" />}
        title="Unlocks and sales"
        body="Reusable resources appear after the public post and listing details pass the quality checks."
      />
      <HelpCard
        icon={<Mail size={22} color="#fbbf24" />}
        title="Contact support"
        body="Email info@magicbooklet.com for account or purchase help."
        onPress={() => void Linking.openURL('mailto:info@magicbooklet.com?subject=Magicbooklet%20app%20support')}
      />
    </Screen>
  );
}

function HelpCard({ icon, title, body, onPress }: { icon: React.ReactNode; title: string; body: string; onPress?: () => void }) {
  const content = (
    <Card style={{ minHeight: 112 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: appTheme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </View>
        <View style={{ flex: 1, gap: 5 }}>
          <AppText variant="cardTitle">{title}</AppText>
          <AppText variant="bodySm" color="muted">{body}</AppText>
        </View>
      </View>
    </Card>
  );

  if (!onPress) return content;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${title}. ${body}`} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}>
      {content}
    </Pressable>
  );
}
