'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { User } from '@supabase/supabase-js';

import { forgetAccountReads, readOwnProfile } from '@/lib/browser-account-reads';
import { getAuthAvatarUrl, getCreatorDisplayName } from '@/lib/profile';

/**
 * The signed-in account drawn as a person, beside what it writes: the comment composer's avatar.
 * It is the top bar's account button (`AccountAvatar` in AppShellAccount.tsx), read the same way:
 * the name its initials come from is the profile's display name, else the sign-in email's name
 * (`getCreatorDisplayName`); its picture is the sign-in provider's, else the profile's.
 *
 * The composer read Supabase's `user_metadata` instead: its `full_name`, else the whole email, which
 * an account with no name there drew as the email's first letter, "I" where the top bar drew "MB"
 * from the profile's "Magic Booklet" (sweep of 2026-11-17). A comment posted reads its author from
 * the profile already, on the server.
 */

/** The account's own profile, as far as it is drawn. */
export interface AccountProfileSummary {
  displayName: string | null;
  avatarUrl: string | null;
}

/**
 * The read of an account's profile: on its way; read; or failed, where the top bar's account
 * button falls back to the email's name as well (UNREAD_PROFILE there).
 */
export type AccountProfileRead =
  | { status: 'reading' }
  | { status: 'read'; profile: AccountProfileSummary }
  | { status: 'failed' };

const READING: AccountProfileRead = { status: 'reading' };
const FAILED: AccountProfileRead = { status: 'failed' };

/**
 * Each account's read, kept for the page's life, as the top bar keeps its own: every thread a page
 * opens (the post page's, the reel's, a feed card's) draws it at once after the first. A failed
 * read is asked again by the next thread that is drawn.
 */
const profileReads = new Map<string, AccountProfileRead>();
const listeners = new Set<() => void>();

function setProfileRead(userId: string, read: AccountProfileRead) {
  profileReads.set(userId, read);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function readAccountProfile(userId: string): Promise<AccountProfileSummary> {
  // Loaded where the page's session check loaded it (AuthProvider), so a signed-in reader's page
  // fetches nothing more for it.
  const { supabase } = await import('@/lib/supabase');
  // The page's one read of the account's row, which the top bar and the page's provider share: on
  // a post page it is out, or just in, by the time the composer asks.
  const { row: data, error } = await readOwnProfile(supabase, userId);
  if (error) throw error;
  const row = data as { display_name?: unknown; avatar_url?: unknown } | null;
  return {
    displayName: typeof row?.display_name === 'string' ? row.display_name : null,
    avatarUrl: typeof row?.avatar_url === 'string' ? row.avatar_url : null,
  };
}

function requestAccountProfile(userId: string) {
  const current = profileReads.get(userId);
  if (current && current.status !== 'failed') return;
  setProfileRead(userId, READING);
  readAccountProfile(userId).then(
    (profile) => setProfileRead(userId, { status: 'read', profile }),
    () => setProfileRead(userId, FAILED),
  );
}

/** The signed-in account's profile, read once for the page's life; null with no account. */
export function useAccountProfile(userId: string | null): AccountProfileRead | null {
  const read = useSyncExternalStore(
    subscribe,
    () => (userId ? profileReads.get(userId) ?? null : null),
    () => null,
  );

  useEffect(() => {
    if (userId) requestAccountProfile(userId);
  }, [userId]);

  if (!userId) return null;
  return read ?? READING;
}

/**
 * The account's avatar as the top bar draws it. `name` is null while the profile is read: the
 * avatar is drawn blank, never with an initial the profile then replaces.
 */
export function accountAvatar(
  user: Pick<User, 'email' | 'user_metadata'>,
  read: AccountProfileRead | null,
): { name: string | null; avatarUrl: string | null } {
  const profile = read?.status === 'read' ? read.profile : null;
  return {
    avatarUrl: getAuthAvatarUrl(user.user_metadata) ?? profile?.avatarUrl ?? null,
    name: !read || read.status === 'reading'
      ? null
      : getCreatorDisplayName({ displayName: profile?.displayName ?? null, email: user.email ?? null }),
  };
}

/** A new page for a test: neither these reads nor the shared one they come from are held. */
export function forgetAccountProfilesForTests() {
  profileReads.clear();
  forgetAccountReads();
}
