'use client';

import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { WandSparkles } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { Button, Kicker, Surface, Text } from '@/components/DesignSystem';
import { HANDLE_CHECK_DELAY_MS } from '@/components/useHandleAvailability';
import { withCreatorWelcome } from '@/lib/auth-onboarding';
import {
  creatorNameStepReducer,
  creatorNameStepShownCookie,
  describeHandleLine,
  HANDLE_JUST_CLAIMED_TEXT,
  initialCreatorNameStepState,
  isWellFormedHandle,
  localHandleRefusal,
  type CreatorNameStepStart,
  type HandleCheck,
  type HandleLine,
} from '@/lib/creator-name-step';
import { normalizeUsername } from '@/lib/profile';
import {
  checkHandleAvailability,
  claimPublicIdentity,
  shouldCheckHandleAvailability,
  validatePublicIdentity,
} from '@/lib/public-identity';
import { TYPED_INPUT_PROPS } from '@/lib/typed-before-hydration';
import { useTypedBeforeHydration } from '@/lib/use-typed-before-hydration';

/** The server's caps: `validateProfileUpdate` in src/lib/profile.ts. */
const DISPLAY_NAME_MAX_LENGTH = 60;
const HANDLE_MAX_LENGTH = 24;

/** Where the welcome credits are said: only while choosing a name is what still stands before them. */
const CREDITS_WAIT_ON_NAME: ReadonlySet<string> = new Set(['not_eligible', 'eligible']);

const FIELD_CLASS = 'ui-focus-ring block min-h-12 w-full rounded-2xl border border-[var(--ui-border-default)] bg-[var(--ui-surface-inset)] px-4 py-3 text-base text-[var(--ui-text-primary)] outline-none transition-colors placeholder:text-[var(--ui-text-faint)] focus:border-[var(--ui-focus)] disabled:opacity-60';

// The caption role's size and weight with one tone colour, never two (`Text`
// joins classes without merging them).
const LINE_TONE: Record<HandleLine['tone'], string> = {
  rule: 'text-[var(--ui-text-muted)]',
  checking: 'text-[var(--ui-text-muted)]',
  available: 'text-emerald-300',
  error: 'text-[var(--ui-accent-danger)]',
};

/** A full load of the next page, so it is drawn from the saved name (the shell's account, Home's reopen). */
function openPage(path: string) {
  window.location.replace(path);
}

/**
 * The live check Edit profile runs on a handle (`useHandleAvailability`), with
 * its answer handed to the step, which swaps a taken suggestion in the same
 * update that learns it. Asked once typing pauses; a check that failed
 * (offline, rate limited) is no verdict, and the save still judges.
 */
function useHandleCheckAnswers(
  question: string | null,
  displayName: string,
  accessToken: string | null,
  onAnswer: (handle: string, check: HandleCheck) => void,
) {
  const displayNameRef = useRef(displayName);
  const onAnswerRef = useRef(onAnswer);
  useEffect(() => {
    displayNameRef.current = displayName.trim();
    onAnswerRef.current = onAnswer;
  });

  useEffect(() => {
    if (!question || !accessToken) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void checkHandleAvailability({ username: question, displayName: displayNameRef.current }, accessToken, controller.signal)
        .then((verdict) => {
          if (!controller.signal.aborted) onAnswerRef.current(question, verdict ?? { state: 'idle' });
        });
    }, HANDLE_CHECK_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accessToken, question]);
}

function BrandLockup() {
  return (
    <div className="flex items-center justify-center gap-3 text-[var(--ui-text-primary)]">
      <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--ui-primary)] text-[var(--ui-primary-on)]">
        <WandSparkles className="h-5 w-5" strokeWidth={2.4} />
      </span>
      <span className="text-lg font-extrabold tracking-tight">Magic Booklet</span>
    </div>
  );
}

/**
 * The creator name a new account chooses, as the app's identity stage
 * (`ugc-mobile/app/onboarding.tsx`) asks for it: required, with "Save creator
 * name" the only way on (owner, 2026-11-08). The handle starts filled, follows
 * the name while it is the suggestion, and is swapped for `<handle>-NNN` when
 * the check finds it taken; the cursor in the handle field stops all of that.
 * Saved through the claim the composers use (`claimPublicIdentity`), with the
 * server checks of Edit profile.
 */
