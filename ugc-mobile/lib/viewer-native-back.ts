import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

import { mediaColors } from '@/lib/theme';

/**
 * The reel's top controls on iOS, as the navigation bar's own items.
 *
 * A Back of ours had to wait for React to take the reel's route away before
 * UIKit could begin the zoom back into the tile: 100–133 ms of nothing after
 * the finger lifted on an iPhone 16e (App Store build, 2026-11-06), the same
 * ~120 ms on the simulator at release speed, and still ~110 ms with the reel
 * already emptied, so the cost was the route removal, not the reel. The bar's
 * Back pops natively, as a swipe does, and the zoom starts 15–43 ms after the
 * lift; the reel then leaves the way it does after a swipe.
 *
 * Mute sits in the bar too: under a bar of its own it could not be pressed, and
 * beside the system's Back it is the same glass at the same height.
 *
 * The button being UIKit's, the app hears of its press only once the pop is
 * under way. A still picture's own flight home (lib/reel-close-flight.ts)
 * therefore reads the finger lifting off it on the UI thread, from a view
 * above the navigator, and where the button is drawn is written there
 * (`reelBackButtonRegion`): move the button and that moves with it.
 */
export type ViewerNativeBarMute = {
  muted: boolean;
  onPress: () => void;
};

export function viewerNativeBackOptions({
  hidden,
  mute,
}: {
  /**
   * Off while Details is open or being swiped to: that page draws its own
   * header, with its own way back to the media.
   */
  hidden: boolean;
  /** Present only while the post on screen makes a sound. */
  mute: ViewerNativeBarMute | null;
}): NativeStackNavigationOptions {
  return {
    headerShown: !hidden,
    headerTransparent: true,
    title: '',
    // Read by VoiceOver; minimal mode draws the chevron alone.
    headerBackTitle: 'Go back',
    headerBackButtonDisplayMode: 'minimal',
    // The long press would list the stack's screens by their route names.
    headerBackButtonMenuEnabled: false,
    headerShadowVisible: false,
    // The reel is dark in both schemes, so its bar draws in the on-media white.
    headerTintColor: mediaColors.onMedia,
    headerStyle: { backgroundColor: 'transparent' },
    headerBlurEffect: 'none',
    // iOS 26 shades content scrolled under a bar; the reel's picture is not
    // scrolled content, and the shade drew a black band over its top.
    scrollEdgeEffects: { top: 'hidden', bottom: 'hidden', left: 'hidden', right: 'hidden' },
    unstable_headerRightItems: mute
      ? () => [{
        type: 'button',
        label: mute.muted ? 'Unmute video' : 'Mute video',
        accessibilityLabel: mute.muted ? 'Unmute video' : 'Mute video',
        icon: { type: 'sfSymbol', name: mute.muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill' },
        selected: mute.muted,
        onPress: mute.onPress,
      }]
      : () => [],
  };
}

/** How far, in points, a swipe toward Details goes before the bar's Back and Mute leave. */
export const LEAVES_MEDIA_AFTER = 8;

/**
 * Whether a slide's horizontal list, at `offset`, has left its last media page
 * for Details: the bar goes as the rest of the chrome starts to slide away with
 * the media. A post without a Details page never leaves.
 */
export function leavesMediaPage(offset: number, detailsPageIndex: number, width: number) {
  return detailsPageIndex > 0 && offset > (detailsPageIndex - 1) * width + LEAVES_MEDIA_AFTER;
}
