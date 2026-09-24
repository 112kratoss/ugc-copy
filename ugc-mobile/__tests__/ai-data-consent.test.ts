import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (_key: string): Promise<string | null> => null),
  setItem: vi.fn(async (_key: string, _value: string) => undefined),
  removeItem: vi.fn(async (_key: string) => undefined),
}));

const dialog = vi.hoisted(() => ({
  showConfirmDialog: vi.fn(async (_request: unknown) => false),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
    removeItem: (key: string) => storage.removeItem(key),
  },
}));

vi.mock('@/lib/dialog', () => dialog);

import {
  AI_DATA_CONSENT_MESSAGE,
  AI_DATA_CONSENT_STORAGE_KEY,
  AI_DATA_CONSENT_TITLE,
  AI_DATA_CONSENT_VERSION,
  AI_DATA_RECIPIENTS,
  AI_MODEL_MAKERS,
  ensureAiDataConsent,
  formatAiDataConsentDate,
  getAiDataConsentSnapshot,
  grantAiDataConsent,
  hasAiDataConsent,
  hydrateAiDataConsent,
  parseStoredAiDataConsent,
  resetAiDataConsentForTests,
  subscribeAiDataConsent,
  withAiDataConsent,
  withdrawAiDataConsent,
} from '../lib/ai-data-consent';

const STORED = JSON.stringify({ version: AI_DATA_CONSENT_VERSION, grantedAt: '2026-09-25T08:00:00.000Z' });

beforeEach(() => {
  resetAiDataConsentForTests();
  storage.getItem.mockReset().mockResolvedValue(null);
  storage.setItem.mockReset().mockResolvedValue(undefined);
  storage.removeItem.mockReset().mockResolvedValue(undefined);
  dialog.showConfirmDialog.mockReset().mockResolvedValue(false);
});

describe('what the question says', () => {
  // Guideline 5.1.2(i): say what is sent, name who receives it, and ask first.
  it('says what is sent: the prompt, and any photos, videos or audio', () => {
    expect(AI_DATA_CONSENT_MESSAGE).toContain('your prompt and any photos, videos or audio you add');
  });

  it('names Kie.ai and every company whose model can receive it', () => {
    expect(AI_DATA_CONSENT_MESSAGE).toContain('Kie.ai');
    expect(AI_DATA_RECIPIENTS).toContain('Kie.ai');
    for (const maker of AI_MODEL_MAKERS) {
      expect(AI_DATA_CONSENT_MESSAGE).toContain(maker);
      expect(AI_DATA_RECIPIENTS).toContain(maker);
    }
  });

  it('says why, what never goes, and where to change the answer', () => {
    expect(AI_DATA_CONSENT_MESSAGE).toContain('only to make your result');
    expect(AI_DATA_CONSENT_MESSAGE).toContain('never with your name or email');
    expect(AI_DATA_CONSENT_MESSAGE).toContain('Settings → AI data sharing');
  });

  it('asks a question short enough for the dialog title', () => {
    expect(AI_DATA_CONSENT_TITLE.endsWith('?')).toBe(true);
    expect(AI_DATA_CONSENT_TITLE.length).toBeLessThanOrEqual(60);
  });
});

