import { describe, expect, it, vi } from 'vitest';

import {
  clearActiveTemplateRun,
  loadActiveTemplateRunId,
  rememberActiveTemplateRun,
} from '../lib/template-run-resume';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { values.delete(key); }),
  };
}

describe('template run resume storage', () => {
  it('remembers active runs per account and clears only the matching run', async () => {
    const storage = createStorage();
    await rememberActiveTemplateRun('user-1', 'run-1', storage);
    await rememberActiveTemplateRun('user-2', 'run-2', storage);

    await expect(loadActiveTemplateRunId('user-1', storage)).resolves.toBe('run-1');
    await expect(loadActiveTemplateRunId('user-2', storage)).resolves.toBe('run-2');

    await clearActiveTemplateRun('user-1', 'another-run', storage);
    await expect(loadActiveTemplateRunId('user-1', storage)).resolves.toBe('run-1');

    await clearActiveTemplateRun('user-1', 'run-1', storage);
    await expect(loadActiveTemplateRunId('user-1', storage)).resolves.toBeNull();
  });
});
