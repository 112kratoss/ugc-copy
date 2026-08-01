'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Image as ImageIcon, Rocket, Video, WandSparkles } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { getAccentClasses } from '@/app/components/DesignSystem';
import {
  HOME_SLIDE_INTERVAL_MS,
  HOME_SLIDE_RESUME_DELAY_MS,
  HOME_SLIDE_SETTLE_IDLE_MS,
  advanceHomeSlide,
  buildLoopedHomeSlides,
  getCenteredHomeSlideIndex,
  getHomeSlideFoldShift,
  getHomeSlideReleaseIndex,
  getHomeSlides,
  getInitialHomeSlideIndex,
  getNearestHomeSlideIndex,
  shouldAutoAdvanceHomeSlides,
  type HomeSlide,
} from '@/lib/home-slider';

/**
 * The create-shortcut rail at the top of the home column — the web build of the
 * mobile app's `TopSlider`, down to the loop behaviour: it advances on its own,
 * travels forward past the last card into a copy of the first, and continues
 * backward off the first into the last, with no visible seam at the wrap.
 *
 * The seam is avoided by laying the slides out three times and, once a scroll
 * settles, translating the offset back into the middle pass by an exact
 * multiple of the pass width. Because the destination renders the identical
 * card between identical neighbours, that correction moves nothing on screen —
 * it only restores the runway needed to keep scrolling either way.
 */
const TOOL_ICONS = {
  image: ImageIcon,
  video: Video,
  motion: Rocket,
  workflow: WandSparkles,
} as const;

/**
 * How far a pointer may travel and still count as a click on a card. Below this
 * a drag is indistinguishable from the shake of pressing a mouse button.
 */
const DRAG_CLICK_THRESHOLD_PX = 5;

/**
 * How stale the last pointer sample may be and still count as a throw. Holding
 * a card still for longer than this is a placement, however fast it arrived.
 */
const DRAG_VELOCITY_STALE_MS = 90;

