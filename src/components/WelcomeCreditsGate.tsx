'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

import { pushToast } from '@/components/feedback-state';
import { describeReferralClaim } from '@/lib/referral-claim-copy';
import { supabase } from '@/lib/supabase';
import {
  isWelcomeAnswerSettled,
  isWelcomeSettledHere,
  rememberWelcomePopupClosed,
  rememberWelcomeSettled,
  WELCOME_OFFER_CHANGED_EVENT,
  wasWelcomePopupClosedThisSession,
  type WelcomeReturn,
} from '@/lib/welcome-credits-popup';
import { readWelcomeCredits, type WelcomeCreditAnswer } from '@/lib/welcome-credits-requests';

import { shouldShowWelcomePopup } from '../../ugc-mobile/lib/welcome-popup-policy/welcome-popup-policy';

// The card, its claim and its confetti load only for an account it is offered to.
const WelcomeCreditsPopup = dynamic(() => import('./WelcomeCreditsPopup'), { ssr: false, loading: () => null });

/** An answer read for one account, kept for half a minute: moving between the pages that offer it asks once. */
type Answer = { userId: string; welcome: WelcomeCreditAnswer; readAt: number; asked: number };
const ANSWER_KEPT_MS = 30_000;

type Offer = { userId: string; amount: number; referral: string | null };

/**
 * Whether the welcome popup is up for the account signed in here, on the page
 * in front (owner, 2026-11-09). The shared rule decides
 * (`shouldShowWelcomePopup`): a signed-in account with its creator name and
 * its credits still to claim, on a page that offers it, not closed this
 * browser session. Once offered it stays until it is closed or the account
 * changes, whatever page a Back brings up under it.
 *
 * The answer is asked of the server only where the popup could show, and not
 * at all for an account this browser knows has claimed (`isWelcomeSettledHere`)
 * or closed it this session. An invite's outcome brought by a sign-up is said
 * inside the popup, or as a toast where none is offered.
 */
export default function WelcomeCreditsGate({ offeredHere, returned }: {
  /** The page in front offers it (Home, a creator, the page a sign-up returned to). */
  offeredHere: boolean;
  /** This page is the one a sign-up returned to, with the invite's outcome it brought. */
  returned: WelcomeReturn | null;
}) {
  const [userId, setUserId] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [asked, setAsked] = useState(0);
  // Each page a sign-up returned to says its invite's outcome once.
  const told = useRef<WelcomeReturn | null>(null);

  // The account signed in here: the session now, and every change to it.
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setUserId(data.session?.user?.id ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  // A creator name saved without a new page: the answer may have changed.
  useEffect(() => {
    const askAgain = () => setAsked((count) => count + 1);
    window.addEventListener(WELCOME_OFFER_CHANGED_EVENT, askAgain);
    return () => window.removeEventListener(WELCOME_OFFER_CHANGED_EVENT, askAgain);
  }, []);

  const quietHere = userId !== null && (wasWelcomePopupClosedThisSession(userId) || isWelcomeSettledHere(userId));
  const answerHere = answer && answer.userId === userId ? answer : null;
  // The last answer read, consulted (not followed) by the read below.
  const kept = useRef<Answer | null>(null);

  useEffect(() => {
    if (!offeredHere || !userId || quietHere) return;
    const last = kept.current;
    if (last && last.userId === userId && last.asked === asked && Date.now() - last.readAt < ANSWER_KEPT_MS) return;
    let active = true;
    void readWelcomeCredits()
      .then((welcome) => {
        if (isWelcomeAnswerSettled(welcome.status)) rememberWelcomeSettled(userId);
        const next = { userId, welcome, readAt: Date.now(), asked };
        kept.current = next;
        if (active) setAnswer(next);
      })
      .catch(() => {
        // Unread: nothing is offered on this page; the next one asks again.
        if (active) setAnswer(null);
      });
    return () => {
      active = false;
    };
  }, [offeredHere, userId, quietHere, asked]);

  const welcome = answerHere?.welcome ?? null;
  const show = shouldShowWelcomePopup({ signedIn: userId !== null, welcome, offeredHere, dismissed: quietHere });

  // Latched once offered, so the claim (which turns the answer to "claimed")
  // does not take the card away mid-celebration; an account change takes it.
  if (show && userId && welcome && (!offer || offer.userId !== userId)) {
    setOffer({ userId, amount: welcome.amount, referral: returned?.referral ?? null });
  } else if (offer && offer.userId !== userId) {
    setOffer(null);
  }

  // An invite's outcome on a page that offers no popup: a toast says it.
  const decided = userId !== null && (quietHere || answerHere !== null);
  useEffect(() => {
    if (!returned?.referral || told.current === returned || !decided || offer) return;
    told.current = returned;
    const line = describeReferralClaim(returned.referral);
    if (line) pushToast({ tone: returned.referral === 'applied' ? 'success' : 'info', message: line, durationMs: 8_000 });
  }, [returned, decided, offer]);

  if (!offer) return null;
  return (
    <WelcomeCreditsPopup
      key={offer.userId}
      amount={offer.amount}
      referral={offer.referral}
      onClose={() => rememberWelcomePopupClosed(offer.userId)}
      onAnswer={(result) => {
        if (isWelcomeAnswerSettled(result.status)) rememberWelcomeSettled(offer.userId);
        const next = { userId: offer.userId, welcome: result, readAt: Date.now(), asked };
        kept.current = next;
        setAnswer(next);
      }}
      onGone={() => setOffer(null)}
    />
  );
}
