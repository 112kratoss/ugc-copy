import { AccessibilityInfo, Platform } from 'react-native';

/**
 * Says something to VoiceOver or TalkBack without cutting off what is being
 * read: on iOS it waits behind the current speech (a notice that just
 * appeared, for one); Android has no queue option and announces as before.
 */
export function announceQueued(message: string) {
  if (Platform.OS === 'ios' && AccessibilityInfo.announceForAccessibilityWithOptions) {
    AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
    return;
  }
  void AccessibilityInfo.announceForAccessibility?.(message);
}
