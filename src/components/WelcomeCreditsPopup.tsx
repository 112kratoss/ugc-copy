'use client';

import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { useAuth } from '@/components/AuthProvider';
import ClaimConfetti from '@/components/ClaimConfetti';
import { useInertPageBeneath } from '@/components/useInertPageBeneath';
import { useModalQuestion } from '@/components/useModalQuestion';
import { describeReferralClaim } from '@/lib/referral-claim-copy';
import { nextWelcomeFill, welcomeEntrySpring } from '@/lib/welcome-credits-popup';
import { claimWelcomeCredits, type WelcomeCreditAnswer } from '@/lib/welcome-credits-requests';

import { CLAIM_CONFETTI_MS, type ClaimOrigin } from '../../ugc-mobile/lib/claim-confetti-flight/claim-confetti-flight';

/** `failed` offers a retry; `refused` is the server's final no, with only Close left. */
type Phase = 'offer' | 'claiming' | 'claimed' | 'failed' | 'refused';

/** The ring around the badge: its box, the track's radius and its stroke. */
const RING_SIZE = 108;
const RING_STROKE = 5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const ENTRY_SCALE = 0.9;
const ENTRY_SPRING = welcomeEntrySpring();
const DIM_IN_MS = 180;
/**
 * The way out (owner, 2026-11-09: "as the confetti is popping the pop up is
 * closing down smoothly"): a beat after the figure lands and the confetti
 * bursts, the dim fades while the card and its Close sink back and fade on one
 * even ease-in-out. The confetti is drawn outside the fading card and keeps
 * falling over the page; the popup goes only once the last piece has.
 */
const EXIT_AFTER_LANDING_MS = 260;
const EXIT_MS = 420;
const EXIT_SCALE = 0.92;
const EXIT_DROP = 24;
const EXIT_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
/** Under reduced motion there is no fill and no confetti: the card holds to be read. */
const EXIT_AFTER_LANDING_STILL_MS = 1400;
/** The figure's and the badge's pop as the count lands: up fast (ease-out quad), then a springy settle. */
const POP_SCALE = 1.16;
const POP_UP_MS = 120;
const POP_SETTLE_MS = 460;
const POP_UP_EASE = 'cubic-bezier(0.5, 1, 0.89, 1)';
const POP_SETTLE_EASE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

const OFFER_NOTE = 'A welcome gift for creating images, video and motion. It can only be used for creating media, not to buy recipes or resources.';
const REFUSED_MESSAGE = 'These credits can’t be claimed on this account.';
const FAILED_MESSAGE = 'Your credits could not be added. Try again.';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Plays a Web Animations keyframe list where the browser has the API; elsewhere nothing moves. */
function animate(element: Element | null, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  return element && typeof element.animate === 'function' ? element.animate(keyframes, options) : null;
}

/**
 * The welcome-credits popup, the app's (`ugc-mobile/components/welcome-credits-popup.tsx`)
 * on the web (owner, 2026-11-09: "all the design and functionalities also").
 *
 * A white card over the dimmed page: a coral badge inside a ring, the credits
 * as a large figure under it, the title, the note and Claim, with the shared
 * Close below. On Claim the ring fills and the figure counts up from 0 as a
 * game's counter does, fast off the mark and slowing into the landing, never
 * more than a credit a frame; as it lands the figure and the badge pop, the
 * header's balance moves, and confetti bursts out of the figure while the
 * card sinks away beneath it. A failed claim keeps the card with "Try again";
 * the server's final no leaves only Close. Nothing moves under reduced motion.
 *
 * While it is up the page beneath is inert and takes no scroll, the focus
 * stays in the card and its Close, and Escape closes it whenever Close would
 * (`useInertPageBeneath`, `useModalQuestion`). Who sees it and where is the
 * gate's (`WelcomeCreditsGate`).
 */
