'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';

import PublicIdentityFields from '@/components/PublicIdentityFields';
import { resolvePublicIdentity, type PendingPublicIdentity } from '@/components/feedback-state';
import {
  claimPublicIdentity,
  getInitialPublicIdentity,
  loadOwnProfile,
  validatePublicIdentity,
  type PublicIdentityDraft,
  type PublicIdentityErrors,
  type PublicIdentityProfile,
} from '@/lib/public-identity';

/** The page an address names: a change of hash alone stays on it. */
function readAddress() {
  return `${window.location.pathname}${window.location.search}`;
}

const FOCUSABLE = 'input:not([disabled]), button:not([disabled])';

/**
 * The name and handle a creator is asked for when they make a post public
 * from a list (`requestPublicIdentity`), where the server used to refuse the
 * change for their profile and the list could only say so. Filled in as the
 * composers fill them, from the profile and the sign-in; saving runs the
 * composers' claim, and the post's change goes out again once it has.
 *
 * Drawn by `FeedbackViewport` from the root layout, outside every route's
 * `AuthProvider`, so the request carries the token and the sign-in it needs.
 */
export default function PublicIdentityDialog({ pending }: { pending: PendingPublicIdentity }) {
  const { id, request } = pending;
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const [profile, setProfile] = useState<PublicIdentityProfile | null>(null);
  // The fields follow the profile and the sign-in until the creator types.
  const [edits, setEdits] = useState<PublicIdentityDraft | null>(null);
  const [errors, setErrors] = useState<PublicIdentityErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const identity = edits ?? getInitialPublicIdentity(profile, request.signedInUser);
  const titleId = `ui-identity-title-${id}`;
  const messageId = `ui-identity-message-${id}`;

  useEffect(() => {
    const controller = new AbortController();
    void loadOwnProfile(request.accessToken, controller.signal).then((loaded) => {
      if (loaded && !controller.signal.aborted) {
        setProfile(loaded);
      }
    });
    return () => controller.abort();
  }, [request.accessToken]);

  const isSavingRef = useRef(isSaving);
  useEffect(() => {
    isSavingRef.current = isSaving;
  }, [isSaving]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The first field takes the focus, without scrolling: on a phone the sheet
    // starts below the window, and focusing it there would jump it into place.
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    });
    const askedAt = readAddress();
    // A question put away mid-save would leave the save to land unseen.
    const cancel = () => {
      if (!isSavingRef.current) {
        resolvePublicIdentity(id, { status: 'cancelled' });
      }
    };

    // As the confirmation does: every key is the question's while it is up, so
    // a modal under it never takes its Escape or pulls Tab back into itself.
    // Typing still reaches the fields; their changes arrive as input events.
    const handleKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    // A Back that leaves the page has left the post the question was about.
    const handlePopState = () => {
      if (readAddress() !== askedAt) {
        resolvePublicIdentity(id, { status: 'cancelled' });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('popstate', handlePopState);
      previouslyFocused?.focus();
    };
  }, [id]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) {
      return;
    }
    const problems = validatePublicIdentity(identity, profile?.username);
    if (problems.displayName || problems.username) {
      setErrors(problems);
      setMessage(null);
      return;
    }
    setIsSaving(true);
    setMessage(null);
    const saved = await claimPublicIdentity(identity, request.accessToken);
    if (saved.ok) {
      resolvePublicIdentity(id, { status: 'saved', profile: saved.profile });
      return;
    }
    setIsSaving(false);
    setErrors(saved.errors);
    // A refusal on a field is said beside it; anything else above the buttons.
    setMessage(saved.errors.displayName || saved.errors.username ? null : saved.message);
  };

  return (
    <div
      className="ui-confirm-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSaving) {
          resolvePublicIdentity(id, { status: 'cancelled' });
        }
      }}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="ui-confirm-dialog ui-identity-dialog"
        onSubmit={(event) => void save(event)}
        noValidate
      >
        <h2 id={titleId} className="ui-confirm-title">
          Add your name and handle
        </h2>
        <p id={messageId} className="ui-confirm-message">
          Public posts show both. They are saved to your profile, and you can change them there later.
        </p>
        <div className="mt-5">
          <PublicIdentityFields
            idPrefix={`ui-identity-${id}`}
            value={identity}
            errors={errors}
            disabled={isSaving}
            accessToken={request.accessToken}
            savedUsername={profile?.username}
            framed={false}
            onChange={(next) => {
              setEdits(next);
              setErrors({});
              setMessage(null);
            }}
          />
        </div>
        {message ? (
          <p role="alert" className="mt-4 text-sm leading-6 text-[var(--ui-accent-danger)]">
            {message}
          </p>
        ) : null}
        <div className="ui-confirm-actions">
          <button
            type="button"
            disabled={isSaving}
            onClick={() => resolvePublicIdentity(id, { status: 'cancelled' })}
            className="ui-button ui-button-secondary ui-focus-ring"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSaving}
            className="ui-button ui-button-primary ui-focus-ring"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {isSaving ? 'Saving…' : 'Save and make public'}
          </button>
        </div>
      </form>
    </div>
  );
}
