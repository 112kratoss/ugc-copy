import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { claimAppReload, releaseAppReload, resetAppReloadClaim } from '../lib/app-reload-claim';
import {
  noteRootMount,
  noteRootUnmount,
  resetRootMountsForTest,
  ROOT_REMOUNT_RELOAD_GUARD_MS,
  shouldReloadOnRootMount,
  type RootRemountReloadDeps,
} from '../lib/root-remount-reload';

const NOW = 1_800_000_000_000;

function deps(overrides: Partial<RootRemountReloadDeps> = {}) {
  const written: number[] = [];
  const reloads: string[] = [];
  const value: RootRemountReloadDeps = {
    platform: 'android',
    dev: false,
    now: () => NOW,
    readLastReloadAt: async () => null,
    writeLastReloadAt: async (at) => {
      written.push(at);
    },
    reload: async (reason) => {
      reloads.push(reason);
    },
    ...overrides,
  };
  return { value, written, reloads };
}

describe('shouldReloadOnRootMount', () => {
  const base = { platform: 'android', dev: false, mountNumber: 2, liveRoots: 1, lastReloadAt: null, now: NOW } as const;

  it('keeps the first mount of a runtime', () => {
    expect(shouldReloadOnRootMount({ ...base, mountNumber: 1 })).toBe(false);
  });

  it('reloads a second or later mount on Android', () => {
    expect(shouldReloadOnRootMount(base)).toBe(true);
    expect(shouldReloadOnRootMount({ ...base, mountNumber: 3 })).toBe(true);
  });

  it('never reloads on iOS or the web', () => {
    expect(shouldReloadOnRootMount({ ...base, platform: 'ios' })).toBe(false);
    expect(shouldReloadOnRootMount({ ...base, platform: 'web' })).toBe(false);
  });

  it('never reloads a development build', () => {
    expect(shouldReloadOnRootMount({ ...base, dev: true })).toBe(false);
  });

  it('waits while another root is still mounted', () => {
    expect(shouldReloadOnRootMount({ ...base, liveRoots: 2 })).toBe(false);
    expect(shouldReloadOnRootMount({ ...base, liveRoots: 0 })).toBe(false);
  });

  it('does not reload again inside the guard window, and does after it', () => {
    expect(shouldReloadOnRootMount({ ...base, lastReloadAt: NOW - 1_000 })).toBe(false);
    expect(shouldReloadOnRootMount({ ...base, lastReloadAt: NOW - ROOT_REMOUNT_RELOAD_GUARD_MS + 1 })).toBe(false);
    expect(shouldReloadOnRootMount({ ...base, lastReloadAt: NOW - ROOT_REMOUNT_RELOAD_GUARD_MS })).toBe(true);
  });

  it('treats a stored time in the future (a clock set back) as inside the window', () => {
    expect(shouldReloadOnRootMount({ ...base, lastReloadAt: NOW + 60_000 })).toBe(false);
  });
});

/** Android rebuilt the activity destroying the old one first: the old root goes, then the new one comes. */
async function destroyFirst(d: RootRemountReloadDeps) {
  await noteRootMount(d);
  await noteRootUnmount(d);
  return noteRootMount(d);
}

