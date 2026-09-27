/** The hairline edge of a feed card (`components/feed-card-shell.tsx`). */
export const FEED_CARD_BORDER_WIDTH = 1;

/**
 * How wide the media inside a feed card is: the card less its border on both
 * sides. Sized to the card's own width, the media spilled 2dp past the card's
 * right edge, over the border, and was drawn wider than the rectangle a reel
 * measures and shrinks back into, so the picture grew by that much the moment
 * a closing reel let go of it.
 */
export function feedCardMediaWidth(cardWidth: number) {
  return cardWidth - FEED_CARD_BORDER_WIDTH * 2;
}
