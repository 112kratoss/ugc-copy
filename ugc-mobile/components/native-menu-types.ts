import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import type { NativeMenuModel } from '@/lib/native-menu';

/**
 * How the button draws on iOS. SwiftUI draws it there — the system can only
 * grow a menu out of a button it draws itself — so this repeats, in SwiftUI's
 * terms, the look of the React Native button it stands in for.
 */
export interface NativeMenuTrigger {
  /** The box the button fills: the React Native button's box, so nothing moves. */
  width: number;
  height: number;
  /** The glyph's size in points, and its colour. */
  iconSize: number;
  iconColor: string;
  /**
   * A quarter turn, for the vertical ⋮ the cards and headers use. SF Symbols
   * has no plain vertical ellipsis.
   */
  vertical?: boolean;
  /** The card buttons keep their glyph against the box's trailing edge. */
  alignment?: 'center' | 'trailing';
  /** A circle behind the glyph, for the round header buttons, with an optional 1 pt ring. */
  circle?: { fill: string; ring?: string };
  /** A soft shadow under the glyph, for a button drawn over media (the reel's rail). */
  shadowColor?: string;
  /**
   * How far past the box a touch still lands, like the React Native button's
   * `hitSlop`, which SwiftUI cannot read: the SwiftUI view grows by this much on
   * every side, and the glyph is inset by it, so nothing moves.
   */
  hitSlop?: number;
}

export interface NativeMenuProps {
  model: NativeMenuModel;
  /** What VoiceOver reads for the iOS button, and TalkBack for Android's menu, e.g. "More options". */
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** The iOS button. */
  trigger: NativeMenuTrigger;
  /**
   * Draws the React Native button around the press handler it is given. Android
   * draws it (the handler opens the menu), and so does an iOS build without
   * Expo UI (the handler is `onFallbackPress`).
   */
  renderButton: (onPress: () => void) => ReactNode;
  /** What a press did before native menus: open the caller's sheet. */
  onFallbackPress: () => void;
  /** Layout for the button's box within its row, such as a negative margin. */
  style?: StyleProp<ViewStyle>;
}
