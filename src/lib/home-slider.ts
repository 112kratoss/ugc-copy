import { CREATOR_TOOLS, type CreatorToolAccent, type CreatorToolId } from '@/lib/creator-tools';

/**
 * The looping create-shortcut rail that opens the home column, ported from the
 * mobile app's `TopSlider` so both clients present the same thing. Names and
 * semantics deliberately mirror `ugc-mobile/lib/home-feed-view-model.ts`; the
 * two cannot share code (separate workspace, separate `@/*` alias), so keeping
 * them legible side by side is the next best thing.
 *
 * Pure module: no DOM, no React. The component measures real element offsets
 * and hands them here, which is why nothing below needs a slide width.
 */

/** How long a slide rests on screen before the rotation advances. */
export const HOME_SLIDE_INTERVAL_MS = 4600;

/**
 * Grace period after a manual scroll before the timer takes back over. Long
 * enough that a slide someone deliberately scrolled to is never yanked away
 * mid-read.
 */
export const HOME_SLIDE_RESUME_DELAY_MS = 7000;

/**
 * A scroll is treated as finished once it has been quiet this long. The web has
 * no equivalent of `onMomentumScrollEnd`, and `scrollend` is still uneven across
 * browsers, so idle time is the portable settle signal.
 */
export const HOME_SLIDE_SETTLE_IDLE_MS = 140;

/**
 * How many times the slides are laid out end to end.
 *
 * Three, so the rail can live in the middle pass with a full copy on either
 * side. That is what makes the loop seamless in both directions: every position
 * the rotation is corrected to has the same neighbours as the position it was
 * corrected from, so the correction moves no pixels. Two passes cannot do this
 * — the first slide of pass one has nothing to its left, which both blocks a
 * backward scroll and makes the wrap visibly pop.
 */
export const HOME_SLIDE_LOOP_PASSES = 3;

export type HomeSlide =
  | {
      kind: 'workspace';
      id: string;
      eyebrow: string;
      title: string;
      ctaLabel: string;
      href: string;
    }
  | {
      kind: 'tool';
      id: CreatorToolId;
      title: string;
      body: string;
      accent: CreatorToolAccent;
      href: string;
      preview: string;
    };

export interface HomeLoopedSlide {
  key: string;
  slide: HomeSlide;
  /**
   * False on the repeated copies. They exist only to give the scroll somewhere
   * to travel, so the component hides them from assistive tech and the tab
   * order — otherwise every link would be announced three times.
   */
  isCanonical: boolean;
}

/** Tools that have preview art, in the order the mobile rail shows them. */
const SLIDE_TOOL_PREVIEWS: Partial<Record<CreatorToolId, string>> = {
  image: '/assets/images/home-previews/image.jpg',
  video: '/assets/images/home-previews/video.jpg',
  motion: '/assets/images/home-previews/motion.jpg',
};

/**
 * The rail's contents: the workspace card, then one card per creator tool that
 * has preview art. Tools come from `CREATOR_TOOLS`, so the rail follows the
 * same catalogue as `/create` and the quick-starts card.
 *
 * `displayName` greets a signed-in viewer, matching the mobile rail. Left out
 * on the signed-out home, which must stay statically prerenderable and has no
 * one to greet.
 */
export function getHomeSlides(displayName?: string | null): HomeSlide[] {
  const tools = CREATOR_TOOLS.flatMap((tool): HomeSlide[] => {
    const preview = SLIDE_TOOL_PREVIEWS[tool.id];
    if (!preview) return [];

    return [{
      kind: 'tool',
      id: tool.id,
      title: tool.shortLabel,
      body: tool.summary,
      accent: tool.accent,
      href: tool.href,
      preview,
    }];
  });

  const greeted = displayName?.trim();

  return [
    {
      kind: 'workspace',
      id: 'workspace',
      eyebrow: 'Creator workspace',
      // Same two lines the mobile rail uses, so a creator meets the same card
      // on either client.
      title: greeted ? `Ready when you are, ${greeted}` : 'Create something worth sharing',
      ctaLabel: 'Create new',
      href: '/create',
    },
    ...tools,
  ];
}

/**
 * Repeats the slides so the rail extends past both ends of what is on screen.
 * A lone slide has nothing to rotate through, so it is laid out once.
 */
export function buildLoopedHomeSlides(slides: HomeSlide[]): HomeLoopedSlide[] {
  const passes = slides.length > 1 ? HOME_SLIDE_LOOP_PASSES : 1;
  const canonicalPass = slides.length > 1 ? getInitialHomeSlideIndex(slides.length) / slides.length : 0;

  return Array.from({ length: passes }, (_, pass) =>
    slides.map((slide) => ({
      key: `${slide.id}-${pass}`,
      slide,
      isCanonical: pass === canonicalPass,
    }))
  ).flat();
}

