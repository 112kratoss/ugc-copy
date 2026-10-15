import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  IDLE_CLOCK,
  advanceBackgroundClock,
  isCriticalUpdate,
  isFlaggedCriticalByServer,
  isReturnFromBackground,
  readCriticalFlag,
} from '../lib/ota-update-gate';
import type { MobileCriticalUpdate } from '../lib/types';

describe('readCriticalFlag', () => {
  it('only accepts a literal true', () => {
    expect(readCriticalFlag({ manifest: { extra: { critical: true } } })).toBe(true);
    // A publish command with `--extra critical=true` sends a string. Treating
    // that as urgent would let a typo earn the right to interrupt someone.
    expect(readCriticalFlag({ manifest: { extra: { critical: 'true' } } })).toBe(false);
    expect(readCriticalFlag({ manifest: { extra: { critical: 1 } } })).toBe(false);
    expect(readCriticalFlag({ manifest: { extra: { critical: false } } })).toBe(false);
  });

  it('is safe on every shape expo-updates can hand back', () => {
    expect(readCriticalFlag(undefined)).toBe(false);
    expect(readCriticalFlag(null)).toBe(false);
    expect(readCriticalFlag({})).toBe(false);
    // A rollback update carries manifest: undefined by design.
    expect(readCriticalFlag({ manifest: undefined })).toBe(false);
    expect(readCriticalFlag({ manifest: {} })).toBe(false);
    expect(readCriticalFlag({ manifest: { extra: null } })).toBe(false);
    expect(readCriticalFlag('nonsense')).toBe(false);
  });
});

describe('advanceBackgroundClock', () => {
  it('measures how long the app was away', () => {
    const left = advanceBackgroundClock(IDLE_CLOCK, 'background', 1_000);
    expect(left).toEqual({ backgroundedAt: 1_000, backgroundedForMs: 0 });

    const returned = advanceBackgroundClock(left, 'active', 1_000 + 45 * 60 * 1_000);
    expect(returned.backgroundedAt).toBeNull();
    expect(returned.backgroundedForMs).toBe(45 * 60 * 1_000);
  });

  it('does not restart the clock on the inactive → background pair', () => {
    // Every iOS backgrounding emits both. Restarting on the second would
    // discard the elapsed time and silently prevent the update from applying.
    const inactive = advanceBackgroundClock(IDLE_CLOCK, 'inactive', 1_000);
    const background = advanceBackgroundClock(inactive, 'background', 1_500);
    expect(background.backgroundedAt).toBe(1_000);

    const returned = advanceBackgroundClock(background, 'active', 1_000 + 60_000);
    expect(returned.backgroundedForMs).toBe(60_000);
  });

  it('reports zero when the app never actually left', () => {
    const returned = advanceBackgroundClock(IDLE_CLOCK, 'active', 5_000);
    expect(returned).toEqual({ backgroundedAt: null, backgroundedForMs: 0 });
  });

  it('never reports a negative duration if the clock moves backwards', () => {
    const left = advanceBackgroundClock(IDLE_CLOCK, 'background', 10_000);
    const returned = advanceBackgroundClock(left, 'active', 9_000);
    expect(returned.backgroundedForMs).toBe(0);
  });
});

describe('isReturnFromBackground', () => {
  it('is true only when the app had actually gone away', () => {
    const away = advanceBackgroundClock(IDLE_CLOCK, 'background', 1_000);
    expect(isReturnFromBackground(away, 'active')).toBe(true);
    expect(isReturnFromBackground(IDLE_CLOCK, 'active')).toBe(false);
  });

  it('treats inactive as staying, not returning', () => {
    // A notification-centre pull or a call banner reports `inactive` while the
    // app is still visibly on screen. Reloading there is a reload under the
    // user's eyes.
    const away = advanceBackgroundClock(IDLE_CLOCK, 'background', 1_000);
    expect(isReturnFromBackground(away, 'inactive')).toBe(false);
    expect(isReturnFromBackground(away, 'background')).toBe(false);
  });
});

/** The app-version answer's set example, shared with the server's tests. */
const contract = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../contracts/mobile-api-v1.json'), 'utf8'),
) as { endpoints: { appVersion: { response: { criticalUpdate: MobileCriticalUpdate | null }; responseVariants: { criticalUpdate: { criticalUpdate: MobileCriticalUpdate } } } } };
const LEVER = contract.endpoints.appVersion.responseVariants.criticalUpdate.criticalUpdate;
const [ANDROID_RUNTIME, IOS_RUNTIME] = LEVER.runtimeVersions;

