import AsyncStorage from '@react-native-async-storage/async-storage';

import { isTemplateRunTerminal } from './media-templates';
import type { TemplateRun } from './types';

type ResumeStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * The run each template's card and page offer to resume, by template id: one
 * per template. `started` says the run had left `collecting_inputs` when it
 * was last remembered.
 */
export type RememberedTemplateRuns = Record<string, { runId: string; started: boolean }>;

type RememberableRun = Pick<TemplateRun, 'id' | 'templateId' | 'status'> & { isTest?: boolean };

/** A run read again: null when it is gone (or is another account's), and a throw when it could not be read. */
export type ReadTemplateRun = (runId: string) => Promise<TemplateRun | null>;

const TEMPLATE_RUNS_KEY_PREFIX = 'magicbooklet:template-runs:';
// Until 2026-10-15 one run was kept per account, whichever had been shown
// last, so opening a second run dropped the first from Templates (01-7).
const LEGACY_ACTIVE_RUN_KEY_PREFIX = 'magicbooklet:active-template-run:';

function runsKey(userId: string) {
  return `${TEMPLATE_RUNS_KEY_PREFIX}${userId}`;
}

function legacyRunKey(userId: string) {
  return `${LEGACY_ACTIVE_RUN_KEY_PREFIX}${userId}`;
}

let pendingChange: Promise<unknown> = Promise.resolve();

/** One change at a time: two screens remembering at once would each write back a list without the other's run. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = pendingChange.then(task);
  pendingChange = next.catch(() => undefined);
  return next;
}

function parseRuns(value: string | null): RememberedTemplateRuns {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const runs: RememberedTemplateRuns = {};
  for (const [templateId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const record = entry && typeof entry === 'object' ? entry as { runId?: unknown; started?: unknown } : {};
    if (templateId.trim() && typeof record.runId === 'string' && record.runId.trim()) {
      runs[templateId] = { runId: record.runId, started: record.started === true };
    }
  }
  return runs;
}

async function readRuns(userId: string, storage: ResumeStorage) {
  return parseRuns(await storage.getItem(runsKey(userId)));
}

async function writeRuns(userId: string, runs: RememberedTemplateRuns, storage: ResumeStorage) {
  if (Object.keys(runs).length) await storage.setItem(runsKey(userId), JSON.stringify(runs));
  else await storage.removeItem(runsKey(userId));
}

export function templateRunHasStarted(status: TemplateRun['status']) {
  return status !== 'collecting_inputs';
}

export function loadRememberedTemplateRuns(
  userId: string,
  storage: ResumeStorage = AsyncStorage,
): Promise<RememberedTemplateRuns> {
  if (!userId.trim()) return Promise.resolve({});
  return serialized(() => readRuns(userId, storage));
}

/**
 * Remember a run as its template's, and say whether anything changed. A run
 * still waiting for its uploads never takes the place of one that had
 * started: that one is spending credits, and an empty run costs nothing to
 * start again. A creator's test run is finished on the web canvas, so it is
 * never offered here.
 */
export function rememberTemplateRun(
  userId: string,
  run: RememberableRun,
  storage: ResumeStorage = AsyncStorage,
): Promise<boolean> {
  if (!userId.trim() || !run.id.trim() || !run.templateId.trim() || run.isTest) return Promise.resolve(false);
  const started = templateRunHasStarted(run.status);
  return serialized(async () => {
    const runs = await readRuns(userId, storage);
    const current = runs[run.templateId];
    if (current?.runId === run.id && current.started === started) return false;
    if (current && current.runId !== run.id && current.started && !started) return false;
    await writeRuns(userId, { ...runs, [run.templateId]: { runId: run.id, started } }, storage);
    return true;
  });
}

/** Forget a run wherever it is remembered, and say whether it was; a template that has since remembered another run keeps it. */
export function forgetTemplateRun(
  userId: string,
  runId: string,
  storage: ResumeStorage = AsyncStorage,
): Promise<boolean> {
  if (!userId.trim() || !runId.trim()) return Promise.resolve(false);
  return serialized(async () => {
    const runs = await readRuns(userId, storage);
    const kept = Object.fromEntries(Object.entries(runs).filter(([, entry]) => entry.runId !== runId));
    if (Object.keys(kept).length === Object.keys(runs).length) return false;
    await writeRuns(userId, kept, storage);
    return true;
  });
}

/**
 * The run read again, or null when it is not offered. One that has ended or
 * is gone gives up its template's place; one that could not be read keeps it
 * and is offered once a read succeeds.
 */
async function readResumableRun(userId: string, runId: string, readRun: ReadTemplateRun, storage: ResumeStorage) {
  let run: TemplateRun | null;
  try {
    run = await readRun(runId);
  } catch {
    return null;
  }
  if (!run || isTemplateRunTerminal(run.status)) {
    await forgetTemplateRun(userId, runId, storage);
    return null;
  }
  return run;
}

/** The run the old one-per-account slot held moves to its template's place, once. */
async function adoptLegacyTemplateRun(userId: string, readRun: ReadTemplateRun, storage: ResumeStorage) {
  const runId = (await storage.getItem(legacyRunKey(userId)))?.trim();
  if (!runId) return;
  let run: TemplateRun | null;
  try {
    run = await readRun(runId);
  } catch {
    // Kept, and read again next time.
    return;
  }
  if (run && !isTemplateRunTerminal(run.status)) await rememberTemplateRun(userId, run, storage);
  await storage.removeItem(legacyRunKey(userId));
}

/** Every remembered run worth resuming, by template id (the catalog's cards). */
export async function loadResumableTemplateRuns({
  userId,
  readRun,
  storage = AsyncStorage,
}: {
  userId: string;
  readRun: ReadTemplateRun;
  storage?: ResumeStorage;
}): Promise<Record<string, TemplateRun>> {
  if (!userId.trim()) return {};
  await adoptLegacyTemplateRun(userId, readRun, storage);
  const remembered = await loadRememberedTemplateRuns(userId, storage);
  const runs = await Promise.all(Object.entries(remembered).map(async ([templateId, { runId }]) => (
    [templateId, await readResumableRun(userId, runId, readRun, storage)] as const
  )));
  return Object.fromEntries(runs.filter((entry): entry is readonly [string, TemplateRun] => entry[1] !== null));
}

/** The one template's remembered run, when it is worth resuming (the template's page). */
export async function loadResumableTemplateRun({
  userId,
  templateId,
  readRun,
  storage = AsyncStorage,
}: {
  userId: string;
  templateId: string;
  readRun: ReadTemplateRun;
  storage?: ResumeStorage;
}): Promise<TemplateRun | null> {
  if (!userId.trim() || !templateId.trim()) return null;
  await adoptLegacyTemplateRun(userId, readRun, storage);
  const remembered = (await loadRememberedTemplateRuns(userId, storage))[templateId];
  return remembered ? readResumableRun(userId, remembered.runId, readRun, storage) : null;
}
