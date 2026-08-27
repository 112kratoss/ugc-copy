import { Share, Share2 } from 'lucide-react-native';
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
