import { appTheme } from './theme';

/** Preserve the media's existing measured width when replacing the card border with padding. */
export const FEED_CARD_MEDIA_INSET = 1;
/** The preview and its native/custom zoom source must describe the same corners. */
export const FEED_CARD_MEDIA_RADIUS = appTheme.radii.md;

/**
 * How wide the media inside a feed row is: the row less its inset on both
 * sides. Sized to the row's own width, the media spilled 2dp past the row's
 * right edge and was drawn wider than the rectangle a reel
 * measures and shrinks back into, so the picture grew by that much the moment
 * a closing reel let go of it.
 */
export function feedCardMediaWidth(cardWidth: number) {
  return cardWidth - FEED_CARD_MEDIA_INSET * 2;
}
