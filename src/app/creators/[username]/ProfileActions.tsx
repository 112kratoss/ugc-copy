'use client';

import { startTransition, useEffect, useState } from 'react';
import { Sparkles, Edit2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';

import { supabase } from '@/lib/supabase';
import type { EditableCreatorProfile, ProfileApiResponse } from '@/lib/profile';
import { toEditableCreatorProfile } from '@/lib/profile';
import CreatorProfileCard from '@/app/creations/CreatorProfileCard';

interface ProfileActionsProps {
  profile: EditableCreatorProfile;
}

export function ProfileActions({ profile }: ProfileActionsProps) {
  const router = useRouter();
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [privateProfile, setPrivateProfile] = useState<EditableCreatorProfile>(profile);

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

      if (!ownsProfile || !session?.access_token) {
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
      <div className="flex items-center gap-3 mt-4 md:mt-8">
        <div className="h-10 w-24 animate-pulse rounded-full bg-white/10" />
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-3 mt-4 md:mt-8">
        {isOwner ? (
          <button
            onClick={() => setIsEditing(true)}
            className="inline-flex items-center gap-2 rounded-full border border-purple-500/50 bg-purple-500/10 text-purple-200 px-5 py-2.5 text-sm font-semibold transition-all hover:bg-purple-500/20 hover:border-purple-500 hover:text-white"
          >
            <Edit2 className="h-4 w-4" />
            Edit Profile
          </button>
        ) : (
          <button className="inline-flex items-center gap-2 rounded-full bg-white text-black px-5 py-2.5 text-sm font-semibold transition-transform hover:scale-105">
            Follow
          </button>
        )}
        
        <Link
          href="/showcase"
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-5 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:border-white/20 hover:text-white"
        >
          Explore showcase
          <Sparkles className="h-4 w-4" />
        </Link>
      </div>

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
