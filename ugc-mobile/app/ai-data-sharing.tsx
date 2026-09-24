import { ArrowUpRight, Building2, Send, ShieldCheck } from 'lucide-react-native';
import { Linking, Pressable, View } from 'react-native';

import { AppText, Card, PrimaryButton, Screen, SecondaryButton, SectionTitle } from '@/components/ui';
import {
  AI_DATA_RECIPIENTS,
  AI_DATA_SHARED_ITEMS,
  AI_DATA_USE,
  formatAiDataConsentDate,
  grantAiDataConsent,
  useAiDataConsent,
  withdrawAiDataConsent,
} from '@/lib/ai-data-consent';
import { env } from '@/lib/env';
import { haptic } from '@/lib/haptics';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * Settings → AI data sharing. The create screen asks the first time a prompt or
 * media would leave the phone (`ensureAiDataConsent`); this screen says the same
 * things at more length, shows the answer, and changes it.
 */
export default function AiDataSharingScreen() {
  const theme = useAppTheme();
  const consent = useAiDataConsent();
  const grantedOn = consent.grantedAt ? formatAiDataConsentDate(consent.grantedAt) : '';

  return (
    <Screen>
      <SectionTitle
        eyebrow="Privacy"
        title="AI data sharing."
        body="What Magicbooklet sends to AI services to make your images and videos, and your choice about it."
      />

      <InfoCard
        icon={<Send size={appTheme.icon.feature} color={theme.colors.primary} />}
        title="What is sent"
        body={AI_DATA_SHARED_ITEMS}
      />
      <InfoCard
        icon={<Building2 size={appTheme.icon.feature} color={theme.colors.info} />}
        title="Who receives it"
        body={AI_DATA_RECIPIENTS}
      />
      <InfoCard
        icon={<ShieldCheck size={appTheme.icon.feature} color={theme.colors.success} />}
        title="What it is used for"
        body={AI_DATA_USE}
      />

      <Card style={{ gap: 14 }}>
        <View style={{ gap: 3 }}>
          <AppText variant="cardTitle">{consent.grantedAt ? 'Allowed' : 'Not allowed'}</AppText>
          <AppText variant="bodySm" color="muted">
            {consent.grantedAt
              ? `${grantedOn ? `You allowed this on ${grantedOn}. ` : ''}If you withdraw, nothing more is sent, and you’ll be asked again the next time you create.`
              : 'Nothing is sent until you allow it. You’ll be asked the first time you create.'}
          </AppText>
        </View>
        {consent.grantedAt ? (
          <SecondaryButton
            label="Withdraw permission"
            onPress={() => {
              haptic.select();
              void withdrawAiDataConsent();
            }}
          />
        ) : (
          <PrimaryButton
            label="Allow"
            disabled={!consent.hydrated}
            onPress={() => {
              haptic.select();
              void grantAiDataConsent();
            }}
          />
        )}
      </Card>

      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Privacy policy. Every model and its maker, and how long data is kept."
        accessibilityHint="Opens in your browser."
        onPress={() => void Linking.openURL(`${env.siteUrl}/privacy#ai-processing`)}
        style={({ pressed }) => ({ opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <Card style={{ minHeight: 92, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <View style={{ flex: 1, gap: 3 }}>
            <AppText variant="cardTitle">Privacy policy</AppText>
            <AppText variant="bodySm" color="muted">Every model and its maker, and how long data is kept.</AppText>
          </View>
          <ArrowUpRight size={appTheme.icon.default} color={theme.colors.faint} />
        </Card>
      </Pressable>
    </Screen>
  );
}

function InfoCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  const theme = useAppTheme();
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </View>
        <View style={{ flex: 1, gap: 5 }}>
          <AppText variant="cardTitle">{title}</AppText>
          <AppText variant="bodySm" color="muted">{body}</AppText>
        </View>
      </View>
    </Card>
  );
}
