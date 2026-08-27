import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { AccessibilityInfo } from 'react-native';

/**
 * Copy, and say so on every channel.
 *
 * The app had four copy controls and four different answers to "did that
 * work?": the invite screen showed a notice and announced it, the details page
 * fired a haptic and nothing else, and the marketplace and unlock screens did
 * neither. HIG Feedback asks for the opposite — "when you provide feedback
 * using color, text, sound, and haptics, people can receive it whether they
 * silence their device, look away from the screen, or use VoiceOver".
 *
 * This is the sound-and-touch half; the visible half is the caller's, and
 * `ResourceAction`'s `confirmLabel` supplies it for the pill the resource
 * surfaces share.
 */
export async function copyToClipboard(text: string, announcement = 'Copied') {
  await Clipboard.setStringAsync(text);
  await Haptics.selectionAsync().catch(() => undefined);
  AccessibilityInfo.announceForAccessibility?.(announcement);
}
