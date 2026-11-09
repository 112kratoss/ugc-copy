'use client';

import { useEffect, useRef, type CSSProperties } from 'react';

import {
  CLAIM_CONFETTI_TONES,
  CONFETTI_FLUTTER_STEPS,
  CONFETTI_OPACITY,
  CONFETTI_OPACITY_STEPS,
  claimConfettiPieces,
  confettiFlutter,
  confettiPathSteps,
  type ClaimOrigin,
  type ConfettiPiece,
} from '../../ugc-mobile/lib/claim-confetti-flight/claim-confetti-flight';

/** The five tones in the app's light palette (`ugc-mobile/lib/theme.ts`), which the card is drawn in. */
export const CLAIM_CONFETTI_COLOURS: Record<(typeof CLAIM_CONFETTI_TONES)[number], string> = {
  primaryFill: '#ff7a59',
  navigationCreateTop: '#ffa463',
  navigationCreateBottom: '#f4552a',
  selectedStrong: '#f6d2c4',
  surfaceInset: '#ffffff',
};

const PIECES = claimConfettiPieces();

/**
 * One piece's flight as the Web Animations API plays it, from the shared
 * samples: its place and its fade on the outer element, its turn and its
 * tumble on the inner one, so the turn happens about the piece's own centre
 * wherever it is (the app's transform order: translate, then rotate, then
 * scaleX). Every pair of keyframes is joined linearly, as the native driver
 * joins the app's interpolation steps.
 */
export function claimConfettiKeyframes(piece: ConfettiPiece) {
  const steps = confettiPathSteps(piece);
  const flutter = confettiFlutter(piece);
  return {
    move: piece.path.map((point, index) => ({ offset: steps[index], transform: `translate(${point.x}px, ${point.y}px)` })),
    fade: CONFETTI_OPACITY_STEPS.map((offset, index) => ({ offset, opacity: CONFETTI_OPACITY[index] })),
    tumble: CONFETTI_FLUTTER_STEPS.map((offset, index) => ({
      offset,
      transform: `rotate(${Math.round(piece.spin * offset * 100) / 100}deg) scaleX(${Math.round(flutter[index] * 1000) / 1000})`,
    })),
  };
}

/**
 * The claim's confetti over the whole window (owner, 2026-11-09: "a similar
 * premium feel which gives the user a satisfaction of gaining something"):
 * `ready` mounts the 48 pieces, invisible, at the origin, with their flights
 * built and paused, while the fill runs; `play` throws them all at once as the
 * figure lands. Transforms and opacity only, so the browser composites every
 * frame; nothing under reduced motion (the popup never readies it then), and
 * nothing in a browser without the Web Animations API. Not touchable, and
 * hidden from assistive technology.
 */
export default function ClaimConfetti({ ready, play, origin }: { ready: boolean; play: boolean; origin: ClaimOrigin | null }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const animationsRef = useRef<Animation[]>([]);
  const mounted = (ready || play) && origin !== null;

  useEffect(() => {
    const layer = layerRef.current;
    if (!mounted || !layer) return;
    const outers = Array.from(layer.children) as HTMLElement[];
    const animations: Animation[] = [];
    PIECES.forEach((piece, index) => {
      const outer = outers[index];
      const inner = outer?.firstElementChild as HTMLElement | null;
      if (!outer || !inner || typeof outer.animate !== 'function') return;
      const frames = claimConfettiKeyframes(piece);
      const timing: KeyframeAnimationOptions = { duration: piece.duration, delay: piece.delay, easing: 'linear', fill: 'both' };
      for (const animation of [outer.animate(frames.move, timing), outer.animate(frames.fade, timing), inner.animate(frames.tumble, timing)]) {
        animation.pause();
        animations.push(animation);
      }
    });
    animationsRef.current = animations;
    return () => {
      animations.forEach((animation) => animation.cancel());
      animationsRef.current = [];
    };
  }, [mounted]);

  useEffect(() => {
    if (play) animationsRef.current.forEach((animation) => animation.play());
  }, [play, mounted]);

  if (!mounted || !origin) return null;

  return (
    <div
      ref={layerRef}
      aria-hidden
      className="ui-welcome-confetti"
      style={{ '--confetti-x': `${origin.x}px`, '--confetti-y': `${origin.y}px` } as CSSProperties}
    >
      {PIECES.map((piece, index) => (
        <span
          key={index}
          className="ui-welcome-confetti-piece"
          style={{ width: piece.width, height: piece.height, marginLeft: -piece.width / 2, marginTop: -piece.height / 2 }}
        >
          <span
            className={piece.shape === 'chip' ? 'ui-welcome-confetti-chip' : 'ui-welcome-confetti-round'}
            style={{ background: CLAIM_CONFETTI_COLOURS[CLAIM_CONFETTI_TONES[piece.tone]] }}
          />
        </span>
      ))}
    </div>
  );
}
