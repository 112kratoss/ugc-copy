'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, X } from 'lucide-react';

import { describeAuthError } from '@/lib/auth-error-copy';
import { getAuthCallbackUrl } from '@/lib/auth-callback-url';
import { CREATOR_WELCOME_PARAM } from '@/lib/auth-onboarding';
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

/** This page's address to come back to, without the flags of an earlier return. */
function returnPath() {
  const url = new URL(window.location.href);
  url.searchParams.delete(CREATOR_WELCOME_PARAM);
  url.searchParams.delete('referral');
  return `${url.pathname}${url.search}`;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The sign-up a signed-out visitor meets at Generate (owner, 2026-10-28): the
 * creator works without an account up to there. It says what stays (the
 * prompt, the settings, the pictures) and that nothing runs until Generate is
 * pressed again. Before leaving for Google it marks this creator's draft for
 * the account (`markVisitorDraftForHandover`), which takes it on the way back.
 *
 * New accounts are made with Google only on the web (the login page says why);
 * the few password accounts sign in on the login page and come back the same
 * way. Apple on the web is a later task.
 */
export default function CreatorSignUpSheet({
  open,
  reason,
  tool,
  welcomeCredits,
  runCost,
  settingsLine,
  keepsPrompt,
  keepsImages,
  onClose,
}: {
  open: boolean;
  reason: CreatorSignUpReason;
  tool: CreatorDraftTool;
  welcomeCredits: number | null;
  runCost: number | null;
  /** The run's model and settings, as the list says they stay: "Seedance 2 Mini, 480P, 9:16, 5s". */
  settingsLine: string | null;
  keepsPrompt: boolean;
  keepsImages: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const googleRef = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState<'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keys stay in the sheet while it is up: Escape closes it, Tab goes round it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!leaving) onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [leaving, onClose, open]);

  // The page under it takes no press, no scroll and no reader's attention.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!open || !overlay) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const siblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay);
    const previous = siblings.map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }));
    siblings.forEach((element) => {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      previous.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) {
          element.removeAttribute('aria-hidden');
        } else {
          element.setAttribute('aria-hidden', ariaHidden);
        }
      });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    googleRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const continueWithGoogle = async () => {
    setLeaving('google');
    setError(null);
    try {
      markVisitorDraftForHandover(tool);
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
    markVisitorDraftForHandover(tool);
    router.push(`/login?returnUrl=${encodeURIComponent(returnPath())}`);
  };

  const keeps = [
    keepsPrompt ? 'Your prompt stays' : null,
    settingsLine ? `Your settings stay: ${settingsLine}` : null,
    keepsImages ? 'Images you added stay' : null,
  ].filter((line): line is string => line !== null);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={() => {
        if (!leaving) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="creator-sign-up-title"
        aria-describedby="creator-sign-up-body"
        onClick={(event) => event.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-ui-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-1)] p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-ui-panel sm:rounded-ui-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="creator-sign-up-title" className="pt-2 text-xl font-bold leading-7 text-[var(--ui-text-primary)]">
            {TITLES[reason]}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={leaving !== null}
            aria-label="Close"
            className="ui-focus-ring -mr-2 inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] text-[var(--ui-text-secondary)] transition-colors hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)] disabled:opacity-50"
          >
            <X aria-hidden className="h-5 w-5" />
          </button>
        </div>
        <p id="creator-sign-up-body" className="mt-3 text-sm leading-6 text-[var(--ui-text-secondary)]">
          {creatorSignUpBody(welcomeCredits, runCost)}
        </p>
        {keeps.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {keeps.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-sm leading-6 text-[var(--ui-text-primary)]">
                <Check aria-hidden className="mt-1 h-4 w-4 shrink-0 text-emerald-300" />
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <p role="alert" className="mt-4 text-sm text-[var(--ui-accent-danger)]">{error}</p> : null}
        <button
          ref={googleRef}
          type="button"
          onClick={() => void continueWithGoogle()}
          disabled={leaving !== null}
          className="ui-focus-ring mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ui-primary)] px-4 text-sm font-extrabold text-[var(--ui-primary-on)] transition-[background-color,transform] duration-150 hover:bg-[var(--ui-primary-strong)] active:scale-[0.98] disabled:cursor-wait disabled:opacity-70"
        >
          {leaving === 'google' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
          Continue with Google
        </button>
        <button
          type="button"
          onClick={signInWithEmail}
          disabled={leaving !== null}
          className="ui-focus-ring mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-[var(--ui-border-default)] px-4 text-sm font-bold text-[var(--ui-text-primary)] transition-colors hover:bg-[var(--ui-surface-3)] disabled:cursor-wait disabled:opacity-70"
        >
          {leaving === 'email' ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
          Sign in with email and password
        </button>
        <p className="mt-4 text-xs leading-5 text-[var(--ui-text-muted)]">
          Already have an account? Google signs you in too. By continuing you agree to the{' '}
          <Link href="/terms" className="font-semibold text-[var(--ui-text-secondary)] underline underline-offset-2 hover:text-[var(--ui-text-primary)]">Terms</Link>
          {' '}and the{' '}
          <Link href="/privacy" className="font-semibold text-[var(--ui-text-secondary)] underline underline-offset-2 hover:text-[var(--ui-text-primary)]">Privacy Policy</Link>.
        </p>
      </div>
    </div>,
    document.body,
  );
}
