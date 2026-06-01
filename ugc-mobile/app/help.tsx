import { Mail, MessageCircle, ShieldCheck } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { Card, Screen, SectionTitle } from '@/components/ui';
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
        icon={<MessageCircle size={22} color="#d946ef" />}
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
        body="For account or purchase issues, share your Magic Booklet email and the action you were trying to complete."
      />
    </Screen>
  );
}

function HelpCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.07)', alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </View>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={{ color: appTheme.colors.text, fontSize: 18, fontWeight: '900' }}>{title}</Text>
          <Text style={{ color: appTheme.colors.muted, lineHeight: 21 }}>{body}</Text>
        </View>
      </View>
    </Card>
  );
}
