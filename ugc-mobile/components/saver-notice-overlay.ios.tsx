import type { ReactNode } from 'react';
import { FullWindowOverlay } from 'react-native-screens';

/**
 * On iOS the saver notice is drawn in react-native-screens' full-window
 * overlay, above every presented Modal, so nothing in the app can cover it
 * while it counts down (`saver-notice-bar.tsx`). Already in the binary: the
 * library is a native dependency the app ships with.
 *
 * Not a VoiceOver modal, as the overlay's container is by default: with a
 * screen reader running the notice waits for OK, and VoiceOver must still
 * reach Back, Mute and the tab bar meanwhile, and anything else while it
 * fades out.
 */
export function SaverNoticeOverlay({ children }: { children?: ReactNode }) {
  return (
    <FullWindowOverlay unstable_accessibilityContainerViewIsModal={false}>
      {children}
    </FullWindowOverlay>
  );
}
