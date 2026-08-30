import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: storage,
}));

import { clearPersistedCreationDrafts, creationDraftStorageKey, loadPersistedCreationDrafts, persistCreationDrafts, remixDraftScope } from '../lib/creation-draft-resume';
import { createDefaultCreationDraft } from '../lib/media-creation-view-model';

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

  // Before remix sessions had their own key, the remix editor autosaved into
  // this one. An install from back then still holds that lineage, and the next
  // ordinary creation would be attributed to a post the reader abandoned.
  it('drops remix lineage stranded in the ordinary Create draft by older builds', async () => {
    const polluted = JSON.stringify({
      image: { tool: 'image', sourceGenerationId: 'someone-elses-post' },
      video: { tool: 'video', sourceGenerationId: 'someone-elses-post' },
      motion: { tool: 'motion', sourceGenerationId: 'someone-elses-post' },
      updatedAt: '2026-08-30T00:00:00.000Z',
    });

    storage.getItem.mockResolvedValue(polluted);
    await expect(loadPersistedCreationDrafts()).resolves.toMatchObject({
      image: { sourceGenerationId: null },
      video: { sourceGenerationId: null },
      motion: { sourceGenerationId: null },
    });

    // A remix session's own draft is the one place the lineage belongs.
    storage.getItem.mockResolvedValue(polluted);
    await expect(loadPersistedCreationDrafts(remixDraftScope('user', { generationId: 'gen-1' }))).resolves.toMatchObject({
      image: { sourceGenerationId: 'someone-elses-post' },
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

  it('isolates normal drafts, distinct remix sources, and different accounts', async () => {
    const memory = new Map<string, string>();
    storage.getItem.mockImplementation(async (key: string) => memory.get(key) ?? null);
    storage.setItem.mockImplementation(async (key: string, value: string) => { memory.set(key, value); });
    storage.removeItem.mockImplementation(async (key: string) => { memory.delete(key); });
    const drafts = { image: createDefaultCreationDraft('image'), video: createDefaultCreationDraft('video'), motion: createDefaultCreationDraft('motion') };
    await persistCreationDrafts({ ...drafts, image: { ...drafts.image, prompt: 'ordinary work' } });
    const scope = remixDraftScope('reader', { generationId: 'generation', postId: 'post' });
    await persistCreationDrafts({ ...drafts, image: { ...drafts.image, prompt: 'my remix' }, remixRestored: true }, scope);
    expect((await loadPersistedCreationDrafts())?.image.prompt).toBe('ordinary work');
    expect((await loadPersistedCreationDrafts(scope))?.image.prompt).toBe('my remix');
    expect((await loadPersistedCreationDrafts(scope))?.remixRestored).toBe(true);
    expect(await loadPersistedCreationDrafts(remixDraftScope('another reader', { generationId: 'generation', postId: 'post' }))).toBeNull();
    expect(await loadPersistedCreationDrafts(remixDraftScope('reader', { generationId: 'another generation', postId: 'post' }))).toBeNull();
    await clearPersistedCreationDrafts(scope);
    expect(memory.has(creationDraftStorageKey())).toBe(true);
  });
});