describe('noteRootMount', () => {
  beforeEach(() => {
    resetRootMountsForTest();
    resetAppReloadClaim();
  });

  it('leaves the first root mount alone, without touching storage', async () => {
    const read = vi.fn(async () => null);
    const d = deps({ readLastReloadAt: read });
    await expect(noteRootMount(d.value)).resolves.toBe('first-mount');
    expect(read).not.toHaveBeenCalled();
    expect(d.reloads).toEqual([]);
  });

  it('reloads once on the second mount, writing the time first', async () => {
    const order: string[] = [];
    const d = deps({
      writeLastReloadAt: async () => {
        order.push('write');
      },
      reload: async () => {
        order.push('reload');
      },
    });
    await expect(destroyFirst(d.value)).resolves.toBe('reloaded');
    expect(order).toEqual(['write', 'reload']);
  });

  it('waits for the old root to go when the new one mounts first, then reloads once', async () => {
    const d = deps();
    await noteRootMount(d.value);
    await expect(noteRootMount(d.value)).resolves.toBe('waiting');
    expect(d.reloads).toEqual([]);
    await expect(noteRootUnmount(d.value)).resolves.toBe('reloaded');
    expect(d.reloads).toHaveLength(1);
    // Anything after that in the dying runtime changes nothing.
    await expect(noteRootUnmount(d.value)).resolves.toBe('decided');
    expect(d.reloads).toHaveLength(1);
  });

  it('reloads after an error boundary remounts the root (it goes, then comes back)', async () => {
    const d = deps();
    await expect(destroyFirst(d.value)).resolves.toBe('reloaded');
  });

  it('does not reload a second mount on iOS or in development', async () => {
    for (const overrides of [{ platform: 'ios' }, { dev: true }] as const) {
      resetRootMountsForTest();
      const d = deps(overrides);
      await expect(destroyFirst(d.value)).resolves.toBe('kept');
      expect(d.reloads).toEqual([]);
    }
  });

  it('keeps a rebuild inside the guard window, and reloads a later one in the same runtime', async () => {
    let last: number | null = NOW - 2_000;
    let clock = NOW;
    const d = deps({ readLastReloadAt: async () => last, now: () => clock });
    await expect(destroyFirst(d.value)).resolves.toBe('kept');
    expect(d.reloads).toEqual([]);
    clock = NOW + ROOT_REMOUNT_RELOAD_GUARD_MS;
    last = NOW - 2_000;
    await noteRootUnmount(d.value);
    await expect(noteRootMount(d.value)).resolves.toBe('reloaded');
    expect(d.reloads).toHaveLength(1);
  });

  it('does not repeat a reload within the guard window', async () => {
    const d = deps({ readLastReloadAt: async () => NOW - 2_000 });
    await expect(destroyFirst(d.value)).resolves.toBe('kept');
    expect(d.reloads).toEqual([]);
    expect(d.written).toEqual([]);
  });

  it('never reloads when the stored time cannot be read', async () => {
    const d = deps({
      readLastReloadAt: async () => {
        throw new Error('storage unavailable');
      },
    });
    await expect(destroyFirst(d.value)).resolves.toBe('storage-failed');
    expect(d.reloads).toEqual([]);
  });

  it('never reloads when the time cannot be written', async () => {
    const d = deps({
      writeLastReloadAt: async () => {
        throw new Error('disk full');
      },
    });
    await expect(destroyFirst(d.value)).resolves.toBe('storage-failed');
    expect(d.reloads).toEqual([]);
  });

  it('leaves the reload to an update the OTA gate is already reloading into', async () => {
    expect(claimAppReload()).toBe(true);
    const d = deps();
    await expect(destroyFirst(d.value)).resolves.toBe('reload-under-way');
    expect(d.reloads).toEqual([]);
  });

  it('gives the claim back when its reload fails, so the OTA gate can still reload', async () => {
    const d = deps({
      reload: async () => {
        throw new Error('no activity');
      },
    });
    await expect(destroyFirst(d.value)).resolves.toBe('reload-failed');
    expect(claimAppReload()).toBe(true);
    releaseAppReload();
  });
});

/** Source assertions, as the other root-layout wiring tests make them: the layout cannot be mounted in vitest. */
describe('the root layout', () => {
  const source = readFileSync(path.resolve(__dirname, '..', 'app/_layout.tsx'), 'utf8');
  const code = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  it('counts its mounts from the outermost layout component', () => {
    expect(code).toMatch(/import \{ useRootRemountReload \} from '@\/lib\/root-remount-reload-native';/);
    const root = code.slice(code.indexOf('function RootLayout()'), code.indexOf('export default AppMetricsRoot.wrap(RootLayout)'));
    expect(root).toContain('useRootRemountReload();');
    expect(code.match(/useRootRemountReload\(\)/g)).toHaveLength(1);
  });
});

describe('the OTA gate', () => {
  it('claims the one reload before reloading into an update', () => {
    const gate = readFileSync(path.resolve(__dirname, '..', 'lib/use-ota-update-gate.ts'), 'utf8');
    expect(gate).toContain('claimAppReload()');
    expect(gate).toContain('releaseAppReload()');
  });
});
