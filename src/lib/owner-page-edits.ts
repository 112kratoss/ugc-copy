import { useSyncExternalStore } from 'react';

import type { CreatorProfilePageData } from '@/lib/creator-profile';
import { getCreatorDisplayName, type EditableCreatorProfile } from '@/lib/profile';

/**
 * What an owner has just saved on one of the cached public pages, for their
 * own tab to show until the cache has caught up.
 *
 * The post page and the creator page are one cached render for everyone (ISR).
 * A save invalidates their tag from its API route, but Next runs a route
 * handler's `revalidateTag` after the response has been sent (`waitUntil`), so
 * the refresh a save starts the moment its answer lands can still be served
 * the page as it was, and the client router then keeps that static page for
 * five minutes (`staleTimes.static`). The owner's view shows what the save
 * answered instead, so their own edit never looks undone to them.
 *
 * The memory is this tab's alone: written only from a save's answer, in the
 * browser; empty again on every full load; read only for the owner's own view;
 * and never read on the server (the server snapshot is always nothing), so no
 * cached HTML can carry it. An entry lasts ten minutes, twice the router's
 * hold and long past the server's catch-up.
 */
export const OWNER_PAGE_EDIT_MEMORY_MS = 10 * 60 * 1000;

const edits = new Map<string, { value: unknown }>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function remember(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  const entry = { value };
  edits.set(key, entry);
  emit();
  window.setTimeout(() => {
    if (edits.get(key) !== entry) return;
    edits.delete(key);
    emit();
  }, OWNER_PAGE_EDIT_MEMORY_MS);
}

function useRemembered(key: string | null): unknown {
  const entry = useSyncExternalStore(
    subscribe,
    () => (key ? edits.get(key) ?? null : null),
    () => null,
  );
  return entry?.value;
}

export type OwnerPostVisibility = 'public' | 'unlisted';

const postVisibilityKey = (postId: string) => `post-visibility:${postId}`;

/** The owner moved their post between public and unlisted, and the server confirmed it. */
export function rememberOwnerPostVisibility(postId: string, visibility: OwnerPostVisibility): void {
  remember(postVisibilityKey(postId), visibility);
}

/** The visibility the owner last saved for this post in this tab; always null for anyone else. */
export function useOwnerPostVisibility(postId: string, viewerIsOwner: boolean): OwnerPostVisibility | null {
  const value = useRemembered(viewerIsOwner ? postVisibilityKey(postId) : null);
  return value === 'public' || value === 'unlisted' ? value : null;
}

/** The creator page's header, as a visitor reads it (`getCreatorProfilePageData`). */
export type OwnerCreatorProfile = CreatorProfilePageData['profile'];

const creatorProfileKey = (creatorId: string) => `creator-profile:${creatorId}`;

/**
 * The profile a save answered with, kept as the page's own read words it (its
 * display name falls back to the handle), and only its public fields: the
 * answer also carries the owner's balance, which no page shows.
 */
export function rememberOwnerCreatorProfile(saved: EditableCreatorProfile): void {
  const profile: OwnerCreatorProfile = {
    id: saved.id,
    username: saved.username,
    displayName: getCreatorDisplayName({ displayName: saved.displayName, username: saved.username }),
    bio: saved.bio || null,
    avatarUrl: saved.avatarUrl || null,
    coverUrl: saved.coverUrl || null,
    websiteUrl: saved.websiteUrl || null,
    twitterHandle: saved.twitterHandle || null,
    instagramHandle: saved.instagramHandle || null,
    tiktokHandle: saved.tiktokHandle || null,
    location: saved.location || null,
  };
  remember(creatorProfileKey(saved.id), profile);
}

/** The profile the owner last saved in this tab; always null for anyone else. */
export function useOwnerCreatorProfile(creatorId: string, viewerIsOwner: boolean): OwnerCreatorProfile | null {
  const value = useRemembered(viewerIsOwner ? creatorProfileKey(creatorId) : null);
  return (value as OwnerCreatorProfile | undefined) ?? null;
}

/** Between tests; a page still drawn keeps what it showed. */
export function clearOwnerPageEditsForTests(): void {
  edits.clear();
}
