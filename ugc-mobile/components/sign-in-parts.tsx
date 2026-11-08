// The pieces both halves of the sign-in page draw (`components/sign-in-wall.tsx` and the email
// form in `components/email-sign-in-form.tsx`): Apple and Google at one size, and the terms line.
import * as AppleAuthentication from 'expo-apple-authentication';
import { ActivityIndicator, Linking, Platform, Pressable, Text, View } from 'react-native';

import { GoogleGMark } from '@/components/google-g-mark';
import { signInProviderButtons } from '@/lib/auth-error-copy';
import { env } from '@/lib/env';
import { appTheme, mediaColors } from '@/lib/theme';

/**
 * Every button on the sign-in page, a compact, centred pill (owner, 2026-11-08: "reduce the
 * button lengths … a bit modern"): 48pt tall, which Apple's system button titles at about
 * 18pt, so the drawn buttons beside it take that size too; at most 300pt wide, centred.
 */
export const BUTTON_HEIGHT = 48;
export const BUTTON_LABEL_SIZE = 18;
export const BUTTON_MAX_WIDTH = 300;

/**
 * Apple and Google, as both sign-in screens draw them: one width, one height, one label size.
 * Apple's system button and a drawn Google button to match it, both white on the dark wall.
 * Android has Google alone, and it leads there just as Apple does on iOS.
 */
export function SignInProviderButtons({ onApple, onGoogle, appleBusy, googleBusy, unavailable }: {
  onApple: () => void;
  onGoogle: () => void;
  appleBusy: boolean;
  googleBusy: boolean;
  /** A sign-in is under way, or auth is not configured: the buttons wait. */
  unavailable: boolean;
}) {
  const providers = signInProviderButtons(Platform.OS);
  return (
    <View style={{ gap: 10, width: '100%', maxWidth: BUTTON_MAX_WIDTH, alignSelf: 'center' }}>
      {providers.includes('Apple') ? (
        <View
          pointerEvents={unavailable ? 'none' : 'auto'}
          style={{ opacity: unavailable && !appleBusy ? appTheme.opacity.disabled : 1 }}
        >
          <AppleAuthentication.AppleAuthenticationButton
            accessibilityLabel="Continue with Apple"
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
            // Apple's rule for the system button: white on a dark background.
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={BUTTON_HEIGHT / 2}
            onPress={onApple}
            style={{ width: '100%', height: BUTTON_HEIGHT }}
          />
          {/* Apple's button cannot show progress itself; the same spinner Google's shows,
              over it, while its sign-in finishes. */}
          {appleBusy ? (
            <View
              accessibilityLabel="Signing in with Apple"
              accessibilityLiveRegion="polite"
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: appTheme.radii.pill,
                backgroundColor: mediaColors.onMedia,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ActivityIndicator color={mediaColors.mediaGround} />
            </View>
          ) : null}
        </View>
      ) : null}
      {providers.includes('Google') ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue with Google"
          accessibilityHint="Signs in, or creates your account, with Google"
          accessibilityState={{ busy: googleBusy, disabled: unavailable }}
          disabled={unavailable}
          onPress={onGoogle}
          style={({ pressed }) => ({
            height: BUTTON_HEIGHT,
            borderRadius: appTheme.radii.pill,
            backgroundColor: mediaColors.onMedia,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            opacity: unavailable ? appTheme.opacity.disabled : pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          {googleBusy ? (
            <ActivityIndicator color={mediaColors.mediaGround} />
          ) : (
            <>
              <GoogleGMark size={18} />
              <Text
                maxFontSizeMultiplier={1.3}
                style={{ color: mediaColors.mediaGround, fontSize: BUTTON_LABEL_SIZE, fontWeight: '600', letterSpacing: -0.2 }}
              >
                Continue with Google
              </Text>
            </>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The terms line both sign-in screens end on, white on the wall: one sentence whose two
 * documents are its links, each its own control with a full reach.
 */
export function SignInTerms() {
  const words = { color: mediaColors.onMediaSecondary, fontSize: 13, lineHeight: 18 } as const;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', columnGap: 4 }}>
      <Text style={words}>By continuing you agree to our</Text>
      <TermsLink label="Terms" spoken="terms of service" path="/terms" />
      <Text style={words}>and</Text>
      <TermsLink label="Privacy Policy" spoken="privacy policy" path="/privacy" />
    </View>
  );
}

function TermsLink({ label, spoken, path }: { label: string; spoken: string; path: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${spoken}`}
      onPress={() => void Linking.openURL(`${env.siteUrl}${path}`)}
      // A 13pt line reached from a full 44pt row.
      hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
      style={({ pressed }) => ({ paddingVertical: 2, opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <Text style={{ color: mediaColors.onMedia, fontSize: 13, lineHeight: 18, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}
