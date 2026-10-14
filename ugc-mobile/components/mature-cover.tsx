import { EyeOff } from 'lucide-react-native';
import { Platform, Pressable, View } from 'react-native';

import { AppText, SecondaryButton } from '@/components/ui';
import { canRevealNsfwInApp } from '@/lib/nsfw-reveal-policy';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

/**
 * What a mature post's picture is drawn as until the viewer asks for it: a
 * list tile (filling the box the thumbnail would), or the 4:5 card a cover
 * fills, so nothing around it moves when the picture takes its place.
 *
 * The purchase is the entitlement and the tap is the consent, so Show draws
 * the picture in place without asking the server. Android never shows one
 * (`canRevealNsfwInApp`): there the plate says what it covers and offers
 * nothing. Nothing under the plate is loaded until it goes.
 */
export function MatureCover({ variant, onShow }: { variant: 'tile' | 'card'; onShow: () => void }) {
  const theme = useAppTheme();
  const canShow = canRevealNsfwInApp(Platform.OS);

  if (variant === 'tile') {
    const plate = {
      position: 'absolute' as const,
      inset: 0,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      gap: 2,
      backgroundColor: theme.colors.surfaceInset,
    };
    if (!canShow) {
      return (
        <View style={plate}>
          <EyeOff size={appTheme.icon.sm} color={theme.colors.muted} />
        </View>
      );
    }
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show mature content"
        onPress={onShow}
        style={({ pressed }) => ({ ...plate, opacity: pressed ? appTheme.opacity.pressed : 1 })}
      >
        <EyeOff size={appTheme.icon.xs} color={theme.colors.muted} />
        <AppText selectable={false} variant="caption" color="text">Show</AppText>
      </Pressable>
    );
  }

  return (
    <View
      style={{
        width: '100%',
        aspectRatio: 4 / 5,
        borderRadius: appTheme.radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surfaceInset,
        alignItems: 'center',
        justifyContent: 'center',
        gap: appTheme.spacing.gap,
        padding: appTheme.spacing.panel,
      }}
    >
      <EyeOff size={appTheme.icon.hero} color={theme.colors.muted} />
      <AppText variant="cardTitle" color="text">Mature content</AppText>
      <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
        {canShow
          ? 'The creator marked this post NSFW. It stays covered until you choose to see it.'
          : 'The creator marked this post NSFW. Mature posts stay covered in this app.'}
      </AppText>
      {canShow ? (
        <SecondaryButton label="Show" accessibilityHint="Shows this post's media here" onPress={onShow} />
      ) : null}
    </View>
  );
}
