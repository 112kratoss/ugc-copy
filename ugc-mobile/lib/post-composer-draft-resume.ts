import AsyncStorage from '@react-native-async-storage/async-storage';

import type { PostComposerDraft } from './post-new-view-model';

const POST_COMPOSER_DRAFT_STORAGE_KEY = 'magicbooklet.post.drafts.v1';
const POST_COMPOSER_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type PersistedPostComposerDraft = {
  draft: PostComposerDraft;
  step: 'details' | 'resources';
  updatedAt: string;
};

type PersistedPostComposerDraftMap = Record<string, PersistedPostComposerDraft>;

export function getPostComposerDraftStorageId(params: {
  userId: string;
  postId?: string | null;
  generationId?: string | null;
}) {
  const target = params.postId
    ? `edit:${params.postId}`
    : params.generationId
      ? `generation:${params.generationId}`
      : 'new';
  return `${params.userId}:${target}`;
}

export async function loadPersistedPostComposerDraft(
  storageId: string,
): Promise<PersistedPostComposerDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(POST_COMPOSER_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const entries = JSON.parse(raw) as PersistedPostComposerDraftMap;
    const entry = entries[storageId];
    if (!entry?.draft || (entry.step !== 'details' && entry.step !== 'resources')) {
      return null;
    }
    const updatedAt = Date.parse(entry.updatedAt);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > POST_COMPOSER_DRAFT_MAX_AGE_MS) {
      await clearPersistedPostComposerDraft(storageId);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export async function persistPostComposerDraft(
  storageId: string,
  value: Omit<PersistedPostComposerDraft, 'updatedAt'>,
) {
  try {
    const raw = await AsyncStorage.getItem(POST_COMPOSER_DRAFT_STORAGE_KEY);
    const entries = raw ? JSON.parse(raw) as PersistedPostComposerDraftMap : {};
    entries[storageId] = {
      ...value,
      updatedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(POST_COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Draft persistence is recovery-only and must never block publishing.
  }
}

export async function clearPersistedPostComposerDraft(storageId: string) {
  try {
    const raw = await AsyncStorage.getItem(POST_COMPOSER_DRAFT_STORAGE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw) as PersistedPostComposerDraftMap;
    if (!Object.prototype.hasOwnProperty.call(entries, storageId)) return;
    delete entries[storageId];
    if (Object.keys(entries).length === 0) {
      await AsyncStorage.removeItem(POST_COMPOSER_DRAFT_STORAGE_KEY);
      return;
    }
    await AsyncStorage.setItem(POST_COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Clearing recovery state must not block navigation.
  }
}

export function isPostComposerDraftMeaningful(draft: PostComposerDraft) {
  const hasAttribution = draft.madeWithRows.some((row) => (
    Boolean(row.modelLabel.trim())
    || Boolean(row.createTool)
    || Boolean(row.createModel)
    || !['', 'manual'].includes(row.toolSlug.trim().toLowerCase())
    || !['', 'manual'].includes(row.toolLabel.trim().toLowerCase())
  ));

  return Boolean(
    draft.title.trim()
    || draft.description.trim()
    || draft.contentText.trim()
    || draft.caption.trim()
    || draft.selectedGenerationId
    || draft.upload
    || draft.mediaItems.length > 0
    || draft.visibility !== 'public'
    || draft.resource.accessMode !== 'none'
    || draft.resource.cards.length > 0
    || draft.resource.previewText.trim()
    || hasAttribution
  );
}

export function getPostComposerDraftSignature(draft: PostComposerDraft) {
  return JSON.stringify(draft);
}