describe('the stored answer', () => {
  it('reads only an answer of the current version with a real date', () => {
    expect(parseStoredAiDataConsent(STORED)).toEqual({ version: AI_DATA_CONSENT_VERSION, grantedAt: '2026-09-25T08:00:00.000Z' });
    expect(parseStoredAiDataConsent(JSON.stringify({ version: AI_DATA_CONSENT_VERSION + 1, grantedAt: '2026-09-25T08:00:00.000Z' }))).toBeNull();
    expect(parseStoredAiDataConsent(JSON.stringify({ version: AI_DATA_CONSENT_VERSION, grantedAt: 'soon' }))).toBeNull();
    expect(parseStoredAiDataConsent('{not json')).toBeNull();
    expect(parseStoredAiDataConsent('null')).toBeNull();
    expect(parseStoredAiDataConsent(null)).toBeNull();
  });

  it('restores an answer given before', async () => {
    storage.getItem.mockResolvedValue(STORED);
    await hydrateAiDataConsent();

    expect(storage.getItem).toHaveBeenCalledWith(AI_DATA_CONSENT_STORAGE_KEY);
    expect(getAiDataConsentSnapshot()).toEqual({ hydrated: true, grantedAt: '2026-09-25T08:00:00.000Z' });
  });

  it('treats a failed read as no permission, so the person is asked', async () => {
    storage.getItem.mockRejectedValue(new Error('disk'));
    await hydrateAiDataConsent();

    expect(getAiDataConsentSnapshot()).toEqual({ hydrated: true, grantedAt: null });
  });

  it('keeps an answer given while the first read was still in flight', async () => {
    let finishRead!: (raw: string | null) => void;
    storage.getItem.mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
    const reading = hydrateAiDataConsent();

    await withdrawAiDataConsent();
    finishRead(STORED);
    await reading;

    expect(hasAiDataConsent()).toBe(false);
    expect(getAiDataConsentSnapshot().hydrated).toBe(true);
  });

  it('tells subscribers when the answer changes', async () => {
    const listener = vi.fn();
    subscribeAiDataConsent(listener);

    await grantAiDataConsent(new Date('2026-09-25T09:30:00.000Z'));
    await withdrawAiDataConsent();

    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('ensureAiDataConsent', () => {
  it('lets a request through without asking once permission is stored', async () => {
    storage.getItem.mockResolvedValue(STORED);

    await expect(ensureAiDataConsent()).resolves.toBe(true);
    expect(dialog.showConfirmDialog).not.toHaveBeenCalled();
  });

  it('asks with the disclosure and the Allow pair iOS uses for permissions', async () => {
    await ensureAiDataConsent();

    expect(dialog.showConfirmDialog).toHaveBeenCalledWith({
      title: AI_DATA_CONSENT_TITLE,
      message: AI_DATA_CONSENT_MESSAGE,
      confirmLabel: 'Allow',
      cancelLabel: 'Don’t Allow',
    });
  });

  it('stores an Allow with its version and date, and does not ask again', async () => {
    dialog.showConfirmDialog.mockResolvedValue(true);

    await expect(ensureAiDataConsent()).resolves.toBe(true);
    expect(hasAiDataConsent()).toBe(true);
    const [key, value] = storage.setItem.mock.calls[0] ?? [];
    expect(key).toBe(AI_DATA_CONSENT_STORAGE_KEY);
    expect(parseStoredAiDataConsent(value ?? null)?.version).toBe(AI_DATA_CONSENT_VERSION);

    await expect(ensureAiDataConsent()).resolves.toBe(true);
    expect(dialog.showConfirmDialog).toHaveBeenCalledTimes(1);
  });

  it('sends nothing and stores nothing on Don’t Allow, and asks again next time', async () => {
    await expect(ensureAiDataConsent()).resolves.toBe(false);
    expect(hasAiDataConsent()).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();

    await ensureAiDataConsent();
    expect(dialog.showConfirmDialog).toHaveBeenCalledTimes(2);
  });

  it('asks once for a double tap, and only the tap that asked goes ahead', async () => {
    let answer!: (allowed: boolean) => void;
    dialog.showConfirmDialog.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const first = ensureAiDataConsent();
    const second = ensureAiDataConsent();
    await vi.waitFor(() => expect(dialog.showConfirmDialog).toHaveBeenCalledTimes(1));
    answer(true);

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(dialog.showConfirmDialog).toHaveBeenCalledTimes(1);
  });

  it('asks again after permission is withdrawn', async () => {
    storage.getItem.mockResolvedValue(STORED);
    await hydrateAiDataConsent();

    await withdrawAiDataConsent();
    expect(storage.removeItem).toHaveBeenCalledWith(AI_DATA_CONSENT_STORAGE_KEY);
    await ensureAiDataConsent();

    expect(dialog.showConfirmDialog).toHaveBeenCalledTimes(1);
  });

  it('keeps an Allow for this session even when it cannot be saved', async () => {
    dialog.showConfirmDialog.mockResolvedValue(true);
    storage.setItem.mockRejectedValue(new Error('disk full'));

    await expect(ensureAiDataConsent()).resolves.toBe(true);
    expect(hasAiDataConsent()).toBe(true);
  });
});

describe('withAiDataConsent', () => {
  it('runs the request only when permission is in hand', async () => {
    const send = vi.fn();

    await withAiDataConsent(send);
    expect(send).not.toHaveBeenCalled();

    dialog.showConfirmDialog.mockResolvedValue(true);
    await withAiDataConsent(send);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('formatAiDataConsentDate', () => {
  it('prints the day permission was given, and nothing for an unreadable value', () => {
    expect(formatAiDataConsentDate('2026-09-25T08:00:00.000Z')).toMatch(/2026/);
    expect(formatAiDataConsentDate('whenever')).toBe('');
  });
});
