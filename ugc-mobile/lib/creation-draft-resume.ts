import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  ImageCreationDraft,
  MotionCreationDraft,
  VideoCreationDraft,
} from './media-creation-view-model';

const CREATION_DRAFT_STORAGE_KEY = 'magicbooklet.creation.drafts.v1';

export function creationDraftStorageKey(scope?: string) {
  return scope ? `${CREATION_DRAFT_STORAGE_KEY}:${encodeURIComponent(scope)}` : CREATION_DRAFT_STORAGE_KEY;
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
 */
const REMIX_DRAFT_SCOPE_VERSION = 3;

export function remixDraftScope(userId: string | null, source?: { generationId?: string | null; postId?: string | null }) {
  if (!source?.generationId && !source?.postId) return undefined;
  return JSON.stringify(['remix', REMIX_DRAFT_SCOPE_VERSION, userId ?? 'guest', source.postId ?? '', source.generationId ?? '']);
}

export type PersistedCreationDrafts = {
  image: ImageCreationDraft;
  video: VideoCreationDraft;
  motion: MotionCreationDraft;
  updatedAt: string;
  remixRestored?: boolean;
  remixEditedKeys?: Partial<Record<'image' | 'video' | 'motion', string[]>>;
};

export async function loadPersistedCreationDrafts(scope?: string): Promise<PersistedCreationDrafts | null> {
  // A storage outage is different from having no draft: callers must not
  // overwrite an unreadable existing session with a blank one.
  const raw = await AsyncStorage.getItem(creationDraftStorageKey(scope));
  if (!raw) return null;
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
    if (!scope) {
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

export async function persistCreationDrafts(drafts: Omit<PersistedCreationDrafts, 'updatedAt'>, scope?: string) {
  await AsyncStorage.setItem(creationDraftStorageKey(scope), JSON.stringify({
    ...drafts,
    updatedAt: new Date().toISOString(),
  }));
}

export async function clearPersistedCreationDrafts(scope?: string) {
  await AsyncStorage.removeItem(creationDraftStorageKey(scope));
}
