import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (_key: string): Promise<string | null> => null),
  setItem: vi.fn(async (_key: string, _value: string) => undefined),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
  },
}));

import {
  CONTENT_POLICY_RULES,
  CONTENT_POLICY_STORAGE_KEY,
  CONTENT_POLICY_VERSION,
  acceptContentPolicy,
  getContentPolicySnapshot,
  hydrateContentPolicy,
  parseStoredContentPolicyAcceptance,
  resetContentPolicyForTests,
  subscribeContentPolicy,
} from '../lib/content-policy';

beforeEach(() => {
  resetContentPolicyForTests();
  storage.getItem.mockReset().mockResolvedValue(null);
  storage.setItem.mockReset().mockResolvedValue(undefined);
});

describe('content policy acceptance', () => {
  it('shows the rules until they are accepted on this phone', async () => {
    expect(getContentPolicySnapshot()).toEqual({ hydrated: false, acceptedAt: null });
    await hydrateContentPolicy();
    expect(storage.getItem).toHaveBeenCalledWith(CONTENT_POLICY_STORAGE_KEY);
    expect(getContentPolicySnapshot()).toEqual({ hydrated: true, acceptedAt: null });
  });

  it('remembers an acceptance for this version, with its date', async () => {
    const listener = vi.fn();
    subscribeContentPolicy(listener);

    await acceptContentPolicy(new Date('2026-09-30T10:00:00.000Z'));

    expect(getContentPolicySnapshot()).toEqual({ hydrated: true, acceptedAt: '2026-09-30T10:00:00.000Z' });
    expect(listener).toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalledWith(
      CONTENT_POLICY_STORAGE_KEY,
      JSON.stringify({ version: CONTENT_POLICY_VERSION, acceptedAt: '2026-09-30T10:00:00.000Z' }),
    );
  });

  it('reads a stored acceptance back at launch', async () => {
    storage.getItem.mockResolvedValue(JSON.stringify({ version: CONTENT_POLICY_VERSION, acceptedAt: '2026-09-30T10:00:00.000Z' }));
    await hydrateContentPolicy();
    expect(getContentPolicySnapshot().acceptedAt).toBe('2026-09-30T10:00:00.000Z');
  });

  it('asks again when the rules change version, or the stored answer is unreadable', () => {
    expect(parseStoredContentPolicyAcceptance(JSON.stringify({ version: CONTENT_POLICY_VERSION + 1, acceptedAt: '2026-09-30T10:00:00.000Z' }))).toBeNull();
    expect(parseStoredContentPolicyAcceptance(JSON.stringify({ version: CONTENT_POLICY_VERSION, acceptedAt: 'soon' }))).toBeNull();
    expect(parseStoredContentPolicyAcceptance('{not json')).toBeNull();
    expect(parseStoredContentPolicyAcceptance(null)).toBeNull();
  });

  it('keeps an acceptance given while the first read is still slow', async () => {
    let finishRead: (value: string | null) => void = () => undefined;
    storage.getItem.mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));

    const reading = hydrateContentPolicy();
    await acceptContentPolicy(new Date('2026-09-30T10:00:00.000Z'));
    finishRead(null);
    await reading;

    expect(getContentPolicySnapshot()).toEqual({ hydrated: true, acceptedAt: '2026-09-30T10:00:00.000Z' });
  });

  it('keeps the acceptance for this session when the write fails', async () => {
    storage.setItem.mockRejectedValue(new Error('disk full'));
    await acceptContentPolicy(new Date('2026-09-30T10:00:00.000Z'));
    expect(getContentPolicySnapshot().acceptedAt).toBe('2026-09-30T10:00:00.000Z');
  });

  it('states the rules the Terms of Service enforce', () => {
    const rules = CONTENT_POLICY_RULES.join(' ');
    expect(rules).toMatch(/under 18/);
    expect(rules).toMatch(/without their consent/);
    expect(rules).toMatch(/Nudity only in posts you mark mature/);
    expect(rules).toMatch(/gore/);
  });
});
