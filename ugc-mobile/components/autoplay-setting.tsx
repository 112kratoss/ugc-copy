import { View } from 'react-native';

import { AppText, Card, SegmentedControl } from '@/components/ui';
import {
  AUTOPLAY_PREFERENCES,
  useAutoplayPreference,
  writeAutoplayPreference,
  type AutoplayPreference,
} from '@/lib/autoplay-preference';

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

const AUTOPLAY_OPTIONS = AUTOPLAY_PREFERENCES.map((option) => ({ value: option, label: AUTOPLAY_LABELS[option] }));

/**
 * Whether feed previews play by themselves (`lib/autoplay-preference.ts`).
 * Drawn as the Appearance row is: the app's segmented control with radio
 * semantics, because this picks a setting rather than switching a view. Every
 * feed follows the change in the next frame; there is nothing to confirm.
 */
export function AutoplaySetting() {
  const preference = useAutoplayPreference();

  return (
    <Card style={{ gap: 14 }}>
      <View style={{ gap: 3 }}>
        <AppText variant="cardTitle">Autoplay previews</AppText>
        <AppText variant="bodySm" color="muted">{AUTOPLAY_BODIES[preference]}</AppText>
      </View>
      <SegmentedControl
        accessibilityLabel="Autoplay previews"
        options={AUTOPLAY_OPTIONS}
        value={preference}
        onChange={(option) => void writeAutoplayPreference(option)}
      />
    </Card>
  );
}
