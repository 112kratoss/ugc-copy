'use client';

import { startTransition, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { Edit2, Loader2, RefreshCw, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';

import { supabase } from '@/lib/supabase';
import type { EditableCreatorProfile, ProfileApiResponse } from '@/lib/profile';
import { toEditableCreatorProfile } from '@/lib/profile';
import CreatorProfileCard from '@/app/creations/CreatorProfileCard';
import { ShowcaseFeedbackMenu } from '@/app/showcase/ShowcaseFeedInteraction';
import ProfileShareButton from '@/components/ProfileShareButton';
import {
  blockCreatorAfterConfirmation,
  reportCreatorAfterConfirmation,
  toastSafetyOutcome,
} from '@/lib/feed-safety-actions';

interface ProfileActionsProps {
  profile: EditableCreatorProfile;
  /**
   * The signed-in viewer blocked this creator (the server render checked).
   * Follow and Share are not offered; Report user stays, and Unblock is the
   * page's own panel where the posts would be.
   */
  blockedByViewer?: boolean;
}

const EDITOR_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function ProfileActions({ profile, blockedByViewer = false }: ProfileActionsProps) {
  const router = useRouter();
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  // Captured alongside ownership so a share can be attributed to the viewer
  // without a second getSession() round trip.
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isFollowLoading, setIsFollowLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followStatusMessage, setFollowStatusMessage] = useState<string | null>(null);
  const [pendingFollowIntent, setPendingFollowIntent] = useState<boolean | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  // The owner's own copy of the profile, read when Edit profile is pressed: a
  // read on every visit could land after the owner had started typing and
  // reset the form. The editor is drawn once it lands.
  const [editorProfile, setEditorProfile] = useState<EditableCreatorProfile | null>(null);
  const [editorLoadError, setEditorLoadError] = useState<string | null>(null);
  const editorReadRef = useRef(0);
  // Set by the first edit in the open editor: closing it then asks before the
  // changes are thrown away.
  const editorChangedRef = useRef(false);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const editorDialogRef = useRef<HTMLDivElement | null>(null);
  const editorTitleId = useId();
  const followStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    // A blocked creator offers no Follow: there is no state to read.
    if (blockedByViewer) {
      return;
    }

    let isActive = true;

    const checkOwnership = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!isActive) {
        return;
      }

      const ownsProfile = session?.user?.id === profile.id;
      setIsOwner(ownsProfile);
      setAccessToken(session?.access_token ?? null);
      setFollowError(null);
      setFollowStatusMessage(null);

      if (ownsProfile) {
        return;
      }

      if (!session?.access_token) {
        setIsFollowing(false);
        return;
      }

      try {
        const params = new URLSearchParams({ followingId: profile.id });
        const response = await fetch(`/api/profile/follow?${params.toString()}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });

        if (!isActive) {
          return;
        }

        if (!response.ok) {
          throw new Error('Failed to load follow state');
        }

        const data = await response.json();
        setIsFollowing(Boolean(data.following));
      } catch (error) {
        console.error('Failed to load follow state', error);
        setFollowError('Failed to load follow state.');
      }
    };

    checkOwnership();
    return () => {
      isActive = false;
    };
  }, [blockedByViewer, profile.id]);

  const loadEditorProfile = async () => {
    const read = ++editorReadRef.current;
    setEditorProfile(null);
    setEditorLoadError(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
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
  const requestCloseEditor = () => {
    if (editorChangedRef.current && !window.confirm('Discard your profile changes?')) {
      return;
    }
    closeEditor();
  };

  const keepFocusInEditor = (event: KeyboardEvent) => {
    const dialog = editorDialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(EDITOR_FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const isOutside = active === dialog || !dialog.contains(active);
    if (event.shiftKey && (active === first || isOutside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || isOutside)) {
      event.preventDefault();
      first.focus();
    }
  };

  const onEditorKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestCloseEditor();
      return;
    }
    if (event.key === 'Tab') {
      keepFocusInEditor(event);
    }
  });

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    editorDialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => onEditorKeyDown(event);
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditing]);

  const returnUrl = profile.username
    ? `/creators/${profile.username}`
    : '/showcase';

  // Report user and Block user, behind a ⋯ of their own as on the app's
  // creator screen: reachable, and quieter than Follow and Share. The server
  // takes both from registered accounts only, so a signed-out viewer is sent
  // to sign in and comes back here.
  const requireAccountToken = async (): Promise<string | null> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
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
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-5 py-2.5 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-70"
        />
      </div>
    );
  }

  const handleFollowToggle = async () => {
    setFollowError(null);
    setFollowStatusMessage(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();

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

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {isOwner ? (
          <button
            ref={editButtonRef}
            type="button"
            onClick={openEditor}
            className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full bg-white px-5 text-sm font-bold text-black transition hover:bg-zinc-200"
          >
            <Edit2 className="h-4 w-4" />
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
          className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-5 text-sm font-bold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:opacity-70"
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

      <AnimatePresence>
        {isEditing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-6"
          >
            <motion.div
              ref={editorDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={editorTitleId}
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="relative flex h-full max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-[32px] border border-white/10 bg-zinc-950 shadow-2xl outline-none"
            >
              {/* Fixed Header */}
              <div className="flex shrink-0 items-center justify-between border-b border-white/5 bg-zinc-900/50 px-6 py-4">
                <h2 id={editorTitleId} className="text-xl font-semibold text-white">Edit profile</h2>
                <button
                  type="button"
                  onClick={requestCloseEditor}
                  aria-label="Close"
                  className="ui-focus-ring -my-1.5 inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white/5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <X className="h-5 w-5" aria-hidden />
                </button>
              </div>

              {/* Scrollable Content. Any field the editor changes reports here. */}
              <div
                className="flex-1 overflow-y-auto p-4 sm:p-6 custom-scrollbar"
                onChange={() => {
                  editorChangedRef.current = true;
                }}
              >
                {editorProfile ? (
                  <CreatorProfileCard
                    initialProfile={editorProfile}
                    loadError={null}
                    isEmbedded={true}
                    onProfileSaved={(nextProfile) => {
                      closeEditor();

                      startTransition(() => {
                        if (nextProfile.username !== profile.username) {
                          router.replace(`/creators/${nextProfile.username}`);
                          return;
                        }

                        router.refresh();
                      });
                    }}
                  />
                ) : editorLoadError ? (
                  <div role="alert" className="rounded-3xl border border-rose-300/20 bg-rose-500/5 p-6 text-sm text-rose-100">
                    <p className="font-bold">{editorLoadError}</p>
                    <button
                      type="button"
                      onClick={() => void loadEditorProfile()}
                      className="ui-focus-ring mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-rose-300/25 bg-rose-400/10 px-4 font-bold"
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden />
                      Try again
                    </button>
                  </div>
                ) : (
                  <div role="status" aria-label="Loading your profile" className="rounded-3xl border border-white/5 p-6">
                    <div className="h-6 w-48 animate-pulse rounded bg-white/10" />
                    <div className="mt-3 h-4 w-80 max-w-full animate-pulse rounded bg-white/5" />
                    <div className="mt-6 grid gap-4 md:grid-cols-2">
                      <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
                      <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
                      <div className="h-24 animate-pulse rounded-2xl bg-black/40 md:col-span-2" />
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
