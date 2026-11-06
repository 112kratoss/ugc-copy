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
