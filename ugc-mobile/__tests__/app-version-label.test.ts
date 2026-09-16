import { beforeEach, describe, expect, it, vi } from 'vitest';

// The live iOS update for 5233d61, as its manifest arrived on build 52.
const UPDATE_GROUP = '00b2999e-1a0a-4145-8186-b823dfef9d1e';
const UPDATE_ID = '01a0a5b0-eae8-73ca-92fa-fa9388a1bcfe';

const native = vi.hoisted(() => ({
  application: null as { nativeApplicationVersion?: string | null; nativeBuildVersion?: string | null } | null,
  expoConfigVersion: null as string | null,
  iosBuildNumber: null as string | null,
  updates: {
    isEnabled: true,
    isEmbeddedLaunch: false,
    updateId: null as string | null,
    manifest: {} as unknown,
    runtimeVersion: null as string | null,
    channel: null as string | null,
  },
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) => (name === 'ExpoApplication' ? native.application : null),
}));

vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return native.expoConfigVersion ? { version: native.expoConfigVersion } : null;
    },
    get platform() {
      return { ios: native.iosBuildNumber ? { buildNumber: native.iosBuildNumber } : undefined };
    },
  },
}));

vi.mock('expo-updates', () => ({
  get isEnabled() {
    return native.updates.isEnabled;
  },
  get isEmbeddedLaunch() {
    return native.updates.isEmbeddedLaunch;
  },
  get updateId() {
    return native.updates.updateId;
  },
  get manifest() {
    return native.updates.manifest;
  },
  get runtimeVersion() {
    return native.updates.runtimeVersion;
  },
  get channel() {
    return native.updates.channel;
  },
}));

import { formatAppVersionLabel, readAppVersionParts, readUpdateRuntime } from '../lib/app-version-label';

beforeEach(() => {
  native.application = { nativeApplicationVersion: '0.1.4', nativeBuildVersion: '52' };
  native.expoConfigVersion = '0.1.4';
  native.iosBuildNumber = null;
  native.updates = {
    isEnabled: true,
    isEmbeddedLaunch: false,
    updateId: UPDATE_ID,
    manifest: { id: UPDATE_ID, metadata: { updateGroup: UPDATE_GROUP, branchName: 'production' } },
    runtimeVersion: '0.1.4',
    channel: 'production',
  };
});

describe('settings version label', () => {
  it('names the store version, the native build and the running update by its EAS group', () => {
    expect(formatAppVersionLabel(readAppVersionParts())).toBe('Version 0.1.4 (52) · update 00b2999e');
  });

  it('falls back to the update id when the manifest names no group', () => {
    native.updates.manifest = { id: UPDATE_ID };
    expect(formatAppVersionLabel(readAppVersionParts())).toBe('Version 0.1.4 (52) · update 01a0a5b0');
  });

  it('leaves the update out while the bundle embedded in the binary is running', () => {
    native.updates.isEmbeddedLaunch = true;
    expect(formatAppVersionLabel(readAppVersionParts())).toBe('Version 0.1.4 (52)');
  });

  it('leaves the update out where expo-updates is off, as in a dev client', () => {
    native.updates.isEnabled = false;
    expect(readAppVersionParts().update).toBeNull();
  });

  it('falls back to the app config when the application module is not linked', () => {
    native.application = null;
    native.iosBuildNumber = '52';
    expect(readAppVersionParts()).toEqual({ version: '0.1.4', build: '52', update: UPDATE_GROUP });

    native.iosBuildNumber = null;
    expect(formatAppVersionLabel(readAppVersionParts())).toBe('Version 0.1.4 · update 00b2999e');
  });

  it('shows no line without a version', () => {
    expect(formatAppVersionLabel({ version: null, build: '52', update: UPDATE_GROUP })).toBeNull();
  });

  // Support diagnostics: which runtime and channel this binary takes updates on.
  it('names the OTA runtime and channel, and neither where updates are off', () => {
    expect(readUpdateRuntime()).toEqual({ runtimeVersion: '0.1.4', channel: 'production' });
    native.updates.isEnabled = false;
    expect(readUpdateRuntime()).toEqual({ runtimeVersion: null, channel: null });
  });
});
