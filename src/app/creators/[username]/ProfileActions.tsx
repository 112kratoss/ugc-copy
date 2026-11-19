'use client';

import { Component, startTransition, Suspense, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { Edit2, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/components/AuthProvider';
import {
  useHasHydratedSupabaseAuthCookieHint,
  useSupabaseAuthCookieHint,
} from '@/components/useSupabaseAuthCookieHint';
import { loadBrowserSupabase } from '@/lib/browser-session';
import { rememberOwnerCreatorProfile } from '@/lib/owner-page-edits';
import type { EditableCreatorProfile, ProfileApiResponse } from '@/lib/profile';
import { toEditableCreatorProfile } from '@/lib/profile';
import { scheduleIdleWork } from '@/lib/schedule-idle-work';
import { ShowcaseFeedbackMenu } from '@/app/showcase/ShowcaseFeedInteraction';
import ProfileShareButton from '@/components/ProfileShareButton';
import type { ConfirmationRequest } from '@/components/feedback-state';
import { useConfirmation } from '@/components/useConfirmation';
import {
  blockCreatorAfterConfirmation,
  reportCreatorAfterConfirmation,
  toastSafetyOutcome,
} from '@/lib/feed-safety-actions';
import { noteFollowChange } from '@/lib/follow-changes';

import {
  CREATOR_PROFILE_EDIT_SHEET_WARM_IDLE_TIMEOUT_MS,
  CreatorProfileEditSheetOnItsWay,
  useLoadedCreatorProfileEditSheet,
  warmCreatorProfileEditSheet,
} from './creator-profile-edit-sheet-loader';

interface ProfileActionsProps {
  profile: EditableCreatorProfile;
  /**
   * The signed-in viewer blocked this creator (the server render checked).
   * Follow and Share are not offered; Report user stays, and Unblock is the
   * page's own panel where the posts would be.
   */
  blockedByViewer?: boolean;
}

const DISCARD_PROFILE_CHANGES: ConfirmationRequest = {
  title: 'Discard your profile changes?',
  message: 'Your edits haven’t been saved and will be lost.',
  confirmLabel: 'Discard changes',
  cancelLabel: 'Keep editing',
  tone: 'danger',
};

/**
 * The editor's code can fail to load: a deploy rotated the chunk names while the tab was open, or
 * the connection was down as it was asked for. React.lazy throws that to the nearest error
 * boundary, which would be the creator page's own error page: kept to this boundary instead, with
 * an editor that throws as it draws, and the page says so under the owner's buttons (`onFailed`).
 * Its Try again reloads the page, as the editor's other host does (`DeferredCreatorProfileCard`):
 * an in-place retry asks Turbopack's runtime for the same failed chunk.
 */
class EditSheetLoadBoundary extends Component<{ onFailed: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Failed to load the profile editor:', error);
    // Caught here, it never reaches Next's own reportError, which is what Sentry hears: hand it
    // on as an uncaught one would be.
    window.reportError?.(error);
    this.props.onFailed();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Follow, Share and the ⋯ menu, or Edit profile on the creator's own page. Who is looking comes
 * from the page's auth provider (`useAuth`), which loads the Supabase client only for a browser
 * with a session cookie: a visitor's page loads neither it nor the owner's editor. A press that
 * acts for the viewer reads the session at that moment, as before (a token held since the page
 * loaded can have expired), and only once the provider has said there is one.
 */
export function ProfileActions({ profile, blockedByViewer = false }: ProfileActionsProps) {
  const router = useRouter();
  const { session, user, isLoading } = useAuth();
  const hasAuthCookie = useSupabaseAuthCookieHint();
  const hydrated = useHasHydratedSupabaseAuthCookieHint();
  // Also handed to Share, so a share is attributed to the viewer.
  const accessToken = session?.access_token ?? null;
  const viewerUserId = accessToken ? user?.id ?? null : null;
  // As CreatorPageViewer reads its viewer: unknown until it is known whether anyone is signed in.
  // A blocked creator offers no Follow and no Edit profile: there is nothing to know.
  const viewerKnown = viewerUserId !== null || (hydrated && !(hasAuthCookie && isLoading));
  const isOwner: boolean | null = blockedByViewer || !viewerKnown ? null : viewerUserId === profile.id;
  const [isFollowing, setIsFollowing] = useState(false);
  const [isFollowLoading, setIsFollowLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followStatusMessage, setFollowStatusMessage] = useState<string | null>(null);
  const [pendingFollowIntent, setPendingFollowIntent] = useState<boolean | null>(null);
  // Whose follow state is drawn: another viewer (a sign-in or a sign-out the provider heard) starts
  // from not following, until their own read lands.
  const [followStateViewer, setFollowStateViewer] = useState(viewerUserId);
  if (followStateViewer !== viewerUserId) {
    setFollowStateViewer(viewerUserId);
    setIsFollowing(false);
    setFollowError(null);
    setFollowStatusMessage(null);
  }
  const [isEditing, setIsEditing] = useState(false);
  // The owner's own copy of the profile, read when Edit profile is pressed: a
  // read on every visit could land after the owner had started typing and
  // reset the form. The editor is drawn once it lands.
  const [editorProfile, setEditorProfile] = useState<EditableCreatorProfile | null>(null);
  const [editorLoadError, setEditorLoadError] = useState<string | null>(null);
  // The editor's code did not load (`EditSheetLoadBoundary`).
  const [editorCodeFailed, setEditorCodeFailed] = useState(false);
  const loadedEditSheet = useLoadedCreatorProfileEditSheet();
  const editorReadRef = useRef(0);
  // Set by the first edit in the open editor: closing it then asks before the
  // changes are thrown away.
  const editorChangedRef = useRef(false);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const followStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Its one question is about the open editor.
  const askToConfirm = useConfirmation(isEditing);

  const clearFollowStatusTimer = () => {
    if (followStatusTimerRef.current) {
      clearTimeout(followStatusTimerRef.current);
      followStatusTimerRef.current = null;
    }
  };

  const showTemporaryFollowStatus = (message: string) => {
    clearFollowStatusTimer();
    setFollowStatusMessage(message);
    followStatusTimerRef.current = setTimeout(() => {
      setFollowStatusMessage(null);
      followStatusTimerRef.current = null;
    }, 2400);
  };

  useEffect(() => clearFollowStatusTimer, []);

  // Read with the token current when the read is sent, never again for a renewed token alone.
  const followStateToken = useEffectEvent(() => accessToken);

  // Whether a signed-in viewer who is not the creator follows them: read once the viewer is known.
  useEffect(() => {
    if (isOwner !== false || viewerUserId === null) {
      return;
    }

    let isActive = true;
    const token = followStateToken();

    const readFollowState = async () => {
      try {
        const params = new URLSearchParams({ followingId: profile.id });
        const response = await fetch(`/api/profile/follow?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!isActive) {
          return;
        }

        if (!response.ok) {
          throw new Error('Failed to load follow state');
        }

        const data = await response.json();
        if (isActive) setIsFollowing(Boolean(data.following));
      } catch (error) {
        if (!isActive) return;
        console.error('Failed to load follow state', error);
        setFollowError('Failed to load follow state.');
      }
    };

    void readFollowState();
    return () => {
      isActive = false;
    };
  }, [isOwner, profile.id, viewerUserId]);

  // The owner's editor, loaded in the first idle moment after the page knows it is theirs, so
  // their first Edit press draws it at once. Nobody else's page asks for it.
  useEffect(() => {
    if (!isOwner) {
      return;
    }
    return scheduleIdleWork(warmCreatorProfileEditSheet, CREATOR_PROFILE_EDIT_SHEET_WARM_IDLE_TIMEOUT_MS);
  }, [isOwner]);

  /**
   * The session at a press, read fresh from the client: a token held since the page loaded can
   * have expired. A viewer the provider knows as signed out has none, and the client is not loaded
   * to say so; for anyone signed in the provider has loaded it already.
   */
  const readPressSession = async () => {
    if (!viewerUserId) return null;
    const supabase = await loadBrowserSupabase();
    const { data: { session: current } } = await supabase.auth.getSession();
    return current;
  };

  const loadEditorProfile = async () => {
    const read = ++editorReadRef.current;
    setEditorProfile(null);
    setEditorLoadError(null);

    try {
      const session = await readPressSession();
      if (!session?.access_token) {
        throw new Error('No session to read the profile with');
      }

      const response = await fetch('/api/profile', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) {
        throw new Error(`Profile read answered ${response.status}`);
      }

      const data = (await response.json()) as ProfileApiResponse;
      // A read the owner closed the editor on, or asked again over, is dropped.
      if (read !== editorReadRef.current) return;
      setEditorProfile(toEditableCreatorProfile(data));
    } catch (error) {
      if (read !== editorReadRef.current) return;
      console.error('Failed to fetch private profile', error);
      setEditorLoadError('Could not load your profile.');
    }
  };

  const openEditor = () => {
    editorChangedRef.current = false;
    setIsEditing(true);
    void loadEditorProfile();
  };

  const closeEditor = () => {
    editorReadRef.current += 1;
    editorChangedRef.current = false;
    setIsEditing(false);
    setEditorProfile(null);
    setEditorLoadError(null);
    editButtonRef.current?.focus();
  };

  // The editor's own guard covers leaving the page; closing the dialog
  // unmounts it, so the dialog asks first.
  const requestCloseEditor = async () => {
    if (editorChangedRef.current && !(await askToConfirm(DISCARD_PROFILE_CHANGES))) {
      return;
    }
    closeEditor();
  };

  const handleProfileSaved = (nextProfile: EditableCreatorProfile) => {
    closeEditor();
    // The cached page is invalidated only after the save's
    // answer was sent, so the refresh below can still get the
    // old one: the header shows the answer meanwhile.
    rememberOwnerCreatorProfile(nextProfile);

    startTransition(() => {
      if (nextProfile.username !== profile.username) {
        router.replace(`/creators/${nextProfile.username}`);
        return;
      }

      router.refresh();
    });
  };

  const handleEditorCodeFailed = () => {
    setEditorCodeFailed(true);
    closeEditor();
  };

  const returnUrl = profile.username
    ? `/creators/${profile.username}`
    : '/showcase';

  // Report user and Block user, behind a ⋯ of their own as on the app's
  // creator screen: reachable, and quieter than Follow and Share. The server
  // takes both from registered accounts only, so a signed-out viewer is sent
  // to sign in and comes back here.
  const requireAccountToken = async (): Promise<string | null> => {
    const session = await readPressSession();
    if (session?.access_token) return session.access_token;
    router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
    return null;
  };

  const handleReportUser = async () => {
    const token = await requireAccountToken();
    if (!token) return;
    toastSafetyOutcome(await reportCreatorAfterConfirmation({
      userId: profile.id,
      accessToken: token,
      surface: 'creator-page',
    }));
  };

  const handleBlockUser = async () => {
    const token = await requireAccountToken();
    if (!token) return;
    const outcome = await blockCreatorAfterConfirmation({
      userId: profile.id,
      creatorName: profile.displayName,
      accessToken: token,
    });
    toastSafetyOutcome(outcome);
    // With the creator blocked, nothing on their page is left to show: the
    // viewer goes to Explore, as the app's creator screen sends them.
    if (outcome.status === 'done') router.replace('/showcase');
  };

  if (blockedByViewer) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <ShowcaseFeedbackMenu
          itemTitle={`@${profile.username}`}
          creator={{ username: profile.username, name: profile.displayName }}
          variant="outline"
          portal
          onReportUser={() => void handleReportUser()}
        />
      </div>
    );
  }

  if (isOwner === null) {
    return (
      <div className="flex items-center gap-3">
        <div className="h-11 w-24 animate-pulse rounded-full bg-white/10" />
        <ProfileShareButton
          username={profile.username}
          displayName={profile.displayName}
          sourceSurface="creator-profile"
          accessToken={accessToken}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-5 py-2.5 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.1] aria-disabled:cursor-not-allowed aria-disabled:opacity-70"
        />
      </div>
    );
  }

  const handleFollowToggle = async () => {
    setFollowError(null);
    setFollowStatusMessage(null);

    const session = await readPressSession();

    if (!session) {
      router.push(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
      return;
    }

    if (session.user.id === profile.id) {
      return;
    }

    const nextFollowing = !isFollowing;
    clearFollowStatusTimer();
    setIsFollowLoading(true);
    setIsFollowing(nextFollowing);
    setPendingFollowIntent(nextFollowing);
    setFollowStatusMessage(nextFollowing ? 'Following creator...' : 'Removing follow...');

    try {
      const response = await fetch('/api/profile/follow', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ followingId: profile.id, following: nextFollowing }),
      });

      if (!response.ok) {
        throw new Error('Failed to update follow state');
      }

      const data = await response.json();
      const confirmedFollowing = typeof data.following === 'boolean' ? data.following : nextFollowing;
      setIsFollowing(confirmedFollowing);
      // A search page Back returns to reads it (follow-changes.ts).
      noteFollowChange(session.user.id, profile.id, confirmedFollowing);
      showTemporaryFollowStatus(confirmedFollowing ? 'Following creator.' : 'Removed follow.');
    } catch (error) {
      console.error('Failed to update follow state', error);
      setIsFollowing(!nextFollowing);
      setFollowError('Could not update follow. Your previous state was restored.');
      setFollowStatusMessage(null);
    } finally {
      setIsFollowLoading(false);
      setPendingFollowIntent(null);
    }
  };

  const followButtonLabel = isFollowLoading
    ? pendingFollowIntent
      ? 'Following...'
      : 'Removing...'
    : isFollowing
      ? 'Following'
      : 'Follow';

  const editSheetProps = {
    open: isEditing,
    profile: editorProfile,
    loadError: editorLoadError,
    onRetry: () => void loadEditorProfile(),
    onRequestClose: () => void requestCloseEditor(),
    onEdited: () => {
      editorChangedRef.current = true;
    },
    onSaved: handleProfileSaved,
  };
  // Pressed before the editor's code had arrived: the button says it is on its way.
  const editorOnItsWay = isEditing && !loadedEditSheet && !editorCodeFailed;
  const LoadedEditSheet = loadedEditSheet?.CreatorProfileEditSheet ?? null;
  const editSheet = isOwner && (LoadedEditSheet || isEditing) ? (
    <EditSheetLoadBoundary onFailed={handleEditorCodeFailed}>
      {LoadedEditSheet ? (
        // Drawn whenever its code is in, closed or open, so it animates out as it closes.
        <LoadedEditSheet {...editSheetProps} />
      ) : (
        <Suspense fallback={null}>
          <CreatorProfileEditSheetOnItsWay {...editSheetProps} />
        </Suspense>
      )}
    </EditSheetLoadBoundary>
  ) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {isOwner ? (
          <button
            ref={editButtonRef}
            type="button"
            onClick={openEditor}
            // Its code is asked for again on intent, in case the idle moment has not come yet.
            onPointerEnter={warmCreatorProfileEditSheet}
            onFocus={warmCreatorProfileEditSheet}
            aria-busy={editorOnItsWay || undefined}
            className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-black transition hover:bg-zinc-200"
          >
            {editorOnItsWay ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Edit2 className="h-4 w-4" />}
            Edit profile
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleFollowToggle()}
            disabled={isFollowLoading}
            aria-pressed={isFollowing}
            aria-busy={isFollowLoading}
            className={`ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-bold transition ${
              isFollowing
                ? 'border border-white/15 bg-white/10 text-white hover:bg-white/15'
                : 'bg-white text-black hover:bg-zinc-200'
            } disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:scale-100`}
          >
            {isFollowLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {followButtonLabel}
          </button>
        )}
        <ProfileShareButton
          username={profile.username}
          displayName={profile.displayName}
          sourceSurface="creator-profile"
          accessToken={accessToken}
          className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-5 text-sm font-bold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.09] aria-disabled:cursor-not-allowed aria-disabled:opacity-70"
        />
        {/* Never on your own page. Drawn in the body: the card around this row clips what it holds. */}
        {isOwner ? null : (
          <ShowcaseFeedbackMenu
            itemTitle={`@${profile.username}`}
            creator={{ username: profile.username, name: profile.displayName }}
            variant="outline"
            portal
            onReportUser={() => void handleReportUser()}
            onBlockUser={() => void handleBlockUser()}
          />
        )}
      </div>
      {followError ? (
        <p className="mt-2 text-sm text-rose-300">{followError}</p>
      ) : null}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {followError ?? followStatusMessage ?? ''}
      </p>
      {!followError && followStatusMessage ? (
        <p className="mt-2 text-sm text-emerald-300">{followStatusMessage}</p>
      ) : null}
      {isOwner && editorCodeFailed ? (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          The profile editor did not load.{' '}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="ui-focus-ring rounded font-bold underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      ) : null}

      {editSheet}
    </>
  );
}
