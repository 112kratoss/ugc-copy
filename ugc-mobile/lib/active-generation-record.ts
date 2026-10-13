import AsyncStorage from '@react-native-async-storage/async-storage';

import type { CreatorToolId } from './types';

/**
 * The run a creator screen started and has not yet seen end, kept per identity.
 *
 * Once a start answered, the pending attempt was forgotten and the prediction id
 * lived only in the screen's state, so closing the creator, or the system killing
 * the app, lost the run: the reopened screen offered Generate on the saved draft,
 * and a press started and charged a second run (pipeline audit, finding 04-5). The
 * screen keeps this from the start's answer until the run reaches a terminal
 * status, and resumes polling from it when it opens again.
 */

export const ACTIVE_GENERATION_RECORD_STORAGE_PREFIX = 'magicbooklet.generation.activeRun.v1';
/** Past this a run is not resumed; whatever became of it is in Alerts and Profile → Creations. */
export const ACTIVE_GENERATION_RECORD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type ActiveGenerationRecord = {
  version: 1;
  identityUserId: string;
  tool: CreatorToolId;
  predictionId: string;
  generationId: string | null;
  /** When the run started, in epoch milliseconds, for the elapsed time and the age limit. */
  startedAt: number;
  /** The server's estimate of the whole run, when it gave one. */
  estimatedTotalMs: number | null;
};

type RecordStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

const TOOLS = new Set<CreatorToolId>(['image', 'video', 'motion']);

export function activeGenerationRecordStorageKey(identityUserId: string) {
  return `${ACTIVE_GENERATION_RECORD_STORAGE_PREFIX}:${encodeURIComponent(identityUserId)}`;
}

function parseRecord(raw: string): ActiveGenerationRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ActiveGenerationRecord>;
    if (
      value.version !== 1
      || typeof value.identityUserId !== 'string'
      || !TOOLS.has(value.tool as CreatorToolId)
      || typeof value.predictionId !== 'string' || !value.predictionId
      || !(value.generationId === null || (typeof value.generationId === 'string' && value.generationId))
      || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
      || !(value.estimatedTotalMs === null || (typeof value.estimatedTotalMs === 'number' && Number.isFinite(value.estimatedTotalMs)))
    ) {
      return null;
    }
    return value as ActiveGenerationRecord;
  } catch {
    return null;
  }
}

export async function saveActiveGenerationRecord(
  record: ActiveGenerationRecord,
  { storage = AsyncStorage }: { storage?: RecordStorage } = {},
) {
  await storage.setItem(activeGenerationRecordStorageKey(record.identityUserId), JSON.stringify(record));
}

/**
 * The identity's own active run, or null. A record that is unreadable, someone else's,
 * or older than two hours is removed rather than resumed.
 */
export async function loadActiveGenerationRecord(
  identityUserId: string,
  { storage = AsyncStorage, now = Date.now() }: { storage?: RecordStorage; now?: number } = {},
): Promise<ActiveGenerationRecord | null> {
  const key = activeGenerationRecordStorageKey(identityUserId);
  const raw = await storage.getItem(key);
  if (!raw) return null;
  const record = parseRecord(raw);
  if (
    !record
    || record.identityUserId !== identityUserId
    || now - record.startedAt > ACTIVE_GENERATION_RECORD_MAX_AGE_MS
  ) {
    await storage.removeItem(key).catch(() => undefined);
    return null;
  }
  return record;
}

export async function clearActiveGenerationRecord(
  identityUserId: string,
  { storage = AsyncStorage }: { storage?: RecordStorage } = {},
) {
  await storage.removeItem(activeGenerationRecordStorageKey(identityUserId));
}