/** A downloaded update as expo-updates' `useUpdates()` hands it over. */
function downloaded({
  createdAt,
  runtimeVersion = ANDROID_RUNTIME,
  extra = {},
}: {
  createdAt: string;
  runtimeVersion?: string;
  extra?: Record<string, unknown>;
}) {
  return {
    type: 'new',
    updateId: '0199e3a4-0000-7000-8000-000000000001',
    createdAt: new Date(createdAt),
    manifest: { id: '0199e3a4-0000-7000-8000-000000000001', createdAt, runtimeVersion, extra },
  };
}

// The publish script cannot set `extra.critical`, so the critical sheet never
// showed; the server's `criticalUpdate` is the lever an operator can pull
// (audit 04-9).
describe('isFlaggedCriticalByServer', () => {
  it('flags an update published for a listed runtime at or after the instant', () => {
    expect(isFlaggedCriticalByServer(downloaded({ createdAt: LEVER.publishedAfter }), LEVER)).toBe(true);
    expect(isFlaggedCriticalByServer(downloaded({ createdAt: '2026-10-15T09:00:00.000Z', runtimeVersion: IOS_RUNTIME }), LEVER)).toBe(true);
  });

  it('leaves an update published before the instant routine', () => {
    const justBefore = new Date(Date.parse(LEVER.publishedAfter) - 1).toISOString();
    expect(isFlaggedCriticalByServer(downloaded({ createdAt: justBefore }), LEVER)).toBe(false);
  });

  it('leaves another runtime routine: each binary looks for its own', () => {
    expect(isFlaggedCriticalByServer(downloaded({ createdAt: '2026-10-15T09:00:00.000Z', runtimeVersion: 'a-runtime-not-listed' }), LEVER)).toBe(false);
  });

  it('flags nothing when the server flags nothing', () => {
    const update = downloaded({ createdAt: '2026-10-15T09:00:00.000Z' });
    expect(contract.endpoints.appVersion.response.criticalUpdate).toBeNull();
    expect(isFlaggedCriticalByServer(update, contract.endpoints.appVersion.response.criticalUpdate)).toBe(false);
    expect(isFlaggedCriticalByServer(update, undefined)).toBe(false);
  });

  it('reads the manifest’s createdAt when expo-updates hands no Date', () => {
    const update = downloaded({ createdAt: '2026-10-15T09:00:00.000Z' });
    expect(isFlaggedCriticalByServer({ ...update, createdAt: undefined }, LEVER)).toBe(true);
  });

  it('is safe on every shape an answer or an update can take', () => {
    const update = downloaded({ createdAt: '2026-10-15T09:00:00.000Z' });
    // A rollback directive carries no manifest and is never the server's to flag.
    expect(isFlaggedCriticalByServer({ type: 'rollback', updateId: undefined, createdAt: new Date(), manifest: undefined }, LEVER)).toBe(false);
    expect(isFlaggedCriticalByServer(undefined, LEVER)).toBe(false);
    expect(isFlaggedCriticalByServer(update, { runtimeVersions: [ANDROID_RUNTIME], publishedAfter: 'soon' })).toBe(false);
    expect(isFlaggedCriticalByServer(update, { publishedAfter: LEVER.publishedAfter } as never)).toBe(false);
    expect(isFlaggedCriticalByServer({ ...update, createdAt: 'never', manifest: { ...update.manifest, createdAt: 'never' } }, LEVER)).toBe(false);
  });
});

describe('isCriticalUpdate', () => {
  it('keeps the manifest’s own flag as a second source', () => {
    const flagged = downloaded({ createdAt: '2026-10-01T00:00:00.000Z', extra: { critical: true } });
    expect(isCriticalUpdate(flagged, null)).toBe(true);
    expect(isCriticalUpdate(downloaded({ createdAt: '2026-10-01T00:00:00.000Z' }), null)).toBe(false);
    expect(isCriticalUpdate(downloaded({ createdAt: '2026-10-15T09:00:00.000Z' }), LEVER)).toBe(true);
  });
});
