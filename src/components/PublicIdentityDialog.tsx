'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';

import PublicIdentityFields from '@/components/PublicIdentityFields';
import { resolvePublicIdentity, type PendingPublicIdentity } from '@/components/feedback-state';
import { useModalQuestion } from '@/components/useModalQuestion';
import {
  claimPublicIdentity,
  getInitialPublicIdentity,
  loadOwnProfile,
  validatePublicIdentity,
  type PublicIdentityDraft,
  type PublicIdentityErrors,
  type PublicIdentityProfile,
} from '@/lib/public-identity';

const FOCUSABLE = 'input:not([disabled]), button:not([disabled])';

/**
 * The name and handle a creator is asked for when they make a post public
 * from a list (`requestPublicIdentity`), where the server used to refuse the
 * change for their profile and the list could only say so. Filled in as the
 * composers fill them, from the profile and the sign-in; saving runs the
 * composers' claim, and the post's change goes out again once it has.
 *
 * Drawn by `FeedbackViewport` from the root layout, outside every route's
 * `AuthProvider`, so the request carries the sign-in it needs and a way to
 * read the page's token as it stands.
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

  // Until the profile has been read the fields hold the sign-in's suggestion,
  // which the profile's own name can replace: the handle is checked only once
  // they have settled, so the server is not asked about a handle about to go.
  const [profileSettled, setProfileSettled] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadOwnProfile(request.getAccessToken(), controller.signal).then((loaded) => {
      if (controller.signal.aborted) {
        return;
      }
      if (loaded) {
        setProfile(loaded);
      }
      setProfileSettled(true);
    });
    return () => controller.abort();
  }, [request]);

  // A question put away mid-save would leave the save to land unseen, so
  // Cancel, the backdrop, Escape and a Back that leaves the page all wait for
  // it; a save that lands after such a Back still makes the post public.
  const cancel = () => {
    if (!isSaving) {
      resolvePublicIdentity(id, { status: 'cancelled' });
    }
  };

  useModalQuestion({
    questionId: id,
    dialogRef,
    // The first field.
    initialFocus: () => dialogRef.current?.querySelector<HTMLInputElement>('input'),
    focusables: () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    onCancel: cancel,
  });

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
    const saved = await claimPublicIdentity(identity, request.getAccessToken());
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
        if (event.target === event.currentTarget) {
          cancel();
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
            accessToken={profileSettled ? request.getAccessToken() : null}
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
            onClick={cancel}
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
