import AsyncStorage from '@react-native-async-storage/async-storage';

type ResumeStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

const ACTIVE_TEMPLATE_RUN_KEY_PREFIX = 'magicbooklet:active-template-run:';

function storageKey(userId: string) {
  return `${ACTIVE_TEMPLATE_RUN_KEY_PREFIX}${userId}`;
}

export async function rememberActiveTemplateRun(
  userId: string,
  runId: string,
  storage: ResumeStorage = AsyncStorage
) {
  if (!userId.trim() || !runId.trim()) return;
  await storage.setItem(storageKey(userId), runId);
}

export async function loadActiveTemplateRunId(
  userId: string,
  storage: ResumeStorage = AsyncStorage
) {
  if (!userId.trim()) return null;
  const value = await storage.getItem(storageKey(userId));
  return value?.trim() || null;
}

export async function clearActiveTemplateRun(
  userId: string,
  runId?: string | null,
  storage: ResumeStorage = AsyncStorage
) {
  if (!userId.trim()) return;
  if (runId) {
    const remembered = await loadActiveTemplateRunId(userId, storage);
    if (remembered !== runId) return;
  }
  await storage.removeItem(storageKey(userId));
}
