import { isAppSourceToolLabel } from './app-source-tool';
import { homeModelLabel } from './home-feed-view-model';
import { formatRelativeTime } from './home-view-model';
import {
  parseSearchEntityId,
  searchPostCardLabel,
  searchPostCreatorName,
  searchPostMadeWithLine,
} from './public-search-policy/public-search-policy';
import { isShowcaseVideoPreviewCandidate, isTextOnlyShowcasePost } from './showcase-display';
import { getShowcaseMediaHeight, showcaseToMasonryCard, type ShowcaseMasonryCard } from './showcase-feed-view-model';
import type { ShowcaseFeedItem } from './types';

/**
 * A search post drawn as Explore draws a post (search UX audit 2026-11-13,
 * finding 3): the picture at its own shape in a two-column masonry, Explore's
 * badge (free recipe, price, remixable) and video mark, the creator by
 * @handle, and under it a quiet line that says what the post was made with
 * and when, so "Latest" can be read off the screen.
 *
 * A text post has no picture: it keeps its plate, at a fixed shape.
 */
export interface SearchPostPin {
  id: string;
  item: ShowcaseFeedItem;
  /** Explore's card, for the picture, its shape and its badge; null for a text post. */
  card: ShowcaseMasonryCard | null;
  /** "@luna", or the display name for a creator with no handle. */
  handle: string;
  /** Explore's badge: "Free recipe", "40 credits", "Remixable"; null for none. */
  badge: string | null;
  video: boolean;
  /** "Made with Nano Banana 2.0", or null when the post does not say. */
  madeWith: string | null;
  /** "3d ago", "Oct 1": the feed's own words for when it was posted. */
  date: string;
  label: string;
}

/**
 * What a post was made with, as the reason a search shows it: the model or
 * tool the search is narrowed to, when the post carries it; else the model the
 * feed names on its cards (`homeModelLabel`), else an outside tool the creator
 * named. Never invented: a post that names neither has no line, and never
 * the app itself, which every post made here records as its tool (a template
 * result, or a model newer than this app's names, would otherwise read "Made
 * with magicbooklet"). A text post has no line, as on the web's cards
 * (`getPostMadeWithLabel`).
 */
export function searchPostMadeWithLabel(
  item: Pick<ShowcaseFeedItem, 'model' | 'sourceTool' | 'sourceToolSlug' | 'sourceTools' | 'postFormat' | 'category' | 'mediaUrl'>,
  narrowedTo: { id: string; label: string } | null = null,
): string | null {
  if ((item.postFormat === 'text' || item.category === 'text') && !item.mediaUrl) return null;
  const narrowed = narrowedTo ? parseSearchEntityId(narrowedTo.id) : null;
  if (narrowed && narrowedTo) {
    const carries = narrowed.kind === 'model'
      ? item.model === narrowed.key
      : [item.sourceToolSlug, ...(item.sourceTools ?? []).map((tool) => tool.toolSlug)].includes(narrowed.key);
    if (carries) return narrowedTo.label;
  }
  const model = homeModelLabel(item.model);
  if (model) return model;
  const named = (label: string | null | undefined) => {
    const text = label?.trim();
    return text && !isAppSourceToolLabel(text) ? text : null;
  };
  return item.sourceTools?.map((entry) => named(entry.toolLabel)).find(Boolean) ?? named(item.sourceTool);
}

export function buildSearchPostPin(
  item: ShowcaseFeedItem,
  options: { narrowedTo?: { id: string; label: string } | null; now?: Date } = {},
): SearchPostPin {
  const card = isTextOnlyShowcasePost(item) ? null : showcaseToMasonryCard(item);
  // The creator by handle, as the web's card names them (searchPostCreatorName).
  const handle = searchPostCreatorName({ name: item.creator.name, username: item.creator.username?.replace(/^\s*@+/, '') });
  const badge = card?.unlock?.label ?? null;
  const video = isShowcaseVideoPreviewCandidate(item);
  const madeWithLabel = searchPostMadeWithLabel(item, options.narrowedTo ?? null);
  const madeWith = madeWithLabel ? searchPostMadeWithLine(madeWithLabel) : null;
  const date = formatRelativeTime(item.createdAt, options.now);
  const title = card?.title ?? item.title;
  return {
    id: item.id,
    item,
    card,
    handle,
    badge,
    video,
    madeWith,
    date,
    // The web's card words (searchPostCardLabel), so a screen reader hears the same card on both.
    label: searchPostCardLabel({
      title,
      creatorName: handle,
      saveCount: item.saveCount,
      commentCount: item.commentCount,
      video,
      madeWith: madeWithLabel,
      badges: badge ? [badge] : [],
      date,
    }),
  };
}

/** The shape a text post's plate is drawn at in the masonry: a little taller than wide. */
export const SEARCH_TEXT_PIN_ASPECT_RATIO = 0.8;

/** The height a pin's picture takes at a column's width. */
export function searchPostPinMediaHeight(pin: SearchPostPin, columnWidth: number): number {
  if (!pin.card) return Math.round(columnWidth / SEARCH_TEXT_PIN_ASPECT_RATIO);
  return getShowcaseMediaHeight(pin.card, columnWidth);
}

/**
 * The pins split into `columns` columns, each pin going to the column that is
 * shortest so far (the first on a tie), as a masonry fills: the order a
 * person reads across the two columns is the answer's order, so "Latest"
 * still reads newest first. One column keeps them all in order.
 */
export function splitSearchPostColumns<T>(
  pins: readonly T[],
  columns: number,
  heightOf: (pin: T) => number,
): T[][] {
  const count = Math.max(1, Math.floor(columns));
  const split: T[][] = Array.from({ length: count }, () => []);
  const heights = new Array<number>(count).fill(0);
  for (const pin of pins) {
    let shortest = 0;
    for (let index = 1; index < count; index += 1) {
      if (heights[index] < heights[shortest]) shortest = index;
    }
    split[shortest].push(pin);
    heights[shortest] += heightOf(pin);
  }
  return split;
}
