'use client';

import { startTransition, useEffect, useRef, useState } from 'react';
import { Edit2, Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';

import { supabase } from '@/lib/supabase';
import type { EditableCreatorProfile, ProfileApiResponse } from '@/lib/profile';
import { toEditableCreatorProfile } from '@/lib/profile';
import CreatorProfileCard from '@/app/creations/CreatorProfileCard';
import ProfileShareButton from '@/app/components/ProfileShareButton';

interface ProfileActionsProps {
  profile: EditableCreatorProfile;
}

export function ProfileActions({ profile }: ProfileActionsProps) {
  const router = useRouter();
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isFollowLoading, setIsFollowLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followStatusMessage, setFollowStatusMessage] = useState<string | null>(null);
  const [pendingFollowIntent, setPendingFollowIntent] = useState<boolean | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [privateProfile, setPrivateProfile] = useState<EditableCreatorProfile>(profile);
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
      setFollowError(null);
      setFollowStatusMessage(null);

      if (!ownsProfile || !session?.access_token) {
        if (session?.user?.id) {
          const { data: followRecord, error: followLookupError } = await supabase
            .from('follows')
            .select('follower_id')
            .eq('follower_id', session.user.id)
            .eq('following_id', profile.id)
            .maybeSingle();

          if (!isActive) {
            return;
          }

          if (followLookupError) {
            console.error('Failed to load follow state', followLookupError);
            setFollowError('Failed to load follow state.');
            return;
          }

          setIsFollowing(Boolean(followRecord));
        } else {
          setIsFollowing(false);
        }

        return;
      }

      // Fetch the full private profile for the edit modal.
      try {
        const res = await fetch('/api/profile', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!res.ok || !isActive) {
          return;
        }

        const data = (await res.json()) as ProfileApiResponse;
        setPrivateProfile(toEditableCreatorProfile(data));
      } catch (error) {
        console.error('Failed to fetch private profile', error);
      }
    };

    checkOwnership();
    return () => {
      isActive = false;
    };
  }, [profile.id]);

  if (isOwner === null) {
    return (
      <div className="flex items-center gap-3">
        <ProfileShareButton
          username={profile.username}
          displayName={profile.displayName}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-5 py-2.5 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-70"
        />
        <div className="h-10 w-24 animate-pulse rounded-full bg-white/10" />
      </div>
    );
  }

  const handleFollowToggle = async () => {
    setFollowError(null);
    setFollowStatusMessage(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    const returnUrl = profile.username
      ? `/creators/${profile.username}`
      : '/showcase';

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
      if (nextFollowing) {
        const { error } = await supabase.from('follows').insert({
          follower_id: session.user.id,
          following_id: profile.id,
        });

        if (error) {
          throw error;
        }
      } else {
        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', session.user.id)
          .eq('following_id', profile.id);

        if (error) {
          throw error;
        }
      }
      showTemporaryFollowStatus(nextFollowing ? 'Following creator.' : 'Removed follow.');
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
        <ProfileShareButton
          username={profile.username}
          displayName={profile.displayName}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-5 py-2.5 text-sm font-semibold text-zinc-100 transition hover:border-white/20 hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-70"
        />
        {isOwner ? (
          <button
            onClick={() => setIsEditing(true)}
            className="inline-flex items-center gap-2 rounded-full border border-purple-500/50 bg-purple-500/10 px-5 py-2.5 text-sm font-semibold text-purple-200 transition-all hover:border-purple-500 hover:bg-purple-500/20 hover:text-white"
          >
            <Edit2 className="h-4 w-4" />
            Edit Profile
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleFollowToggle()}
            disabled={isFollowLoading}
            aria-pressed={isFollowing}
            aria-busy={isFollowLoading}
            className={`inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition ${
              isFollowing
                ? 'border border-white/15 bg-white/10 text-white hover:bg-white/15'
                : 'border border-white/10 bg-white/[0.06] text-zinc-100 hover:border-white/20 hover:bg-white/[0.1]'
            } disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:scale-100`}
          >
            {isFollowLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {followButtonLabel}
          </button>
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
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-6"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="relative flex h-full max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-[32px] border border-white/10 bg-zinc-950 shadow-2xl"
            >
              {/* Fixed Header */}
              <div className="flex shrink-0 items-center justify-between border-b border-white/5 bg-zinc-900/50 px-6 py-4">
                <h2 className="text-xl font-semibold text-white">Edit Profile</h2>
                <button
                  onClick={() => setIsEditing(false)}
                  className="rounded-full bg-white/5 p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              
              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto p-4 sm:p-6 custom-scrollbar">
                <CreatorProfileCard
                  initialProfile={privateProfile}
                  isLoading={false}
                  loadError={null}
                  isEmbedded={true}
                  onProfileSaved={(nextProfile) => {
                    setPrivateProfile(nextProfile);
                    setIsEditing(false);

                    startTransition(() => {
                      if (nextProfile.username !== profile.username) {
                        router.replace(`/creators/${nextProfile.username}`);
                        return;
                      }

                      router.refresh();
                    });
                  }}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