export default function CreatorNameStep({
  nextPath,
  userId,
  savedUsername,
  start,
}: {
  /** Where the account was going: opened with `welcome=1` once the name is saved. */
  nextPath: string;
  userId: string;
  /** The profile's stored handle, the signup placeholder until one is claimed. */
  savedUsername: string | null;
  start: CreatorNameStepStart;
}) {
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [state, dispatch] = useReducer(creatorNameStepReducer, start, initialCreatorNameStepState);
  const { displayName, username, saving } = state;
  // A save that failed for a reason other than the handle: the step then
  // offers a way out, so a lost connection cannot hold someone on it. It
  // records nothing, so Home opens the step again in the next session.
  const [saveFailed, setSaveFailed] = useState(false);
  // A handle the save refused, and its words: taken since it was checked, or
  // refused by a rule the live check did not get to answer.
  const [refusedAtSave, setRefusedAtSave] = useState<{ handle: string; message: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // On the way out: the name saved, or "Try again later". The page is held as it is meanwhile.
  const [leaving, setLeaving] = useState<'saved' | 'later' | null>(null);
  const [creditsAmount, setCreditsAmount] = useState<number | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const handleRef = useRef<HTMLInputElement>(null);

  // The server drew both fields; anything typed before the script ran is the
  // creator's own, as if typed now (src/lib/use-typed-before-hydration.ts).
  useTypedBeforeHydration(nameRef, {
    drawn: start.displayName,
    enabled: true,
    onTyped: (typed) => dispatch({ type: 'name-typed', value: typed, roll: Math.random() }),
  });
  useTypedBeforeHydration(handleRef, {
    drawn: start.username,
    enabled: true,
    onTyped: (typed) => dispatch({ type: 'handle-typed', value: typed }),
  });

  // Shown in this browser session: Home does not open the step again for
  // this account until the next one, so leaving it is not undone at once.
  useEffect(() => {
    document.cookie = creatorNameStepShownCookie(userId, window.location.protocol === 'https:');
  }, [userId]);

  // The welcome credits wait on the name: said under the button, as the app does.
  useEffect(() => {
    if (!accessToken) return undefined;
    let active = true;
    void fetch('/api/credits/welcome', { headers: { Authorization: `Bearer ${accessToken}` } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { status?: unknown; amount?: unknown } | null) => {
        if (!active || !body) return;
        if (typeof body.status === 'string' && CREDITS_WAIT_ON_NAME.has(body.status) && typeof body.amount === 'number' && body.amount > 0) {
          setCreditsAmount(body.amount);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [accessToken]);

  const draft = { displayName, username };
  const question = accessToken && shouldCheckHandleAvailability(draft, savedUsername) ? username.trim() : null;
  useHandleCheckAnswers(question, displayName, accessToken, (handle, check) => {
    dispatch({ type: 'checked', handle, check, roll: Math.random() });
  });
  const check: HandleCheck = !question
    ? { state: 'idle' }
    : state.answer?.handle === question
      ? state.answer.check
      : { state: 'checking' };
  const line = describeHandleLine({
    username,
    refusedAtSave,
    localRefusal: localHandleRefusal(username, savedUsername),
    check,
  });
  const fieldsLocked = saving || leaving !== null;
  const savePending = saving || leaving === 'saved';
  const canSave = Boolean(displayName.trim()) && isWellFormedHandle(username) && line.tone !== 'error';

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (fieldsLocked) return;
    const claim = { displayName: displayName.trim(), username: normalizeUsername(username) ?? '' };
    if (!claim.displayName) {
      setMessage('Add the name you want people to see.');
      return;
    }
    const localErrors = validatePublicIdentity(claim, savedUsername);
    if (localErrors.displayName || localErrors.username) {
      setMessage(localErrors.displayName ?? localErrors.username ?? null);
      return;
    }
    // "Just claimed" only for a handle the check had seen free.
    const checkedFree = check.state === 'available';
    dispatch({ type: 'save-started' });
    setMessage(null);
    setSaveFailed(false);
    const result = await claimPublicIdentity(claim, accessToken);
    if (result.ok) {
      setLeaving('saved');
      openPage(withCreatorWelcome(nextPath));
      return;
    }
    if (result.errors.username) {
      // Said under the handle alone, where the next handle typed replaces it.
      setRefusedAtSave({
        handle: username,
        message: result.status === 409 && checkedFree ? HANDLE_JUST_CLAIMED_TEXT : result.errors.username,
      });
    } else {
      setMessage(result.errors.displayName ?? result.message);
      setSaveFailed(true);
    }
    dispatch({ type: 'save-ended', roll: Math.random() });
  };

  const tryAgainLater = () => {
    setLeaving('later');
    openPage(nextPath);
  };

  const moveToHandle = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    handleRef.current?.focus();
  };

  return (
    <div className="ui-page ui-page-ambient flex justify-center px-4 pb-12 pt-8 sm:pt-14">
      <div className="w-full max-w-lg">
        <BrandLockup />

        <div className="mt-9 space-y-2">
          {/* Coral, as the app's: on the words, because `.ui-kicker`'s own
              colour (unlayered, globals.css) outranks a utility on the Kicker. */}
          <Kicker><span className="text-[var(--ui-primary)]">Creator identity</span></Kicker>
          <Text as="h1" variant="pageTitle">Claim your creator name</Text>
          <Text variant="bodySm">This is the name people will see on your posts, profile, and recipes.</Text>
        </div>

        <Surface as="section" variant="panel" padding="lg" className="mt-6">
          <form noValidate onSubmit={(event) => void save(event)} className="flex flex-col gap-5">
            {/* The fields carry no name: Enter before the script runs submits the form
                the browser's way, as a GET, which would write them into the address
                (form-submit-method.test.ts). Only where the step leads goes along. */}
            <input type="hidden" name="next" value={nextPath} />
            <div>
              <label htmlFor="creator-name-display-name" className="mb-2 block">
                <Text as="span" variant="label">Display name</Text>
              </label>
              <input
                ref={nameRef}
                {...TYPED_INPUT_PROPS}
                id="creator-name-display-name"
                type="text"
                value={displayName}
                disabled={fieldsLocked}
                onChange={(event) => dispatch({ type: 'name-typed', value: event.target.value, roll: Math.random() })}
                onKeyDown={moveToHandle}
                autoComplete="name"
                autoCapitalize="words"
                enterKeyHint="next"
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                placeholder="Your creator name"
                className={FIELD_CLASS}
              />
            </div>

            <div>
              <label htmlFor="creator-name-handle" className="mb-2 block">
                <Text as="span" variant="label">Unique handle</Text>
              </label>
              {/* No "@" drawn in front (owner, 2026-11-08): the handle starts
                  where the display name's text does. */}
              <input
                ref={handleRef}
                {...TYPED_INPUT_PROPS}
                id="creator-name-handle"
                type="text"
                value={username}
                disabled={fieldsLocked}
                onChange={(event) => dispatch({ type: 'handle-typed', value: event.target.value })}
                onFocus={() => dispatch({ type: 'handle-focused' })}
                onBlur={() => dispatch({ type: 'handle-left', roll: Math.random() })}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="done"
                maxLength={HANDLE_MAX_LENGTH}
                placeholder="your-name"
                aria-invalid={line.tone === 'error' ? true : undefined}
                aria-describedby="creator-name-handle-line"
                className={FIELD_CLASS}
              />
              {/* Polite: the check answers a pause in typing, not a press. */}
              <p
                id="creator-name-handle-line"
                aria-live="polite"
                className={`mt-2 text-xs font-semibold leading-[17px] ${LINE_TONE[line.tone]}`}
              >
                {line.text}
              </p>
              <p aria-live="polite" className="sr-only">{state.swapNotice ?? ''}</p>
            </div>

            {message ? (
              <p role="alert" className="text-sm leading-6 text-[var(--ui-accent-danger)]">{message}</p>
            ) : null}

            <div className="flex flex-col gap-3">
              <Button type="submit" variant="primary" pending={savePending} disabled={!canSave || leaving === 'later'} className="w-full">
                {savePending ? 'Saving…' : 'Save creator name'}
              </Button>
              {/* The name stays required: this only keeps a save that cannot
                  get through (offline, a server error) from holding someone
                  here. Nothing records "later". */}
              {saveFailed ? (
                <Button variant="secondary" disabled={fieldsLocked} onClick={tryAgainLater} className="w-full">
                  Try again later
                </Button>
              ) : null}
            </div>

            {creditsAmount ? (
              <Text variant="caption" className="text-center">
                {`Your ${creditsAmount} free credits are added once you choose a name.`}
              </Text>
            ) : null}
          </form>
        </Surface>
      </div>
    </div>
  );
}
