import { Pressable, View } from 'react-native';

import { AppText, Card } from '@/components/ui';
import {
  AUTOPLAY_PREFERENCES,
  useAutoplayPreference,
  writeAutoplayPreference,
  type AutoplayPreference,
} from '@/lib/autoplay-preference';
import { haptic } from '@/lib/haptics';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

const AUTOPLAY_LABELS: Record<AutoplayPreference, string> = {
  wifi: 'Wi-Fi only',
  always: 'Always',
  never: 'Never',
};

/** What the choice does, so the short label never has to explain itself. */
const AUTOPLAY_BODIES: Record<AutoplayPreference, string> = {
  wifi: 'On mobile data, only the video you stop on plays.',
  always: 'Videos play and load ahead on any network.',
  never: 'Videos show a still frame until you open them.',
};

/**
 * Whether feed previews play by themselves (`lib/autoplay-preference.ts`).
 * Drawn as the Appearance row is: the app's segmented control with radio
 * semantics, because this picks a setting rather than switching a view. Every
 * feed follows the change in the next frame; there is nothing to confirm.
 */
export function AutoplaySetting() {
  const theme = useAppTheme();
  const preference = useAutoplayPreference();

  return (
    <Card style={{ gap: 14 }}>
      <View style={{ gap: 3 }}>
        <AppText variant="cardTitle">Autoplay previews</AppText>
        <AppText variant="bodySm" color="muted">{AUTOPLAY_BODIES[preference]}</AppText>
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Autoplay previews"
        style={{
          flexDirection: 'row',
          gap: 4,
          padding: 4,
          borderRadius: 18,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surfaceInset,
        }}
      >
        {AUTOPLAY_PREFERENCES.map((option) => {
          const active = option === preference;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={AUTOPLAY_LABELS[option]}
              accessibilityState={{ checked: active }}
              onPress={() => {
                if (active) return;
                haptic.select();
                void writeAutoplayPreference(option);
              }}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: appTheme.touch.compact,
                borderRadius: 14,
                borderCurve: 'continuous',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: active ? theme.colors.primaryFill : 'transparent',
                opacity: pressed ? appTheme.opacity.pressed : 1,
              })}
            >
              <AppText
                selectable={false}
                variant="label"
                color={active ? theme.colors.onPrimary : theme.colors.muted}
                numberOfLines={1}
              >
                {AUTOPLAY_LABELS[option]}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}
