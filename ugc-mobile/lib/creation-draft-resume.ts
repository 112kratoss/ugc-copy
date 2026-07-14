import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  ImageCreationDraft,
  MotionCreationDraft,
  VideoCreationDraft,
} from './media-creation-view-model';

const CREATION_DRAFT_STORAGE_KEY = 'magicbooklet.creation.drafts.v1';

export type PersistedCreationDrafts = {
  image: ImageCreationDraft;
  video: VideoCreationDraft;
  motion: MotionCreationDraft;
  updatedAt: string;
};

export async function loadPersistedCreationDrafts(): Promise<PersistedCreationDrafts | null> {
  try {
    const raw = await AsyncStorage.getItem(CREATION_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedCreationDrafts>;
    if (parsed.image?.tool !== 'image' || parsed.video?.tool !== 'video' || parsed.motion?.tool !== 'motion') {
      return null;
    }
    return parsed as PersistedCreationDrafts;
  } catch {
    return null;
  }
}

export async function persistCreationDrafts(drafts: Omit<PersistedCreationDrafts, 'updatedAt'>) {
  try {
    await AsyncStorage.setItem(CREATION_DRAFT_STORAGE_KEY, JSON.stringify({
      ...drafts,
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    // Draft persistence is recovery-only and must never block creation.
  }
}

export async function clearPersistedCreationDrafts() {
  await AsyncStorage.removeItem(CREATION_DRAFT_STORAGE_KEY).catch(() => undefined);
}