export default function WelcomeCreditsPopup({ amount: offeredAmount, referral, onClose, onAnswer, onGone }: {
  amount: number;
  /** The invite's outcome the sign-up brought to this page, said under the note. */
  referral: string | null;
  /** Closed by the person or after a claim: remembered for the browser session. */
  onClose: () => void;
  /** The claim's answer, for the gate to remember a settled account. */
  onAnswer: (answer: WelcomeCreditAnswer) => void;
  /** Off the page, the last confetti fallen. */
  onGone: () => void;
}) {
  const { updateCredits } = useAuth();
  const titleId = useId();
  const noteId = useId();
  const [reducedMotion] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<Phase>('offer');
  const [message, setMessage] = useState<string | null>(null);
  // What the claim granted: the fill's target, once the server has answered.
  const [granted, setGranted] = useState<number | null>(null);
  // How far the fill has got, 0..1, and the credits shown so far.
  const [fill, setFill] = useState(0);
  const [count, setCount] = useState(0);
  // Where the figure sits in the window: the confetti bursts out of it.
  const [origin, setOriginState] = useState<ClaimOrigin | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [leaving, setLeaving] = useState(false);
  const amount = granted ?? offeredAmount;
  const claimed = phase === 'claimed';
  const landed = claimed && count >= amount;
  // While the claim is in flight or filling, neither Close nor Escape may take
  // the card away: a failed claim would land on a card no longer there.
  const busy = phase === 'claiming' || (claimed && !landed);
  const referralLine = describeReferralClaim(referral);

  const overlayRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  const figureRef = useRef<HTMLDivElement>(null);
  const numberRef = useRef<HTMLSpanElement>(null);
  const claimRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const originRef = useRef<ClaimOrigin | null>(null);
  const frameRef = useRef<number | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const goneTimer = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
  const leavingRef = useRef(false);
  const busyRef = useRef(busy);
  // The new balance, held back until the figure lands so the header moves with it.
  const pendingBalance = useRef<number | null>(null);
  // When the last piece of confetti will have fallen (0 when none is flying).
  const confettiEndsAt = useRef(0);
  const latest = useRef({ onClose, onGone });
  useEffect(() => {
    latest.current = { onClose, onGone };
    busyRef.current = busy;
  });

  const setOrigin = (next: ClaimOrigin | null) => {
    originRef.current = next;
    setOriginState(next);
  };

  // The burst starts a little above the figure's centre.
  const measureFigure = () => {
    const box = figureRef.current?.getBoundingClientRect();
    setOrigin(box && box.width > 0 ? { x: box.left + box.width / 2, y: box.top + box.height * 0.4 } : null);
  };

  useEffect(() => {
    // Set here, not only at first render: React runs this cleanup once at mount
    // in development (StrictMode) and may again as it hides and restores a tree.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(goneTimer.current);
      // A fill cut short (an account switch, a sign-out): the claim is in, so the
      // balance is read again for whoever is signed in now. Never this account's
      // figure: it would be drawn over the next account's.
      if (pendingBalance.current !== null) window.dispatchEvent(new Event('credits_updated'));
    };
  }, []);

  // The entrance: the dim fades in, the card springs up from 0.9 as the app's does.
  useEffect(() => {
    if (reducedMotion) return;
    animate(dimRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: DIM_IN_MS, easing: 'ease-out' });
    const frames = ENTRY_SPRING.progress.map((progress, index) => ({
      offset: index / (ENTRY_SPRING.progress.length - 1),
      opacity: Math.min(1, progress),
      transform: `scale(${(ENTRY_SCALE + (1 - ENTRY_SCALE) * progress).toFixed(4)})`,
    }));
    animate(cardRef.current, frames, { duration: ENTRY_SPRING.durationMs, easing: 'linear' });
  }, [reducedMotion]);

  // The pop as the count lands.
  useEffect(() => {
    if (!landed || reducedMotion) return;
    const pop: Keyframe[] = [
      { transform: 'scale(1)', easing: POP_UP_EASE },
      { transform: `scale(${POP_SCALE})`, offset: POP_UP_MS / (POP_UP_MS + POP_SETTLE_MS), easing: POP_SETTLE_EASE },
      { transform: 'scale(1)' },
    ];
    const timing = { duration: POP_UP_MS + POP_SETTLE_MS };
    const pops = [animate(badgeRef.current, pop, timing), animate(numberRef.current, pop, timing)];
    return () => pops.forEach((animation) => animation?.cancel());
  }, [landed, reducedMotion]);

  // The server's final no takes Claim away: the focus goes to Close.
  useEffect(() => {
    if (phase === 'refused') closeRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const close = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    window.clearTimeout(closeTimer.current);
    latest.current.onClose();
    // The page is given back at once, the confetti still falling over it.
    setLeaving(true);
    const timing: KeyframeAnimationOptions = { duration: EXIT_MS, easing: EXIT_EASE, fill: 'forwards' };
    const exits = reducedMotion ? [] : [
      animate(dimRef.current, [{ opacity: 1 }, { opacity: 0 }], timing),
      animate(stackRef.current, [
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: `translateY(${EXIT_DROP}px) scale(${EXIT_SCALE})` },
      ], timing),
    ].filter((animation): animation is Animation => animation !== null);
    if (exits.length === 0) {
      latest.current.onGone();
      return;
    }
    void Promise.all(exits.map((animation) => animation.finished)).catch(() => undefined).then(() => {
      const remaining = confettiEndsAt.current - performance.now();
      if (remaining <= 0) latest.current.onGone();
      else goneTimer.current = window.setTimeout(() => latest.current.onGone(), remaining);
    });
  };

  const land = (to: number) => {
    setFill(1);
    setCount(to);
    // Measured again as it lands: the burst comes out of the figure where it is now.
    measureFigure();
    if (pendingBalance.current !== null) {
      updateCredits(pendingBalance.current);
      pendingBalance.current = null;
    }
    if (reducedMotion) {
      closeTimer.current = window.setTimeout(close, EXIT_AFTER_LANDING_STILL_MS);
      return;
    }
    // No origin (the figure could not be measured): no burst, nothing to wait for.
    confettiEndsAt.current = originRef.current ? performance.now() + CLAIM_CONFETTI_MS + 100 : 0;
    closeTimer.current = window.setTimeout(close, EXIT_AFTER_LANDING_MS);
  };

  const fillUp = (to: number) => {
    if (reducedMotion) {
      land(to);
      return;
    }
    let started: number | null = null;
    let shown = 0;
    setFill(0);
    setCount(0);
    const frame = (now: number) => {
      started ??= now;
      const next = nextWelcomeFill({ elapsed: now - started, amount: to, shown });
      shown = next.count;
      if (next.done) {
        frameRef.current = null;
        land(to);
        return;
      }
      setFill(next.fill);
      setCount(next.count);
      frameRef.current = window.requestAnimationFrame(frame);
    };
    frameRef.current = window.requestAnimationFrame(frame);
  };

  const claim = async () => {
    if (phase === 'claiming' || claimed || phase === 'refused' || leavingRef.current) return;
    measureFigure();
    setPhase('claiming');
    setMessage(null);
    try {
      const result = await claimWelcomeCredits();
      onAnswer(result);
      // Gone meanwhile: the claim is recorded for the account that made it,
      // and whoever is signed in now has the balance read again.
      if (!mountedRef.current) {
        if (result.status === 'claimed') window.dispatchEvent(new Event('credits_updated'));
        return;
      }
      if (result.status === 'claimed' || result.status === 'already_claimed') {
        if (result.status === 'claimed') pendingBalance.current = result.credits;
        // Claimed before (another tab): the balance after that grant may be
        // stale by now, so the page reads it again.
        else window.dispatchEvent(new Event('credits_updated'));
        setGranted(result.amount);
        setPhase('claimed');
        setAnnouncement(`${result.amount} credits added to your balance.`);
        fillUp(result.amount);
      } else {
        // The server's final answer: nothing to retry.
        setPhase('refused');
        setMessage(REFUSED_MESSAGE);
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setPhase('failed');
      setMessage(error instanceof Error && error.message ? error.message : FAILED_MESSAGE);
    }
  };

  const title = landed ? 'Credits added!' : claimed ? 'Adding your credits' : 'Claim your welcome credits';
  const note = landed
    ? 'They’re in your balance now. Go make something amazing.'
    : claimed
      ? 'Counting them into your balance…'
      : OFFER_NOTE;

  return createPortal(
    <div ref={overlayRef} className="ui-welcome-popup" data-leaving={leaving ? '' : undefined}>
      {leaving ? null : (
        <ModalHold
          overlayRef={overlayRef}
          dialogRef={stackRef}
          initialFocus={() => claimRef.current ?? closeRef.current}
          focusables={() => [claimRef.current, closeRef.current].filter((control): control is HTMLButtonElement => (
            control !== null && control.isConnected && !control.disabled
          ))}
          onCancel={() => {
            if (!busyRef.current) close();
          }}
        />
      )}
      <div ref={dimRef} className="ui-welcome-dim" aria-hidden />
      <div
        ref={stackRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={noteId}
        className="ui-welcome-stack"
      >
        <div ref={cardRef} className="ui-welcome-card">
          <div className="ui-welcome-ring">
            <FillRing fill={claimed ? fill : 0} />
            <div ref={badgeRef} className="ui-welcome-badge">
              <Sparkles aria-hidden className="ui-welcome-badge-icon" />
            </div>
          </div>

          <div ref={figureRef} className="ui-welcome-figure">
            <span ref={numberRef} aria-hidden className="ui-welcome-figure-number" data-claimed={claimed ? '' : undefined}>
              {claimed ? `+${count}` : amount}
            </span>
            <span aria-hidden className="ui-welcome-figure-label">creation credits</span>
            <span className="ui-welcome-visually-hidden">{`${amount} creation credits`}</span>
          </div>

          <KeepFirstHeight>
            <h2 id={titleId} className="ui-welcome-title">{title}</h2>
          </KeepFirstHeight>
          <KeepFirstHeight>
            <p id={noteId} className="ui-welcome-note">{note}</p>
          </KeepFirstHeight>
          {referralLine ? <p className="ui-welcome-referral">{referralLine}</p> : null}

          {message ? <p role="alert" className="ui-welcome-message">{message}</p> : null}

          {claimed ? (
            <div className="ui-welcome-added">
              <Check aria-hidden className="ui-welcome-added-icon" />
              <span>{landed ? 'Added to your balance' : 'Adding to your balance'}</span>
            </div>
          ) : phase === 'refused' ? null : (
            <button
              ref={claimRef}
              type="button"
              aria-disabled={phase === 'claiming' ? true : undefined}
              className="ui-button ui-button-primary ui-welcome-claim"
              onClick={() => void claim()}
            >
              {phase === 'claiming' ? (
                <>
                  <Loader2 aria-hidden className="ui-welcome-spinner" />
                  Claiming…
                </>
              ) : phase === 'failed' ? 'Try again' : 'Claim'}
            </button>
          )}
          <span role="status" aria-live="polite" className="ui-welcome-visually-hidden">{announcement}</span>
        </div>

        {/* The way out, below the card as on the app: the shared Close on a white disc. */}
        <button
          ref={closeRef}
          type="button"
          aria-label="Close"
          title="Close"
          disabled={busy}
          className="ui-welcome-close"
          onClick={close}
        >
          <X aria-hidden className="ui-welcome-close-icon" />
        </button>
      </div>
      {/* Over the whole window, outside the sinking card. */}
      <ClaimConfetti ready={!reducedMotion && (phase === 'claiming' || claimed)} play={!reducedMotion && landed} origin={origin} />
    </div>,
    document.body,
  );
}

/**
 * What the popup holds while it is up: the page beneath inert and still, and
 * the keys (Tab cycles its controls, Escape and a Back away from the page ask
 * it to close). Let go the moment it starts to leave, so the page is the
 * person's again while the confetti falls.
 */
function ModalHold({ overlayRef, dialogRef, initialFocus, focusables, onCancel }: {
  overlayRef: RefObject<HTMLDivElement | null>;
  dialogRef: RefObject<HTMLDivElement | null>;
  initialFocus: () => HTMLElement | null;
  focusables: () => HTMLElement[];
  onCancel: () => void;
}) {
  useInertPageBeneath(overlayRef);
  useModalQuestion({ questionId: 1, dialogRef, initialFocus, focusables, onCancel });
  return null;
}

/**
 * A block that keeps the height it first had: the shorter claimed words must
 * not shrink the card and move the figure under the burst.
 */
function KeepFirstHeight({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Written straight to the block before the first paint: React never draws a style here.
  useLayoutEffect(() => {
    const block = ref.current;
    const measured = block?.getBoundingClientRect().height;
    if (block && measured) block.style.minHeight = `${measured}px`;
  }, []);
  return <div ref={ref} className="ui-welcome-keep">{children}</div>;
}

/**
 * The ring around the badge: a peach track, and the coral fill sweeping round
 * it clockwise from the top with the count, drawn from the fill's value so it
 * moves with the figure under it frame for frame.
 */
function FillRing({ fill }: { fill: number }) {
  const centre = RING_SIZE / 2;
  const share = Math.min(1, Math.max(0, fill));
  return (
    <svg aria-hidden width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} className="ui-welcome-ring-track">
      <circle cx={centre} cy={centre} r={RING_RADIUS} className="ui-welcome-ring-rest" strokeWidth={RING_STROKE} fill="none" />
      {share > 0 ? (
        <circle
          cx={centre}
          cy={centre}
          r={RING_RADIUS}
          className="ui-welcome-ring-fill"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${RING_LENGTH} ${RING_LENGTH}`}
          strokeDashoffset={RING_LENGTH * (1 - share)}
          transform={`rotate(-90 ${centre} ${centre})`}
        />
      ) : null}
    </svg>
  );
}
