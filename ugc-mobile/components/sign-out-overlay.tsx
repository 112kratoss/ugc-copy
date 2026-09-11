import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, View } from 'react-native';

import { Overlay } from '@/components/overlay-host';
import { AppText } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { MotionView, useOverlayPresence } from '@/lib/motion';
import { appTheme } from '@/lib/theme';
import { useHardwareBack } from '@/lib/use-hardware-back';

/**
 * How long the cover stays up at the least, counted from the tap. A fast
 * network finishes a sign-out in a few hundred milliseconds, and a cover that
 * appears and vanishes that quickly reads as a flicker rather than as progress.
 */
export const SIGN_OUT_COVER_MIN_VISIBLE_MS = 1000;

/**
 * The app-wide cover shown while a sign-out runs.
 *
 * Signing out waits on the network twice, for push unregistration and then the
 * Supabase logout. A progress state inside the side menu's button went unnoticed
 * at that speed, so this dims the whole app from the tap until the sign-in
 * screen is in place underneath it.
 *
 * It renders at the root through `OverlayHost`, not inside the side menu. A
 * sign-out ends by replacing the screen the menu belongs to, so a cover mounted
 * there would vanish with that screen and flash the signed-out home on its way
 * to the sign-in screen.
 */
export function SignOutOverlay() {
  const { isSigningOut } = useAuth();
  return <SignOutCover active={isSigningOut} />;
}

export function SignOutCover({ active }: { active: boolean }) {
  const shown = useMinimumVisibility(active, SIGN_OUT_COVER_MIN_VISIBLE_MS);
  const { mounted, animatedStyle } = useOverlayPresence(shown);

  // Claimed and ignored: back has nowhere safe to go mid sign-out. The screen
  // underneath is about to be replaced, and leaving it would race that
  // navigation.
  useHardwareBack(shown, () => undefined);

  useEffect(() => {
    if (shown) AccessibilityInfo.announceForAccessibility?.('Signing out');
  }, [shown]);

  if (!mounted) return null;

  return (
    <Overlay visible>
      <MotionView
        // Takes every touch while it is up, and none once it starts to fade.
        pointerEvents={shown ? 'auto' : 'none'}
        accessibilityViewIsModal
        style={[{ position: 'absolute', inset: 0 }, animatedStyle]}
      >
        <View style={{ position: 'absolute', inset: 0, backgroundColor: appTheme.colors.overlay }} />
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: appTheme.spacing.section,
          }}
        >
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Signing out"
            accessibilityState={{ busy: true }}
            style={{
              minWidth: 220,
              alignItems: 'center',
              gap: appTheme.spacing.gap,
              borderRadius: appTheme.radii.xl,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: appTheme.colors.border,
              backgroundColor: appTheme.colors.panelSoft,
              paddingVertical: appTheme.spacing.panel,
              paddingHorizontal: appTheme.spacing.section,
            }}
          >
            <ActivityIndicator size="large" color={appTheme.colors.primary} />
            <View style={{ alignItems: 'center', gap: appTheme.spacing.unit }}>
              <AppText variant="sectionTitle" selectable={false}>Signing out…</AppText>
              <AppText variant="bodySm" color="textSecondary" selectable={false}>One moment</AppText>
            </View>
          </View>
        </View>
      </MotionView>
    </Overlay>
  );
}

/**
 * Follows `active`, except that once it turns on it stays on for at least
 * `minimumMs`. Turning on again before the hold runs out keeps it on.
 */
export function useMinimumVisibility(active: boolean, minimumMs: number) {
  const [shown, setShown] = useState(active);
  const shownSince = useRef<number | null>(active ? Date.now() : null);

  useEffect(() => {
    if (active) {
      shownSince.current ??= Date.now();
      setShown(true);
      return undefined;
    }
    if (shownSince.current === null) return undefined;

    const hide = () => {
      shownSince.current = null;
      setShown(false);
    };
    const remaining = minimumMs - (Date.now() - shownSince.current);
    if (remaining <= 0) {
      hide();
      return undefined;
    }
    const timeoutId = setTimeout(hide, remaining);
    return () => clearTimeout(timeoutId);
  }, [active, minimumMs]);

  return shown;
}
