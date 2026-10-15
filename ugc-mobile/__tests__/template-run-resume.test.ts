import { describe, expect, it, vi } from 'vitest';

import { normalizeTemplateRunResponse } from '../lib/media-templates';
import {
  forgetTemplateRun,
  loadRememberedTemplateRuns,
  loadResumableTemplateRun,
  loadResumableTemplateRuns,
  rememberTemplateRun,
} from '../lib/template-run-resume';
import type { TemplateRun, TemplateRunStatus } from '../lib/types';

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { values.delete(key); }),
  };
}

function run(id: string, templateId: string, status: TemplateRunStatus, isTest = false): TemplateRun {
  return normalizeTemplateRunResponse({
    run: { id, templateId, status, isTest, inputSlots: [], inputs: [], steps: [], result: null },
  }).run;
}

/** Reads answered from a table: a run, null for one that is gone, or an error for a read that fails. */
function reader(table: Record<string, TemplateRun | null | Error>) {
  return vi.fn(async (runId: string) => {
    const answer = table[runId];
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  });
}

describe('one remembered run per template (01-7)', () => {
  it('keeps a run for each template of each account, and forgets only the run it is asked to', async () => {
    const storage = createStorage();
    await rememberTemplateRun('user-1', run('run-a', 'template-a', 'processing'), storage);
    await rememberTemplateRun('user-1', run('run-b', 'template-b', 'collecting_inputs'), storage);
    await rememberTemplateRun('user-2', run('run-c', 'template-a', 'awaiting_approval'), storage);

    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({
      'template-a': { runId: 'run-a', started: true },
      'template-b': { runId: 'run-b', started: false },
    });
    await expect(loadRememberedTemplateRuns('user-2', storage)).resolves.toEqual({
      'template-a': { runId: 'run-c', started: true },
    });

    await expect(forgetTemplateRun('user-1', 'another-run', storage)).resolves.toBe(false);
    await expect(forgetTemplateRun('user-1', 'run-a', storage)).resolves.toBe(true);
    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({
      'template-b': { runId: 'run-b', started: false },
    });
  });

  it('never lets a run still collecting its uploads take the place of one that started', async () => {
    const storage = createStorage();
    await rememberTemplateRun('user-1', run('paid', 'template-a', 'awaiting_approval'), storage);

    await expect(rememberTemplateRun('user-1', run('empty', 'template-a', 'collecting_inputs'), storage)).resolves.toBe(false);
    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({ 'template-a': { runId: 'paid', started: true } });

    // Once the new run starts it is the one to come back to.
    await expect(rememberTemplateRun('user-1', run('empty', 'template-a', 'queued'), storage)).resolves.toBe(true);
    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({ 'template-a': { runId: 'empty', started: true } });
  });

  it('writes nothing when the run is already remembered as it is, and never remembers a creator test', async () => {
    const storage = createStorage();
    await rememberTemplateRun('user-1', run('run-a', 'template-a', 'collecting_inputs'), storage);
    await expect(rememberTemplateRun('user-1', run('run-a', 'template-a', 'collecting_inputs'), storage)).resolves.toBe(false);
    await expect(rememberTemplateRun('user-1', run('run-a', 'template-a', 'processing'), storage)).resolves.toBe(true);
    await expect(rememberTemplateRun('user-1', run('run-a', 'template-a', 'awaiting_approval'), storage)).resolves.toBe(false);
    expect(storage.setItem).toHaveBeenCalledTimes(2);

    await expect(rememberTemplateRun('user-1', run('test-run', 'template-b', 'processing', true), storage)).resolves.toBe(false);
    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({ 'template-a': { runId: 'run-a', started: true } });
  });

  it('keeps both runs when two templates are remembered at once', async () => {
    const storage = createStorage();
    await Promise.all([
      rememberTemplateRun('user-1', run('run-a', 'template-a', 'processing'), storage),
      rememberTemplateRun('user-1', run('run-b', 'template-b', 'processing'), storage),
    ]);

    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({
      'template-a': { runId: 'run-a', started: true },
      'template-b': { runId: 'run-b', started: true },
    });
  });

  it('offers the runs still going, forgets those that ended or are gone, and keeps one it could not read', async () => {
    const storage = createStorage();
    for (const [id, templateId] of [['going', 't-going'], ['done', 't-done'], ['gone', 't-gone'], ['offline', 't-offline']]) {
      await rememberTemplateRun('user-1', run(id, templateId, 'processing'), storage);
    }
    const going = run('going', 't-going', 'awaiting_approval');
    const readRun = reader({ going, done: run('done', 't-done', 'succeeded'), gone: null, offline: new Error('Network request failed.') });

    await expect(loadResumableTemplateRuns({ userId: 'user-1', readRun, storage })).resolves.toEqual({ 't-going': going });

    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({
      't-going': { runId: 'going', started: true },
      't-offline': { runId: 'offline', started: true },
    });
  });

  it('offers one template’s run on its own page, and nothing once it has ended', async () => {
    const storage = createStorage();
    await rememberTemplateRun('user-1', run('run-a', 'template-a', 'processing'), storage);
    await rememberTemplateRun('user-1', run('run-b', 'template-b', 'processing'), storage);
    const going = run('run-a', 'template-a', 'processing');
    const readRun = reader({ 'run-a': going, 'run-b': run('run-b', 'template-b', 'cancelled') });

    await expect(loadResumableTemplateRun({ userId: 'user-1', templateId: 'template-a', readRun, storage })).resolves.toEqual(going);
    expect(readRun).toHaveBeenCalledTimes(1);
    await expect(loadResumableTemplateRun({ userId: 'user-1', templateId: 'template-b', readRun, storage })).resolves.toBeNull();
    await expect(loadResumableTemplateRun({ userId: 'user-1', templateId: 'template-c', readRun, storage })).resolves.toBeNull();
    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({ 'template-a': { runId: 'run-a', started: true } });
  });

  it('moves the run the old one-per-account slot held to its template’s place, once', async () => {
    const legacyKey = 'magicbooklet:active-template-run:user-1';
    const storage = createStorage({ [legacyKey]: 'old-run' });
    const going = run('old-run', 'template-a', 'awaiting_approval');
    const readRun = reader({ 'old-run': going });

    await expect(loadResumableTemplateRuns({ userId: 'user-1', readRun, storage })).resolves.toEqual({ 'template-a': going });
    expect(storage.values.has(legacyKey)).toBe(false);
    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({ 'template-a': { runId: 'old-run', started: true } });
  });

  it('drops an old slot whose run has ended, and keeps one it could not read for the next time', async () => {
    const legacyKey = 'magicbooklet:active-template-run:user-1';
    const ended = createStorage({ [legacyKey]: 'old-run' });
    await expect(loadResumableTemplateRuns({ userId: 'user-1', readRun: reader({ 'old-run': run('old-run', 'template-a', 'failed') }), storage: ended })).resolves.toEqual({});
    expect(ended.values.has(legacyKey)).toBe(false);
    await expect(loadRememberedTemplateRuns('user-1', ended)).resolves.toEqual({});

    const offline = createStorage({ [legacyKey]: 'old-run' });
    await expect(loadResumableTemplateRun({ userId: 'user-1', templateId: 'template-a', readRun: reader({ 'old-run': new Error('Network request failed.') }), storage: offline })).resolves.toBeNull();
    expect(offline.values.get(legacyKey)).toBe('old-run');
  });

  it('reads nothing that a stored list it cannot parse would name', async () => {
    const storage = createStorage({ 'magicbooklet:template-runs:user-1': '{not json' });
    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({});
    await rememberTemplateRun('user-1', run('run-a', 'template-a', 'processing'), storage);
    await expect(loadRememberedTemplateRuns('user-1', storage)).resolves.toEqual({ 'template-a': { runId: 'run-a', started: true } });
  });
});
