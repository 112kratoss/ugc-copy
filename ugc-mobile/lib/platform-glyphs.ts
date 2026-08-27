import { ArrowLeft, ChevronLeft, Share, Share2, X } from 'lucide-react-native';
import * as ReactNative from 'react-native';

/**
 * Focused component tests mock react-native down to the exports they render,
 * and reading a missing one off the mock namespace throws rather than yielding
 * undefined — same guard as `lib/motion` and `lib/use-hardware-back`. Off iOS
 * (and in such a test) the glyphs resolve to the Material dialect.
 */
function isIOS() {
  try {
    return ReactNative.Platform.OS === 'ios';
  } catch {
    return false;
  }
}

const IS_IOS = isIOS();

/**
 * Glyphs that carry an operating system's own meaning, in that system's shape.
 *
 * Apple's Icons chapter publishes a table of standard symbols for common
 * actions, and Share is `square.and.arrow.up` — the tray with an arrow rising
 * out of it. Android speaks the other dialect: Material's share is the node
 * graph. Sharing is the one action in this app where the platform's glyph is
 * more legible than a house one, so each platform gets its own (see the
 * iconography decision, D2a — Lucide everywhere, except where a glyph carries
 * OS meaning).
 */
export const ShareGlyph = IS_IOS ? Share : Share2;

/**
 * Back is the second such glyph, and the case is stronger than Share's: this
 * app draws its own header on some screens and lets the navigator draw it on
 * others, so both appear on the same device in the same session.
 *
 * Toolbars: "Use the standard Back and Close buttons ... Prefer the standard
 * symbols for each ... If you create a custom version of either, make sure it
 * still looks the same, behaves as people expect, and matches the rest of your
 * interface, and ensure you consistently implement it throughout your app."
 *
 * iOS's standard symbol is `chevron.backward`, which is what the native stack
 * header renders (`headerBackButtonDisplayMode: 'minimal'` in the root layout)
 * — so a custom header has to draw a chevron or it contradicts the header one
 * screen away. Android's standard is Material's left arrow, which is what its
 * own navigator draws. One import, each platform's own shape.
 */
export const BackGlyph = IS_IOS ? ChevronLeft : ArrowLeft;

/**
 * Close: the control that dismisses a modal surface, and the one Toolbars names
 * in the same breath as Back — "Use the standard Back and Close buttons ...
 * ensure you consistently implement it throughout your app."
 *
 * Both platforms draw Close as the same mark (SF `xmark`, Material `close`), so
 * unlike `BackGlyph` and `ShareGlyph` this one carries no platform dialect.
 * What it carries is the other half of the rule: the app drew Close at eight
 * different sizes across eleven modal surfaces. One import, one size at the call
 * site (`appTheme.icon.feature`), so a sheet and the screen it opened from close
 * with the same mark.
 *
 * Only for dismissing a modal surface. An X that removes a chip, clears a field
 * or dismisses an inline banner is a different action wearing the same shape,
 * and keeps its own `X`.
 */
export const CloseGlyph = X;
