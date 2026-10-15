// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate as the root layout runs it: expo-updates and AppState are doubles,
 * the policy and the activity locks are the real ones. The server's
 * `criticalUpdate` decides whether a downloaded update earns the sheet
 * (audit 04-9); the manifest's `extra.critical` stays a second source.
 */

const updates = vi.hoisted(() => ({
  state: {
    isUpdatePending: false,
    isRestarting: false,
    downloadedUpdate: undefined as unknown,
  },
  reloadAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-updates', () => ({
  isEnabled: true,
  reloadAsync: updates.reloadAsync,
  useUpdates: () => updates.state,
}));

const appState = vi.hoisted(() => ({ handlers: new Set<(state: string) => void>() }));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, handler: (state: string) => void) => {
      appState.handlers.add(handler);
      return { remove: () => appState.handlers.delete(handler) };
    },
  },
}));

import { __resetActivityLocksForTest, acquireActivityLock } from '../lib/app-activity';
import { useOtaUpdateGate, type OtaUpdateGate } from '../lib/use-ota-update-gate';
import type { MobileCriticalUpdate } from '../lib/types';

const RUNTIME = '02b8fe85566eac2e3f61a8ed82fa350c3ee03865';
const LEVER: MobileCriticalUpdate = {
  runtimeVersions: [RUNTIME, '4babc8b439ba5309615abbbe59baf79a23014d6c'],
  publishedAfter: '2026-10-15T07:40:00.000Z',
};

function downloaded({
  updateId = 'update-1',
  createdAt = '2026-10-15T08:00:00.000Z',
  runtimeVersion = RUNTIME,
  extra = {},
}: { updateId?: string; createdAt?: string; runtimeVersion?: string; extra?: Record<string, unknown> } = {}) {
  return {
    type: 'new',
    updateId,
    createdAt: new Date(createdAt),
    manifest: { id: updateId, createdAt, runtimeVersion, extra },
  };
}

function appVersion(criticalUpdate: MobileCriticalUpdate | null) {
  return {
    buildId: 'build-123',
    mobileCompatibility: {
      currentApiVersion: 1,
      minimumApiVersion: 1,
      minimumAppVersion: '0.0.5',
      supportedCatalogSchemaVersions: [1, 2, 3],
      unversionedClientsUseApiVersion: 1,
    },
    criticalUpdate,
  };
}

const api = vi.hoisted(() => ({ getAppVersion: vi.fn() }));
const probe = vi.hoisted(() => ({ gate: null as null | OtaUpdateGate }));

function GateProbe() {
  probe.gate = useOtaUpdateGate(api as never);
  return null;
}

const trees: renderer.ReactTestRenderer[] = [];

/** Lets the app-version answer land and the effects it wakes run. */
async function settle() {
  await act(async () => {
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  });
}

async function mountGate(element: React.ReactElement = <GateProbe />) {
  await act(async () => {
    trees.push(renderer.create(element));
  });
  await settle();
  return trees.at(-1)!;
}

async function downloadFinishes(update: ReturnType<typeof downloaded>, tree: renderer.ReactTestRenderer) {
  updates.state = { isUpdatePending: true, isRestarting: false, downloadedUpdate: update };
  await act(async () => { tree.update(<GateProbe />); });
  await settle();
}

async function returnFromBackground() {
  await act(async () => {
    for (const handler of [...appState.handlers]) handler('background');
  });
  await act(async () => {
    for (const handler of [...appState.handlers]) handler('active');
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.state = { isUpdatePending: false, isRestarting: false, downloadedUpdate: undefined };
  probe.gate = null;
});

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
  appState.handlers.clear();
  __resetActivityLocksForTest();
});

