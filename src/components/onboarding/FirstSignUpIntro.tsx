'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { useInertPageBeneath } from '@/components/useInertPageBeneath';
import { displayFont } from '@/lib/display-font';
import { liftFirstSignUpIntroCover } from '@/lib/first-sign-up-intro';
import {
  CALM_ENTER,
  CALM_FADE,
  CALM_LETTER_AT,
  CALM_LETTER_READ_AT,
  DUST_END_AT,
  EASE_OUT_CUBIC_CSS,
  EASE_OUT_QUAD_CSS,
  ENTER,
  FADE_OUT,
  INTRO_LETTER,
  INTRO_LETTER_SPOKEN,
  INTRO_WORDS_SPOKEN,
  LETTER_ACTION,
  LETTER_AT,
  LETTER_BODY,
  LETTER_HEAD,
  LETTER_READ_AT,
  LETTER_SIGN,
  share,
  SNAP,
  SNAP_AT,
} from '@/lib/first-sign-up-intro-timeline';
import { handwritingFont } from '@/lib/handwriting-font';

import { createIntroStage, type IntroFaces, type IntroStage } from './first-sign-up-intro-stage';

/**
 * The app's first-open intro (#725, `ugc-mobile/components/first-open-intro.tsx`)
 * on the web, played once over the creator-name step after a browser's first
 * sign-up (`FirstSignUpIntroGate` decides when).
 *
 * "Create anything / Share the magic / Earn as it grows" arrives a line at a
 * time, each note written in beside its word; everything holds, then the
 * words turn to dust and blow away (a canvas, `first-sign-up-intro-stage.ts`),
 * and a note from the team comes in as they go. Explore lifts the intro off
 * the page beneath, as Escape does at any point.
 *
 * Reduced motion: the words fade in together, stay, and cross-fade to the
 * note, which arrives whole. No dust, no writing.
 *
 * A screen reader reads the words, then the note, each as one item (the
 * drawing is hidden from it); the focus moves to Explore as it can be
 * pressed, which reads the note as the dialog's description. The page beneath
 * is inert and hidden from assistive technology while the intro is up.
 */

export type FirstSignUpIntroEntrance =
  /** The server's cover held the intro's ground from the first paint. */
  | 'covered'
  /** The page beneath was drawn first: the ground fades in over it. */
  | 'fade';

type Phase = 'waiting' | 'words' | 'letter';

/** How long the timeline waits for the two faces before it starts without them (ms). */
const FACES_WAIT = 2500;

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The display face and the handwriting, once loaded. A face still loading
 * when the wait is over would swap in mid-stroke, so the intro is then drawn
 * in the page's own face throughout; so it is when only next/font's
 * metric-matched fallback (a local face) answered.
 */
async function loadFaces(): Promise<IntroFaces> {
  const brand = { display: displayFont.style.fontFamily, handwriting: handwritingFont.style.fontFamily };
  const pageFace = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const fallback = { display: pageFace, handwriting: pageFace };
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), FACES_WAIT);
  });
  try {
    const loaded = Promise.all([
      fonts.load(`800 54px ${brand.display}`),
      fonts.load(`700 17px ${brand.display}`),
      fonts.load(`700 27px ${brand.handwriting}`),
    ]).then((matches) => (matches.every((faces) => faces.some((face) => !/fallback/i.test(face.family))) ? 'loaded' : 'missing'));
    return (await Promise.race([loaded, late])) === 'loaded' ? brand : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** The page's own colours: the words in their tools' accents, the notes in the secondary text. */
function readInk() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    primary: token('--ui-primary', '#ff7a59'),
    image: token('--ui-accent-image', '#73bff2'),
    motion: token('--ui-accent-motion', '#b7a0f5'),
    note: token('--ui-text-secondary', '#ddd6cc'),
  };
}

/**
 * The page beneath does not scroll while the intro is up, and does not move
 * either: where the window has a scrollbar that takes room, the room is kept.
 */
function useStillPageBeneath() {
  useEffect(() => {
    const root = document.documentElement;
    const before = { overflow: root.style.overflow, gutter: root.style.getPropertyValue('scrollbar-gutter') };
    if (window.innerWidth > root.clientWidth) root.style.setProperty('scrollbar-gutter', 'stable');
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = before.overflow;
      if (before.gutter) root.style.setProperty('scrollbar-gutter', before.gutter);
      else root.style.removeProperty('scrollbar-gutter');
    };
  }, []);
}

/** How long the timeline waits for the page beneath to settle before it starts anyway (ms). */
const SETTLE_WAIT = 400;