/**
 * Where the rail sits at rest: the first slide of the middle pass. Landing here
 * rather than at 0 means a backward scroll has real cards to travel onto, so
 * the first slide continues from the last instead of hitting a dead end.
 */
export function getInitialHomeSlideIndex(slideCount: number) {
  return slideCount > 1 ? slideCount : 0;
}

/**
 * Next position in the rotation.
 *
 * The index is free to leave the middle pass — that is how the rail keeps
 * travelling the way it was already going instead of sweeping back through
 * everything it just showed. `foldHomeSlideOffset` brings it home once the
 * scroll settles.
 */
export function advanceHomeSlide(currentIndex: number, slideCount: number) {
  if (slideCount <= 1) return 0;

  return currentIndex + 1;
}

/** The middle-pass position showing the same slide as `index`. */
export function getCenteredHomeSlideIndex(index: number, slideCount: number) {
  if (slideCount <= 1) return 0;

  const wrapped = ((index % slideCount) + slideCount) % slideCount;

  return slideCount + wrapped;
}

/**
 * How far to shift the scroll so the settled slide is swapped for its
 * middle-pass copy — subtract this from `scrollLeft`.
 *
 * Which slide settled is decided by index and the distance is read from the
 * measured offsets, and both halves of that matter. Deciding by index tolerates
 * the pixel or two a scroll rests off its snap point; a comparison against an
 * exact pass boundary would miss the wrap whenever a percentage width made the
 * pass fractional. Moving by a measured multiple of the pass — rather than
 * snapping to the destination's own offset — keeps whatever sub-pixel remainder
 * the scroll had, so the correction moves no pixels and stays invisible.
 */
export function getHomeSlideFoldShift(
  settledIndex: number,
  slideCount: number,
  slideOffsets: number[]
) {
  if (slideCount <= 1) return 0;

  const from = slideOffsets[settledIndex];
  const to = slideOffsets[getCenteredHomeSlideIndex(settledIndex, slideCount)];

  if (from === undefined || to === undefined) return 0;

  return from - to;
}

/**
 * Pointer speed, in px/ms, past which letting go reads as a flick rather than a
 * placement. Roughly a brisk toss; below it the release simply keeps whichever
 * card the drag left on screen.
 */
export const HOME_SLIDE_FLICK_VELOCITY = 0.35;

/**
 * Which slide a released drag should come to rest on.
 *
 * A slow drag stays where it was put — the nearest card. A flick carries one
 * card further in the direction it was thrown, and only one: the rail is a
 * short list of destinations, and a gesture that skated past three of them
 * would lose the person who threw it. (The mobile rail bounds itself the same
 * way, through `disableIntervalMomentum`.)
 */
export function getHomeSlideReleaseIndex(
  nearestIndex: number,
  velocity: number,
  itemCount: number
) {
  if (itemCount <= 0) return 0;

  // A pointer travelling left drags the content left, which moves the rail
  // towards the next slide.
  const flick = velocity <= -HOME_SLIDE_FLICK_VELOCITY ? 1
    : velocity >= HOME_SLIDE_FLICK_VELOCITY ? -1
      : 0;

  return Math.min(itemCount - 1, Math.max(0, nearestIndex + flick));
}

/**
 * Index of the laid-out slide nearest `offset`, given each slide's distance
 * from the start of the track. Measured rather than computed: CSS decides the
 * real widths, so asking the DOM is both simpler and exact.
 */
export function getNearestHomeSlideIndex(offset: number, slideOffsets: number[]) {
  if (slideOffsets.length === 0) return 0;

  let nearest = 0;
  let smallestGap = Number.POSITIVE_INFINITY;

  slideOffsets.forEach((slideOffset, index) => {
    const gap = Math.abs(slideOffset - offset);
    if (gap < smallestGap) {
      smallestGap = gap;
      nearest = index;
    }
  });

  return nearest;
}

/**
 * Motion that starts on its own has to be able to stop on its own too: it
 * pauses when scrolled out of view or the tab is hidden, while someone is
 * interacting with it, and entirely under Reduce Motion — an unattended
 * carousel is exactly the auto-updating content that setting exists to silence.
 */
export function shouldAutoAdvanceHomeSlides({
  slideCount,
  isVisible,
  isInteracting,
  reduceMotion,
}: {
  slideCount: number;
  isVisible: boolean;
  isInteracting: boolean;
  reduceMotion: boolean;
}) {
  return slideCount > 1 && isVisible && !isInteracting && !reduceMotion;
}