describe('the OTA gate’s critical decision', () => {
  it('asks the server once a download lands, and prompts when the server lists the update', async () => {
    api.getAppVersion.mockResolvedValue(appVersion(LEVER));
    const tree = await mountGate();
    // Nothing waiting: nothing to ask about.
    expect(api.getAppVersion).not.toHaveBeenCalled();

    await downloadFinishes(downloaded(), tree);

    expect(api.getAppVersion).toHaveBeenCalledTimes(1);
    expect(probe.gate?.criticalPromptVisible).toBe(true);
    // A prompt, never a reload under the person's eyes.
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('stays quiet for an update published before the instant', async () => {
    api.getAppVersion.mockResolvedValue(appVersion(LEVER));
    const tree = await mountGate();

    await downloadFinishes(downloaded({ createdAt: '2026-10-15T07:39:59.999Z' }), tree);

    expect(api.getAppVersion).toHaveBeenCalledTimes(1);
    expect(probe.gate?.criticalPromptVisible).toBe(false);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('stays quiet for a runtime the server does not list', async () => {
    api.getAppVersion.mockResolvedValue(appVersion(LEVER));
    const tree = await mountGate();

    await downloadFinishes(downloaded({ runtimeVersion: 'another-binary' }), tree);

    expect(probe.gate?.criticalPromptVisible).toBe(false);
  });

  it('stays quiet when the server flags nothing, unless the manifest itself says critical', async () => {
    api.getAppVersion.mockResolvedValue(appVersion(null));
    const tree = await mountGate();

    await downloadFinishes(downloaded(), tree);
    expect(probe.gate?.criticalPromptVisible).toBe(false);

    await downloadFinishes(downloaded({ updateId: 'update-2', extra: { critical: true } }), tree);
    expect(probe.gate?.criticalPromptVisible).toBe(true);
    // Each update downloaded is asked about once.
    expect(api.getAppVersion).toHaveBeenCalledTimes(2);
  });

  it('asks again on the next return when the first question went unanswered', async () => {
    api.getAppVersion
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(appVersion(LEVER));
    const tree = await mountGate();

    await downloadFinishes(downloaded(), tree);
    expect(probe.gate?.criticalPromptVisible).toBe(false);

    await returnFromBackground();

    expect(api.getAppVersion).toHaveBeenCalledTimes(2);
    expect(probe.gate?.criticalPromptVisible).toBe(true);
  });

  it('never prompts while a generation holds the activity lock, and prompts once it ends', async () => {
    api.getAppVersion.mockResolvedValue(appVersion(LEVER));
    const release = acquireActivityLock('generation');
    const tree = await mountGate();

    await downloadFinishes(downloaded(), tree);
    expect(probe.gate?.criticalPromptVisible).toBe(false);

    await act(async () => { release(); });
    expect(probe.gate?.criticalPromptVisible).toBe(true);
  });

  it('does not ask again after Not now, and Restart now reloads', async () => {
    api.getAppVersion.mockResolvedValue(appVersion(LEVER));
    const tree = await mountGate();
    await downloadFinishes(downloaded(), tree);

    await act(async () => { probe.gate!.dismissPrompt(); });
    expect(probe.gate?.criticalPromptVisible).toBe(false);
    await returnFromBackground();
    expect(probe.gate?.criticalPromptVisible).toBe(false);
    // The answer is known; returning does not ask the server again.
    expect(api.getAppVersion).toHaveBeenCalledTimes(1);

    await act(async () => { probe.gate!.applyNow(); });
    expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  // Fast Refresh, or an <Activity> shown again, runs every effect once more over kept state.
  it('asks once and still prompts after every effect runs again', async () => {
    api.getAppVersion.mockResolvedValue(appVersion(LEVER));
    updates.state = { isUpdatePending: true, isRestarting: false, downloadedUpdate: downloaded() };
    const inActivity = (mode: 'visible' | 'hidden') => <React.Activity mode={mode}><GateProbe /></React.Activity>;
    const tree = await mountGate(inActivity('visible'));
    expect(probe.gate?.criticalPromptVisible).toBe(true);

    await act(async () => { tree.update(inActivity('hidden')); });
    // Really hidden, so its AppState listener was removed.
    expect(appState.handlers.size).toBe(0);
    await act(async () => { tree.update(inActivity('visible')); });
    await settle();

    expect(api.getAppVersion).toHaveBeenCalledTimes(1);
    expect(appState.handlers.size).toBe(1);
    expect(probe.gate?.criticalPromptVisible).toBe(true);
  });
});