/**
 * Once the main thread is idle, at most `SETTLE_WAIT` later: work the page
 * beneath defers until after its load (the shell's account, the notifications)
 * then runs under the intro's ground rather than in the first word's fade.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: SETTLE_WAIT });
    else setTimeout(resolve, 50);
  });
}

function animate(element: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  return element && typeof element.animate === 'function' ? element.animate(keyframes, options) : null;
}

export function FirstSignUpIntro({ entrance, onDone }: { entrance: FirstSignUpIntroEntrance; onDone: () => void }) {
  const id = useId();
  const headlineId = `${id}-headline`;
  const letterId = `${id}-letter`;
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLParagraphElement>(null);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const signWindowRef = useRef<HTMLSpanElement>(null);
  const signInnerRef = useRef<HTMLSpanElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const leaving = useRef(false);
  // Mounted only in the browser, after the gate has decided.
  const [calm] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<Phase>('waiting');
  const [isLeaving, setLeaving] = useState(false);
  const [faces, setFaces] = useState<IntroFaces | null>(null);
  const [letterRead, setLetterRead] = useState(false);
  const [dustGone, setDustGone] = useState(false);

  useInertPageBeneath(overlayRef, { lockScroll: false });
  useStillPageBeneath();

  // The intro's own ground is drawn now: the server's cover can go.
  useLayoutEffect(() => {
    liftFirstSignUpIntroCover(document.documentElement);
  }, []);

  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    setLeaving(true);
    const fade = animate(overlayRef.current, [{ opacity: 1 }, { opacity: 0 }], {
      duration: FADE_OUT,
      easing: EASE_OUT_QUAD_CSS,
      fill: 'forwards',
    });
    if (fade) void fade.finished.then(onDone, onDone);
    else onDone();
  }, [onDone]);

  // Escape lifts it off at any point, as the app's back button does.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      leave();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [leave]);

  // The timeline: the ground in (when the page was on screen first), the
  // faces loaded, then one clock for the words, the dust and the note.
  useEffect(() => {
    let cancelled = false;
    let frame = 0;
    let stage: IntroStage | null = null;
    let refit = false;
    const onResize = () => {
      refit = true;
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    const entered = entrance === 'fade'
      ? animate(overlayRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: calm ? CALM_ENTER : ENTER, easing: EASE_OUT_CUBIC_CSS })?.finished.catch(() => undefined)
      : undefined;

    void Promise.all([loadFaces(), entered, settled()]).then(([loadedFaces]) => {
      if (cancelled) return;
      setFaces(loadedFaces);
      const canvas = canvasRef.current;
      stage = canvas ? createIntroStage(canvas, { faces: loadedFaces, ink: readInk(), calm }) : null;
      const fit = () => stage?.layout({ width: window.innerWidth, height: window.innerHeight }, window.devicePixelRatio);
      fit();
      stage?.warm();
      window.addEventListener('resize', onResize);

      let start = 0;
      const canvasEnd = calm ? CALM_LETTER_AT + CALM_FADE : DUST_END_AT;
      const draw = (now: number) => {
        if (cancelled) return;
        if (refit) {
          refit = false;
          fit();
        }
        const elapsed = now - start;
        if (!calm && elapsed >= SNAP_AT) stage?.drawDust(share(elapsed, SNAP_AT, SNAP_AT + SNAP));
        else stage?.drawWords(elapsed);
        if (elapsed < canvasEnd) {
          frame = requestAnimationFrame(draw);
          return;
        }
        // The dust has blown away: every pixel of it is let go.
        window.removeEventListener('resize', onResize);
        stage?.release();
        stage = null;
        setDustGone(true);
      };
      setPhase('words');
      // The clock starts at the first frame, after React has drawn the change
      // of phase, so none of that work is taken out of the first word's fade.
      frame = requestAnimationFrame((first) => {
        if (cancelled) return;
        start = first;
        // For a frame-time trace: the timeline's zero.
        performance.mark?.('first-sign-up-intro:start');
        timers.push(setTimeout(() => setPhase('letter'), calm ? CALM_LETTER_AT : LETTER_AT));
        timers.push(setTimeout(() => setLetterRead(true), calm ? CALM_LETTER_READ_AT : LETTER_READ_AT));
        draw(first);
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      for (const timer of timers) clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      stage?.release();
    };
  }, [calm, entrance]);

  // The note comes in as the words go: headline, paragraph, the signature
  // written in, then the button (the app's own timings). Under reduced
  // motion it arrives whole, in one fade.
  useLayoutEffect(() => {
    if (phase !== 'letter') return;
    const running: Animation[] = [];
    const run = (element: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation = animate(element, keyframes, { fill: 'both', ...options });
      if (animation) running.push(animation);
    };
    if (calm) {
      for (const element of [noteRef.current, actionRef.current]) {
        run(element, [{ opacity: 0 }, { opacity: 1 }], { duration: CALM_FADE, easing: EASE_OUT_QUAD_CSS });
      }
    } else {
      const part = (element: Element | null, [from, to]: readonly [number, number], rise: number) => {
        run(element, [{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: 'none' }], {
          delay: from,
          duration: to - from,
          easing: 'linear',
        });
      };
      part(headRef.current, LETTER_HEAD, 12);
      part(bodyRef.current, LETTER_BODY, 10);
      part(actionRef.current, LETTER_ACTION, 8);
      // A window that opens across the signature, left to right.
      const write = { delay: LETTER_SIGN[0], duration: LETTER_SIGN[1] - LETTER_SIGN[0], easing: 'linear' };
      run(signWindowRef.current, [{ transform: 'translateX(-100%)' }, { transform: 'none' }], write);
      run(signInnerRef.current, [{ transform: 'translateX(100%)' }, { transform: 'none' }], write);
    }
    return () => {
      for (const animation of running) animation.cancel();
    };
  }, [calm, phase]);

  // The focus moves to Explore as it can be pressed.
  useEffect(() => {
    if (letterRead) continueRef.current?.focus({ preventScroll: true });
  }, [letterRead]);

  const showingLetter = phase === 'letter';
  const display = faces?.display;
  const handwriting = faces?.handwriting;

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label={showingLetter ? undefined : `Welcome to ${INTRO_LETTER.name.join(' ')}`}
      aria-labelledby={showingLetter ? headlineId : undefined}
      aria-describedby={showingLetter ? letterId : undefined}
      className={`fixed inset-0 z-[80] overflow-hidden bg-[var(--ui-bg-page)] text-[var(--ui-text-primary)] ${isLeaving ? 'pointer-events-none' : ''}`}
    >
      {dustGone ? null : <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />}

      {showingLetter ? null : <p className="sr-only">{INTRO_WORDS_SPOKEN}</p>}

      {showingLetter && faces ? (
        <div className="absolute inset-0 overflow-y-auto overscroll-contain">
          <h2 id={headlineId} className="sr-only">{INTRO_LETTER.headline}</h2>
          <p id={letterId} className="sr-only">{INTRO_LETTER_SPOKEN}</p>
          <div className="mx-auto flex min-h-full w-full max-w-[28rem] flex-col px-8 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1.75rem,env(safe-area-inset-top))] sm:justify-center sm:py-12">
            <div ref={noteRef} aria-hidden className="my-auto py-7 sm:my-0 sm:py-0">
              <p
                ref={headRef}
                className="text-[30px] leading-[36px] tracking-[-0.013em] sm:text-[36px] sm:leading-[42px]"
                style={{ fontFamily: display, fontWeight: 800 }}
              >
                {INTRO_LETTER.headline}
              </p>
              <p ref={bodyRef} className="mt-[18px] max-w-[22.5rem] text-[17px] leading-[27px] text-[var(--ui-text-secondary)] sm:text-lg sm:leading-[29px]">
                {INTRO_LETTER.bodyBefore}
                {/* The name in the logo's two colours: the coral of its spark, the lavender of its pages. */}
                <span className="font-bold text-[var(--ui-primary)]">{INTRO_LETTER.name[0]}</span>{' '}
                <span className="font-bold text-[var(--ui-accent-motion)]">{INTRO_LETTER.name[1]}</span>
                {INTRO_LETTER.bodyAfter}
              </p>
              <div className="mt-[22px]">
                <span ref={signWindowRef} className="inline-block overflow-hidden align-top">
                  {/* Room on the right for the handwriting's slant, inside the window that writes it. */}
                  <span
                    ref={signInnerRef}
                    className="block whitespace-nowrap pr-2 text-[34px] leading-[40px] text-[var(--ui-primary)] sm:text-[40px] sm:leading-[48px]"
                    style={{ fontFamily: handwriting, fontWeight: 700 }}
                  >
                    — {INTRO_LETTER.name[0]} <span className="text-[var(--ui-accent-motion)]">{INTRO_LETTER.name[1]}</span>
                  </span>
                </span>
              </div>
            </div>
            <div ref={actionRef} className="-mx-2 sm:mx-0 sm:mt-10">
              <button
                ref={continueRef}
                type="button"
                inert={!letterRead}
                onClick={leave}
                className="ui-button ui-button-primary ui-focus-ring w-full"
                style={{ minHeight: 56, fontSize: 17, fontFamily: display }}
              >
                {INTRO_LETTER.action}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
