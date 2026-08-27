import { ArrowLeft, ChevronLeft, Share, Share2 } from 'lucide-react-native';
import { Platform } from 'react-native';

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
export const ShareGlyph = Platform.OS === 'ios' ? Share : Share2;

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
export const BackGlyph = Platform.OS === 'ios' ? ChevronLeft : ArrowLeft;
