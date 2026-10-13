import {
  CREATOR_DRAFT_TOOLS,
  creatorDraftStorageKey,
  getPersistedValue,
  removePersistedMedia,
  setPersistedValue,
  type CreatorDraftTool,
} from '@/lib/persisted-media';

export type { CreatorDraftTool } from '@/lib/persisted-media';

/**
 * A creator's text draft (prompt, model, settings, shots) for one tool and one
 * account, kept beside its staged media. Only the files used to survive a
 * reload, a top-up round trip or a lost session; the prompt and every setting
 * were gone.
 */
type StoredCreatorDraft<T> = {
  version: 1;
  savedAt: string;
  draft: T;
};

function isStoredCreatorDraft<T>(value: unknown): value is StoredCreatorDraft<T> {
  return Boolean(value)
    && typeof value === 'object'
    && (value as { version?: unknown }).version === 1
    && 'draft' in (value as object);
}

export async function loadCreatorDraft<T>(tool: CreatorDraftTool, userId: string): Promise<T | null> {
  const stored = await getPersistedValue<unknown>(creatorDraftStorageKey(tool, userId));
  // Another version is left in place: a newer build may have written it.
  return isStoredCreatorDraft<T>(stored) ? stored.draft : null;
}

export async function saveCreatorDraft<T>(tool: CreatorDraftTool, userId: string, draft: T): Promise<void> {
  const stored: StoredCreatorDraft<T> = { version: 1, savedAt: new Date().toISOString(), draft };
  await setPersistedValue(creatorDraftStorageKey(tool, userId), stored);
}

export async function clearCreatorDraft(tool: CreatorDraftTool, userId: string): Promise<void> {
  await removePersistedMedia(creatorDraftStorageKey(tool, userId));
}

export async function clearCreatorDraftsForUser(userId: string): Promise<void> {
  await Promise.all(CREATOR_DRAFT_TOOLS.map((tool) => clearCreatorDraft(tool, userId)));
}
