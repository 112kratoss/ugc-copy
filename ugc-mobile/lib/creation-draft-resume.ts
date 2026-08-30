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

export function remixDraftScope(userId: string | null, source?: { generationId?: string | null; postId?: string | null }) {
  if (!source?.generationId && !source?.postId) return undefined;
  return JSON.stringify(['remix', userId ?? 'guest', source.postId ?? '', source.generationId ?? '']);
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
