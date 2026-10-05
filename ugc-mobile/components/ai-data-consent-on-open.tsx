import { useFocusEffect } from '@react-navigation/native';
import { useCallback } from 'react';

import { askAiDataConsentOnOpen } from '@/lib/ai-data-consent';

/**
 * Puts the AI data-sharing question when the creation screen it sits beside
 * comes into view (`askAiDataConsentOnOpen`). It goes inside
 * `ContentPolicyGate`, so the community rules come first, and it follows focus
 * rather than mount, so a screen that exists but is not in view asks nothing.
 */
export function AiDataConsentOnOpen() {
  useFocusEffect(useCallback(() => {
    askAiDataConsentOnOpen();
  }, []));
  return null;
}
