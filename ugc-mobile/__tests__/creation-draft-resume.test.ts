import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: storage,
}));

import { loadPersistedCreationDrafts } from '../lib/creation-draft-resume';

describe('creation draft resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrates legacy video drafts that predate prepared reference fields', async () => {
    storage.getItem.mockResolvedValue(JSON.stringify({
      image: { tool: 'image' },
      video: { tool: 'video' },
      motion: { tool: 'motion' },
      updatedAt: '2026-07-18T00:00:00.000Z',
    }));

    await expect(loadPersistedCreationDrafts()).resolves.toMatchObject({
      video: {
        preparedAudioIds: [],
        characterIds: [],
      },
    });
  });

  it('keeps valid prepared IDs and removes malformed persisted values', async () => {
    storage.getItem.mockResolvedValue(JSON.stringify({
      image: { tool: 'image' },
      video: {
        tool: 'video',
        preparedAudioIds: ['voice-1', 42, null],
        characterIds: ['character-1', false],
      },
      motion: { tool: 'motion' },
      updatedAt: '2026-07-18T00:00:00.000Z',
    }));

    await expect(loadPersistedCreationDrafts()).resolves.toMatchObject({
      video: {
        preparedAudioIds: ['voice-1'],
        characterIds: ['character-1'],
      },
    });
  });
});