export default function HomeSlider() {
  const slides = useMemo(() => getHomeSlides(), []);
  const loopedSlides = useMemo(() => buildLoopedHomeSlides(slides), [slides]);
  const initialIndex = getInitialHomeSlideIndex(slides.length);

  const trackRef = useRef<HTMLDivElement | null>(null);
  // The timer's own position. Held in a ref so re-arming it on every tick would
  // not restart the interval mid-cycle.
  const slideIndexRef = useRef(initialIndex);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while the rail is correcting itself, so the scroll that correction
  // emits is not mistaken for a fresh one and folded again.
  const foldingRef = useRef(false);
  const dragRef = useRef({
    active: false,
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
    /** Whether this drag travelled far enough to be a scroll, not a click. */
    moved: false,
    /** Last sample, kept so the release can tell a flick from a placement. */
    lastX: 0,
    lastAt: 0,
    velocity: 0,
  });

  const [isInteracting, setIsInteracting] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);

  /** Each laid-out slide's distance from the start of the track. */
  const readSlideOffsets = useCallback(() => {
    const track = trackRef.current;
    if (!track) return [];

    const items = [...track.children] as HTMLElement[];
    if (items.length === 0) return [];

    const origin = items[0].offsetLeft;

    return items.map((item) => item.offsetLeft - origin);
  }, []);

  const scrollToIndex = useCallback((index: number, smooth: boolean) => {
    const track = trackRef.current;
    const offsets = readSlideOffsets();
    const target = offsets[index];

    if (!track || target === undefined) return;

    track.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
  }, [readSlideOffsets]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(query.matches);

    sync();
    query.addEventListener('change', sync);

    return () => query.removeEventListener('change', sync);
  }, []);

  // Park in the middle pass before the first paint the user can act on, so a
  // backward scroll has somewhere to go from the very first card.
  useEffect(() => {
    if (initialIndex === 0) return;

    scrollToIndex(initialIndex, false);
    slideIndexRef.current = initialIndex;
  }, [initialIndex, scrollToIndex]);

  // A rail scrolling off-screen or in a hidden tab is wasted work, and coming
  // back to a carousel that silently advanced ten times is disorienting.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    const syncTabVisibility = () => setIsVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', syncTabVisibility);

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting && document.visibilityState === 'visible'),
      { threshold: 0.4 }
    );
    observer.observe(track);

    return () => {
      document.removeEventListener('visibilitychange', syncTabVisibility);
      observer.disconnect();
    };
  }, []);

  useEffect(() => () => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  const autoAdvance = shouldAutoAdvanceHomeSlides({
    slideCount: slides.length,
    isVisible,
    isInteracting,
    reduceMotion,
  });

  useEffect(() => {
    if (!autoAdvance) return;

    const timer = setInterval(() => {
      const nextIndex = advanceHomeSlide(slideIndexRef.current, slides.length);
      slideIndexRef.current = nextIndex;
      scrollToIndex(nextIndex, true);
    }, HOME_SLIDE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [autoAdvance, scrollToIndex, slides.length]);

  const scheduleResume = useCallback(() => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => setIsInteracting(false), HOME_SLIDE_RESUME_DELAY_MS);
  }, []);

  const holdRotation = useCallback(() => {
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
    setIsInteracting(true);
  }, []);

  /**
   * Runs once the scroll has been quiet — the timer's own scrolls included.
   * Whatever pass it landed in, the offset is translated back into the middle
   * pass by whole pass-widths, which maps every visible pixel onto its own copy.
   */
  const settleRotation = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;

    const offsets = readSlideOffsets();
    const settledIndex = getNearestHomeSlideIndex(track.scrollLeft, offsets);
    const shift = getHomeSlideFoldShift(settledIndex, slides.length, offsets);

    if (shift !== 0) {
      foldingRef.current = true;
      track.scrollTo({ left: track.scrollLeft - shift, behavior: 'auto' });
      // Cleared on the next frame: the instant scroll lands before then, and
      // waiting avoids treating its own scroll event as a new interaction.
      requestAnimationFrame(() => { foldingRef.current = false; });
    }

    // Whatever turned snapping off to get here, this is where it comes back:
    // the rail is at rest on a card, so restoring it moves nothing. Leaving it
    // off would cost touch its native card-settling on the next swipe.
    track.style.scrollSnapType = '';

    const centeredIndex = getCenteredHomeSlideIndex(settledIndex, slides.length);
    slideIndexRef.current = centeredIndex;

    // A glide cut short — a tab switched away mid-animation — leaves the rail
    // parked between two cards, and mandatory snapping will not rescue it
    // because snapping only reacts to scrolls. The threshold keeps this clear
    // of the sub-pixel remainder the fold deliberately preserves.
    const restingOffset = offsets[centeredIndex];
    if (restingOffset !== undefined && Math.abs(track.scrollLeft - restingOffset) > 1) {
      foldingRef.current = true;
      track.scrollTo({ left: restingOffset, behavior: 'auto' });
      requestAnimationFrame(() => { foldingRef.current = false; });
    }
  }, [readSlideOffsets, slides.length]);

  /**
   * Debounced, so a run of scroll events settles once, after the last of them.
   */
  const scheduleSettle = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(settleRotation, HOME_SLIDE_SETTLE_IDLE_MS);
  }, [settleRotation]);

  const handleScroll = useCallback(() => {
    // Mid-drag the rail is following the pointer, and folding under it would
    // shift the content the hand is holding. The release settles instead.
    if (foldingRef.current || dragRef.current.active) return;

    scheduleSettle();
  }, [scheduleSettle]);

  /**
   * Drag-to-scroll, for pointers the browser does not pan with on its own.
   *
   * Touch already scrolls this natively, with momentum and snapping tuned by
   * the platform, so hijacking it would only make it worse — a mouse (or a pen)
   * is the one that otherwise leaves the rail feeling stuck.
   */
  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    holdRotation();

    const track = trackRef.current;
    if (!track || event.pointerType === 'touch' || event.button !== 0) return;

    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: track.scrollLeft,
      moved: false,
      lastX: event.clientX,
      lastAt: event.timeStamp,
      velocity: 0,
    };
    // Mandatory snapping pulls back against every position the drag sets, which
    // reads as the rail resisting the hand. Restored on release so it still
    // settles onto a card.
    track.style.scrollSnapType = 'none';

    try {
      // Capture keeps the drag alive once the pointer leaves the rail. It
      // throws on a pointer the browser no longer considers active, and the
      // drag works without it — so it must not take the rest of this with it.
      track.setPointerCapture(event.pointerId);
    } catch {
      // Dragging past the rail's edge just ends the drag instead.
    }
  }, [holdRotation]);

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const track = trackRef.current;
    if (!drag.active || !track || event.pointerId !== drag.pointerId) return;

    const distance = event.clientX - drag.startX;
    if (Math.abs(distance) > DRAG_CLICK_THRESHOLD_PX) drag.moved = true;

    const elapsed = event.timeStamp - drag.lastAt;
    if (elapsed > 0) {
      const sample = (event.clientX - drag.lastX) / elapsed;
      // Smoothed, so the release reads the throw rather than whichever twitch
      // the last event happened to catch.
      drag.velocity = drag.velocity * 0.7 + sample * 0.3;
      drag.lastX = event.clientX;
      drag.lastAt = event.timeStamp;
    }

    track.scrollLeft = drag.startScrollLeft - distance;
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const track = trackRef.current;

    scheduleResume();
    if (!drag.active || !track) return;

    drag.active = false;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);

    // A pointer resting still before release was placing the rail, not throwing
    // it; without this a pause at the end of a fast drag still flicks.
    if (event.timeStamp - drag.lastAt > DRAG_VELOCITY_STALE_MS) drag.velocity = 0;

    const offsets = readSlideOffsets();
    const target = getHomeSlideReleaseIndex(
      getNearestHomeSlideIndex(track.scrollLeft, offsets),
      drag.velocity,
      offsets.length
    );

    // Glide to the card rather than letting snap seize it. Snap stays off until
    // the glide is over — re-enabling it now would cut the animation short,
    // which is the jerk that made the release feel harsh. `settleRotation`
    // restores it once the scroll goes quiet, by which point the rail is
    // already resting exactly on a snap point.
    scrollToIndex(target, true);
    // Booked here rather than left to the glide's own scroll events: a glide
    // that emits none — already at the target, or interrupted — would
    // otherwise never settle, stranding the rail mid-card with snapping still
    // switched off. Real scroll events simply push this later.
    scheduleSettle();
  }, [readSlideOffsets, scheduleResume, scheduleSettle, scrollToIndex]);

  /**
   * A drag that ends on a card would otherwise open it — the browser still
   * fires a click after the pointer sequence. Only suppressed when the pointer
   * actually travelled, so a plain click still navigates.
   */
  const suppressDragClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragRef.current.moved) return;

    event.preventDefault();
    event.stopPropagation();
    dragRef.current.moved = false;
  }, []);

  return (
    <section aria-label="Start creating" className="home-slider mb-6">
      <div
        ref={trackRef}
        className="home-slider-track"
        onScroll={handleScroll}
        // Any hand on the rail — drag, wheel, trackpad, or keyboard focus —
        // holds the rotation; `scheduleResume` hands it back after the grace
        // period so a single stray wheel tick does not stop it for good.
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={suppressDragClick}
        // Cards contain an image and links, both of which the browser offers to
        // drag natively — that gesture would cancel the pointer sequence and
        // leave the rail stuck mid-drag.
        onDragStart={(event) => event.preventDefault()}
        onWheel={() => { holdRotation(); scheduleResume(); }}
        onFocusCapture={holdRotation}
        onBlurCapture={scheduleResume}
        onMouseLeave={scheduleResume}
      >
        {loopedSlides.map((item) => (
          <div
            key={item.key}
            className="home-slider-slide"
            // The repeated passes are scenery. Hiding them keeps every link from
            // being announced (and tabbed to) three times over.
            aria-hidden={item.isCanonical ? undefined : true}
          >
            <SlideCard slide={item.slide} focusable={item.isCanonical} />
          </div>
        ))}
      </div>
    </section>
  );
}

