import { useEffect } from 'react';
import { AccessibilityInfo, Platform, Text } from 'react-native';

import { ToggleButton } from '@/components/ui';
import {
  SEARCH_FOLLOWING_LABEL,
  SEARCH_FOLLOW_FAILED,
  SEARCH_FOLLOW_LABEL,
  searchFollowButtonLabel,
} from '@/lib/public-search-policy/search-ui-words';
import { appTheme } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';

// As wide as "Following" at the standard sizes, so the row does not move when the word changes.
const FOLLOW_BUTTON_MIN_WIDTH = 112;

/**
 * Follow on a creator row of search (2026-11-15): the creator page's own
 * button (`ToggleButton`: its words, its light haptic on a press either way,
 * its 48pt height), beside the row's press, never inside it, so pressing it
 * neither opens the profile nor counts as a result opened, and a screen reader
 * reaches it as a control of its own. The row's hook
 * (`lib/use-search-creator-follow.ts`) says what it shows and does.
 */
export function SearchFollowButton({
  creator,
  following,
  pending,
  onPress,
}: {
  creator: { displayName: string; username: string };
  following: boolean;
  pending: boolean;
  onPress: () => void;
}) {
  return (
    <ToggleButton
      on={following}
      label={following ? SEARCH_FOLLOWING_LABEL : SEARCH_FOLLOW_LABEL}
      accessibilityLabel={searchFollowButtonLabel(creator, following)}
      loading={pending}
      onPress={onPress}
      style={{ flexShrink: 0, minWidth: FOLLOW_BUTTON_MIN_WIDTH }}
      testID="search-follow-button"
    />
  );
}

/**
 * A refused follow, said under its row in the creator page's sentence once
 * the button is put back. Android reads it from its live region; iOS has none,
 * so it is announced.
 */
export function SearchFollowFailedLine() {
  const theme = useAppTheme();
  useEffect(() => {
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(SEARCH_FOLLOW_FAILED);
  }, []);
  return (
    <Text
      accessibilityLiveRegion="polite"
      testID="search-follow-failed"
      style={{ color: theme.colors.danger, ...appTheme.type.caption }}
    >
      {SEARCH_FOLLOW_FAILED}
    </Text>
  );
}
