'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X } from 'lucide-react';
import clsx from 'clsx';

import { getAccentClasses } from '@/components/DesignSystem';
import GoogleSignInAgreement from '@/components/GoogleSignInAgreement';
import { useInertPageBeneath } from '@/components/useInertPageBeneath';
import { useModalQuestion } from '@/components/useModalQuestion';
import { describeAuthError } from '@/lib/auth-error-copy';
import { getAuthCallbackUrl } from '@/lib/auth-callback-url';
import { creatorSignUpReturnPath } from '@/lib/auth-onboarding';
import { markVisitorDraftForHandover } from '@/lib/creator-visitor-draft';
import type { CreatorDraftTool } from '@/lib/persisted-media';
import { supabase } from '@/lib/supabase';

/** What a signed-out visitor pressed that needs an account. */
export type CreatorSignUpReason = 'generate' | 'enhance' | 'prepare';

const TITLES: Record<CreatorSignUpReason, string> = {
  generate: 'Continue to generate',
  enhance: 'Continue to enhance your prompt',
  prepare: 'Continue to prepare your references',
};

/**
 * What signing up gives, in the sheet's words: the welcome credits (which come
 * with a name and handle, asked for on the way back) and whether they cover the
 * run on screen. Either way the visitor comes back to the page and nothing runs
 * by itself.
 */
export function creatorSignUpBody(welcomeCredits: number | null, runCost: number | null): string {
  const back = 'Either way you come back to this page, and nothing runs until you press Generate.';
  if (welcomeCredits === null) {
    return `Sign in with Google, or make an account with it. ${back}`;
  }
  const enough = runCost !== null && runCost <= welcomeCredits ? `, enough for this ${runCost}-credit run` : '';
  return `New here? You get ${welcomeCredits} free credits when you pick a name and handle${enough}. ${back}`;
}

const FOCUSABLE = 'a[href], button:not([disabled])';

type CreatorSignUpSheetProps = {
  /** What was pressed, or null while the sheet is closed. */
  reason: CreatorSignUpReason | null;
  tool: CreatorDraftTool;
  /**
   * The page's draft is the visitor's, so leaving marks it for the account. A page
   * whose session ended keeps its account's draft under the account already.
   */
  handsOverDraft: boolean;
  welcomeCredits: number | null;
  runCost: number | null;
  /** The run's model and its settings chip ("Seedance 2 Mini", "480P · 9:16 · 5s"), as the run's own label reads them. */
  modelName: string;
  settingsSummary: string;
  keepsPrompt: boolean;
  keepsImages: boolean;
  onClose: () => void;
};

/**
 * The sign-up a signed-out visitor meets at Generate (owner, 2026-10-28): the
 * creator works without an account up to there. It says what stays (the
 * prompt, the settings, the pictures) and that nothing runs until Generate is
 * pressed again. Leaving for sign-in marks this creator's draft for the account
 * with a one-time nonce that the way back carries (`creator-visitor-draft.ts`).
 *
 * New accounts are made with Google only on the web (the login page says why);
 * the few password accounts sign in on the login page and come back the same
 * way. Apple on the web is a later task.
 */
export default function CreatorSignUpSheet(props: CreatorSignUpSheetProps) {
  if (props.reason === null || typeof document === 'undefined') return null;
  return createPortal(<CreatorSignUpPanel {...props} reason={props.reason} />, document.body);
}

function CreatorSignUpPanel({
  reason,
  tool,
  handsOverDraft,
  welcomeCredits,
  runCost,
  modelName,
  settingsSummary,
  keepsPrompt,
  keepsImages,
  onClose,
}: CreatorSignUpSheetProps & { reason: CreatorSignUpReason }) {
  const router = useRouter();
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const agreementId = `${id}-agreement`;
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const googleRef = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState<'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // First: the focus useModalQuestion gives back as the sheet goes does nothing
  // while the page beneath is still inert, and effects are undone in order.
  useInertPageBeneath(overlayRef);
  useModalQuestion({
    questionId: 1,
    dialogRef: panelRef,
    initialFocus: () => googleRef.current,
    focusables: () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    onCancel: () => {
      if (!leaving) onClose();
    },
  });

  // A page the browser restores after leaving for Google (Back from its account
  // chooser) comes back with the sheet as it was left; it is usable again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(null);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  /** This page to come back to, marked for the hand-over when the draft is the visitor's. */
  const returnPath = () => creatorSignUpReturnPath(
    `${window.location.pathname}${window.location.search}`,
    handsOverDraft ? markVisitorDraftForHandover(tool) : null,
  );

  const continueWithGoogle = async () => {
    setLeaving('google');
    setError(null);
    try {
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: getAuthCallbackUrl(returnPath()) },
      });
      if (signInError) throw signInError;
    } catch (signInError) {
      setError(describeAuthError(signInError, 'Could not start Google sign-in. Try again.'));
      setLeaving(null);
    }
  };

  const signInWithEmail = () => {
    setLeaving('email');
    router.push(`/login?returnUrl=${encodeURIComponent(returnPath())}`);
  };

  const keeps = [
    keepsPrompt ? 'Your prompt stays' : null,
    `Your settings stay: ${[modelName, settingsSummary].filter(Boolean).join(' · ')}`,
    keepsImages ? 'Images you added stay' : null,
  ].filter((line): line is string => line !== null);

  return (
    <div
      ref={overlayRef}
      className="ui-confirm-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !leaving) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="ui-confirm-dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="ui-confirm-title">{TITLES[reason]}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={leaving !== null}
            aria-label="Close"
            title="Close"
            className="ui-icon-button ui-focus-ring -mr-2 -mt-2 shrink-0 disabled:opacity-50"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
        <p id={bodyId} className="ui-confirm-message">
          {creatorSignUpBody(welcomeCredits, runCost)}
        </p>
        <ul className="mt-4 space-y-2">
          {keeps.map((line) => (
            <li key={line} className="flex items-start gap-2.5 text-sm leading-6 text-[var(--ui-text-primary)]">
              <Check aria-hidden className={clsx('mt-1 h-4 w-4 shrink-0', getAccentClasses('workflow').mark)} />
              {line}
            </li>
          ))}
        </ul>
        {error ? <p role="alert" className="mt-4 text-sm leading-6 text-[var(--ui-accent-danger)]">{error}</p> : null}
        <div className="mt-6 flex flex-col gap-3">
          <button
            ref={googleRef}
            type="button"
            onClick={() => void continueWithGoogle()}
            disabled={leaving !== null}
            aria-describedby={agreementId}
            className="ui-button ui-button-primary ui-focus-ring w-full"
          >
            {leaving === 'google' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
            Continue with Google
          </button>
          <button
            type="button"
            onClick={signInWithEmail}
            disabled={leaving !== null}
            className="ui-button ui-button-secondary ui-focus-ring w-full"
          >
            {leaving === 'email' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
            Sign in with email and password
          </button>
        </div>
        <p className="mt-4 text-xs leading-5 text-[var(--ui-text-muted)]">
          Already have an account? Google signs you in too.
        </p>
        <GoogleSignInAgreement id={agreementId} className="mt-1 text-xs leading-5 text-[var(--ui-text-muted)]" />
      </div>
    </div>
  );
}