function SlideCard({ slide, focusable }: { slide: HomeSlide; focusable: boolean }) {
  const tabIndex = focusable ? undefined : -1;

  if (slide.kind === 'workspace') {
    return (
      // Vertical placement is left to `.home-slider-workspace-body`, not a
      // `justify-*` utility: it changes with the breakpoint, and a utility here
      // would be re-emitted by the authenticated sheet and win by source order.
      <div className="home-slider-card home-slider-workspace-body flex flex-col border-[var(--ui-border-default)] bg-[var(--ui-surface-raised)]">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--ui-primary)]" aria-hidden />
            <span className="home-slider-eyebrow truncate font-extrabold uppercase text-[var(--ui-text-muted)]">
              {slide.eyebrow}
            </span>
          </div>
          <p className="home-slider-headline max-w-[18ch] font-extrabold tracking-[-0.02em] text-[var(--ui-text-primary)]">
            {slide.title}
          </p>
        </div>

        <Link
          href={slide.href}
          tabIndex={tabIndex}
          // Never the full card width: at the rail's larger size a button that
          // stretched the whole way would read as a banner, not an action.
          className="ui-focus-ring flex min-h-11 w-fit min-w-[10rem] items-center justify-center gap-2 rounded-[14px] bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)]"
        >
          <WandSparkles className="h-[17px] w-[17px]" aria-hidden />
          {slide.ctaLabel}
        </Link>
      </div>
    );
  }

  const Icon = TOOL_ICONS[slide.id];
  const theme = getAccentClasses(slide.accent);

  return (
    <Link
      href={slide.href}
      prefetch={false}
      tabIndex={tabIndex}
      className={`home-slider-card ui-focus-ring group relative flex flex-col justify-between overflow-hidden border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] transition hover:border-[var(--ui-border-default)] ${theme.border}`}
    >
      <span className={`absolute inset-y-0 left-0 w-[3px] bg-current ${theme.accentText}`} aria-hidden />

      <span className="home-slider-preview">
        {/*
          Decorative: the card's own title says what the tool is, so an alt
          text here would only repeat it to a screen reader.
        */}
        <Image
          src={slide.preview}
          alt=""
          aria-hidden
          fill
          // The card tracks the column, which the shell caps at 680px, so the
          // browser never needs a source wider than the largest card.
          sizes="(min-width: 40rem) 600px, 280px"
          className="object-cover"
        />
        <span className="absolute inset-0 bg-gradient-to-b from-black/[0.04] to-black/50" aria-hidden />
        <span className={`absolute left-3 top-3 flex h-8 w-8 items-center justify-center rounded-xl border ${theme.iconWrap}`}>
          <Icon className="h-[18px] w-[18px]" aria-hidden />
        </span>
      </span>

      <span className="home-slider-tool-body flex flex-col gap-1">
        <span className="home-slider-tool-title truncate font-extrabold text-[var(--ui-text-primary)]">
          {slide.title}
        </span>
        <span className="home-slider-tool-summary line-clamp-2 font-semibold text-[var(--ui-text-muted)]">
          {slide.body}
        </span>
      </span>
    </Link>
  );
}
