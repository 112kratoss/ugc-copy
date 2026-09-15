import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  ImageCreationDraft,
  MotionCreationDraft,
  VideoCreationDraft,
} from './media-creation-view-model';

/**
 * Every draft is kept under this key plus a scope that names its identity.
 *
 * Builds before 2026-09-16 kept the ordinary Create draft under the bare key: one
 * draft for the whole phone, so whoever signed in next opened the last person's
 * prompt and references (audit A5). Nothing writes the bare key any more;
 * {@link loadOrdinaryCreationDrafts} reads what an older build left there once.
 */
const CREATION_DRAFT_STORAGE_KEY = 'magicbooklet.creation.drafts.v1';

export function creationDraftStorageKey(scope?: string) {
  return scope ? `${CREATION_DRAFT_STORAGE_KEY}:${encodeURIComponent(scope)}` : CREATION_DRAFT_STORAGE_KEY;
}

/** The ordinary Create draft of one identity: a registered account or a guest session. */
export function ordinaryDraftScope(identityUserId: string) {
  return JSON.stringify(['create', identityUserId]);
}

/**
 * Bumped when remix sessions saved under the previous scope must not be resumed.
 *
 * 2: remix restores before 2026-09-15 capped media at the placeholder draft model, whose
 * video default (kling-3.0-video) accepts no references, then autosaved the emptied draft.
 * Resuming one of those would hide the source's references for good, so they start again
 * from the source. Unsent edits in such a session are the price of that.
 *
 * 3: a session saved under 2 on 2026-09-15, while that fix was being verified, had lost a
 * reference and, with it, the @mention in the prompt. Remix drafts never expire and clear
 * only after a successful generation, so Recreate reopened it on every tap. Sessions saved
 * under 2 start again from the source too; 2 had been live for a few hours.
 *
 * 4: until 2026-09-15 a restore that began in the same commit as the catalog's first
 * normalization counted that normalization as the creator's edits, and saved them. A
 * Seedance 2 remix reopened at 16:9 carrying Kling's mode and isMultiShot, an image remix
 * at `auto`, and a motion remix as the empty default draft marked restored. Sessions saved
 * under 3 start again from the source.
 */
const REMIX_DRAFT_SCOPE_VERSION = 4;

export function remixDraftScope(userId: string | null, source?: { generationId?: string | null; postId?: string | null }) {
  if (!source?.generationId && !source?.postId) return undefined;
  // Sessions with no identity once shared a 'guest' scope. With no one to keep a
  // session for, none is kept.
  if (!userId) return undefined;
  return JSON.stringify(['remix', REMIX_DRAFT_SCOPE_VERSION, userId, source.postId ?? '', source.generationId ?? '']);
}

function isRemixDraftScope(scope: string) {
  try {
    const parsed: unknown = JSON.parse(scope);
    return Array.isArray(parsed) && parsed[0] === 'remix';
  } catch {
    return false;
  }
}

export type PersistedCreationDrafts = {
  image: ImageCreationDraft;
  video: VideoCreationDraft;
  motion: MotionCreationDraft;
  updatedAt: string;
  remixRestored?: boolean;
  remixEditedKeys?: Partial<Record<'image' | 'video' | 'motion', string[]>>;
};

function parsePersistedCreationDrafts(raw: string, { remix }: { remix: boolean }): PersistedCreationDrafts | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedCreationDrafts>;
    if (parsed.image?.tool !== 'image' || parsed.video?.tool !== 'video' || parsed.motion?.tool !== 'motion') {
      return null;
    }
    const drafts = {
      ...parsed,
      video: {
        ...parsed.video,
        preparedAudioIds: Array.isArray(parsed.video.preparedAudioIds)
          ? parsed.video.preparedAudioIds.filter((value): value is string => typeof value === 'string')
          : [],
        characterIds: Array.isArray(parsed.video.characterIds)
          ? parsed.video.characterIds.filter((value): value is string => typeof value === 'string')
          : [],
      },
    } as PersistedCreationDrafts;
    // The ordinary Create draft is never a remix. Builds from before remix
    // sessions got their own key wrote them into this one, so an install that
    // opened Remix back then is still holding a source id here — and the
    // reader's next ordinary creation would be counted as a remix of a post
    // they walked away from. Nothing else ever clears it: the id survives every
    // restart until some generation succeeds and takes the whole draft with it.
    if (!remix) {
      return {
        ...drafts,
        image: { ...drafts.image, sourceGenerationId: null },
        video: { ...drafts.video, sourceGenerationId: null },
        motion: { ...drafts.motion, sourceGenerationId: null },
      };
    }
    return drafts;
  } catch {
    return null;
  }
}

export async function loadPersistedCreationDrafts(scope: string): Promise<PersistedCreationDrafts | null> {
  // A storage outage is different from having no draft: callers must not
  // overwrite an unreadable existing session with a blank one.
  const raw = await AsyncStorage.getItem(creationDraftStorageKey(scope));
  if (!raw) return null;
  return parsePersistedCreationDrafts(raw, { remix: isRemixDraftScope(scope) });
}

export type CreationDraftIdentity = {
  identityUserId: string;
  /** When this identity's current session signed in (the session user's `last_sign_in_at`). */
  signedInAt: string | null | undefined;
};

/**
 * The identity's ordinary Create draft.
 *
 * An identity with no draft of its own may inherit the one an older build kept
 * for the whole phone, but only if its current session saved it: last saved at
 * or after that session signed in. No other identity can have been signed in on
 * the phone since then. A draft saved before, or one whose times cannot be read,
 * was written by whoever used the phone earlier, so it is dropped instead of
 * being handed to the next account. Either way the phone-wide copy is removed.
 */
export async function loadOrdinaryCreationDrafts({ identityUserId, signedInAt }: CreationDraftIdentity) {
  const scope = ordinaryDraftScope(identityUserId);
  const own = await loadPersistedCreationDrafts(scope);
  if (own) return own;

  const raw = await AsyncStorage.getItem(CREATION_DRAFT_STORAGE_KEY);
  if (!raw) return null;
  const phoneWide = parsePersistedCreationDrafts(raw, { remix: false });
  const savedAt = Date.parse(phoneWide?.updatedAt ?? '');
  const sessionStartedAt = Date.parse(signedInAt ?? '');
  const inherited = phoneWide && Number.isFinite(savedAt) && Number.isFinite(sessionStartedAt) && savedAt >= sessionStartedAt
    ? phoneWide
    : null;
  // Kept under the identity before the phone-wide copy goes, so a failure in
  // between leaves the same decision to be made again rather than a lost draft.
  if (inherited) await AsyncStorage.setItem(creationDraftStorageKey(scope), JSON.stringify(inherited));
  await AsyncStorage.removeItem(CREATION_DRAFT_STORAGE_KEY);
  return inherited;
}

export async function persistCreationDrafts(drafts: Omit<PersistedCreationDrafts, 'updatedAt'>, scope: string) {
  await AsyncStorage.setItem(creationDraftStorageKey(scope), JSON.stringify({
    ...drafts,
    updatedAt: new Date().toISOString(),
  }));
}

export async function clearPersistedCreationDrafts(scope: string) {
  await AsyncStorage.removeItem(creationDraftStorageKey(scope));
}
