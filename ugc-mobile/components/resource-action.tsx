import { Check } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { appTheme } from '@/lib/theme';

/** How long a completed action keeps saying so before the pill reads as itself again. */
const CONFIRM_MS = 1800;

/**
 * The one small bordered pill for "do something with this text or file".
 *
 * `confirmLabel` is how a press that leaves no trace on screen proves it
 * happened: copying used to fire a haptic and change nothing, which HIG
 * Feedback rules out for anyone who has silenced the phone, looked away, or is
 * listening to VoiceOver. The pill wears the result for a moment instead.
 */
export function ResourceAction({
  confirmLabel,
  icon,
  label,
  onPress,
}: {
  confirmLabel?: string;
  icon: React.ReactNode;
  label: string;
  onPress: () => Promise<void> | void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  const press = async () => {
    await onPress();
    if (!confirmLabel) return;
    setConfirmed(true);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmed(false), CONFIRM_MS);
  };

  const showConfirmed = Boolean(confirmLabel) && confirmed;

  return (
    <Pressable
      accessibilityLabel={showConfirmed ? confirmLabel : label}
      accessibilityRole="button"
      onPress={() => void press()}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: showConfirmed ? appTheme.semantic.success.border : appTheme.colors.border,
        backgroundColor: showConfirmed ? appTheme.semantic.success.background : appTheme.colors.surface,
        opacity: pressed ? appTheme.opacity.pressed : 1,
        paddingHorizontal: 12,
      })}
    >
      {showConfirmed ? <Check size={appTheme.icon.xs} color={appTheme.colors.success} /> : icon}
      <Text style={{ color: appTheme.colors.text, ...appTheme.type.caption, fontWeight: '800' }}>
        {showConfirmed ? confirmLabel : label}
      </Text>
    </Pressable>
  );
}

