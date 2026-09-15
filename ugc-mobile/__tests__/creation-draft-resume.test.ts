import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: storage,
}));

import {
  CREATION_DRAFT_FORMAT,
  clearPersistedCreationDrafts,
  creationDraftStorageKey,
  loadOrdinaryCreationDrafts,
  loadPersistedCreationDrafts,
  ordinaryDraftScope,
  persistCreationDrafts,
  remixDraftScope,
} from '../lib/creation-draft-resume';
import { createDefaultCreationDraft } from '../lib/media-creation-view-model';

/** What builds before identity-scoped drafts wrote: one draft for the whole phone. */
const PHONE_WIDE_KEY = 'magicbooklet.creation.drafts.v1';

function useMemoryStorage(initial: Record<string, string> = {}) {
  const memory = new Map(Object.entries(initial));
  storage.getItem.mockImplementation(async (key: string) => memory.get(key) ?? null);
  storage.setItem.mockImplementation(async (key: string, value: string) => { memory.set(key, value); });
  storage.removeItem.mockImplementation(async (key: string) => { memory.delete(key); });
  return memory;
}

function defaultDrafts() {
  return { image: createDefaultCreationDraft('image'), video: createDefaultCreationDraft('video'), motion: createDefaultCreationDraft('motion') };
}

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

    await expect(loadPersistedCreationDrafts(ordinaryDraftScope('user'))).resolves.toMatchObject({
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
    await expect(loadPersistedCreationDrafts(ordinaryDraftScope('user'))).resolves.toMatchObject({
      image: { sourceGenerationId: null },
      video: { sourceGenerationId: null },
      motion: { sourceGenerationId: null },
    });

    // A remix session's own draft is the one place the lineage belongs.
    storage.getItem.mockResolvedValue(polluted);
    await expect(loadPersistedCreationDrafts(remixDraftScope('user', { generationId: 'gen-1' })!)).resolves.toMatchObject({
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

    await expect(loadPersistedCreationDrafts(ordinaryDraftScope('user'))).resolves.toMatchObject({
      video: {
        preparedAudioIds: ['voice-1'],
        characterIds: ['character-1'],
      },
    });
  });

  it('isolates normal drafts, distinct remix sources, and different accounts', async () => {
    const memory = useMemoryStorage();
    const drafts = defaultDrafts();
    const ordinary = ordinaryDraftScope('reader');
    await persistCreationDrafts({ ...drafts, image: { ...drafts.image, prompt: 'ordinary work' } }, ordinary);
    const scope = remixDraftScope('reader', { generationId: 'generation', postId: 'post' })!;
    await persistCreationDrafts({ ...drafts, image: { ...drafts.image, prompt: 'my remix' }, remixRestored: true }, scope);
    expect((await loadPersistedCreationDrafts(ordinary))?.image.prompt).toBe('ordinary work');
    expect((await loadPersistedCreationDrafts(scope))?.image.prompt).toBe('my remix');
    expect((await loadPersistedCreationDrafts(scope))?.remixRestored).toBe(true);
    expect(await loadPersistedCreationDrafts(remixDraftScope('another reader', { generationId: 'generation', postId: 'post' })!)).toBeNull();
    expect(await loadPersistedCreationDrafts(remixDraftScope('reader', { generationId: 'another generation', postId: 'post' })!)).toBeNull();
    await clearPersistedCreationDrafts(scope);
    expect(memory.has(creationDraftStorageKey(ordinary))).toBe(true);
  });

  // Audit A5, diagnostic counterexample 5: ordinary drafts saved under different
  // account ids resolved to the same unscoped storage key.
  it('keeps each identity’s ordinary draft under a key of its own', async () => {
    const memory = useMemoryStorage();
    const drafts = defaultDrafts();
    const signedInAt = '2026-09-16T09:00:00.000Z';

    expect(creationDraftStorageKey(ordinaryDraftScope('account-a'))).not.toBe(creationDraftStorageKey(ordinaryDraftScope('account-b')));
    expect(creationDraftStorageKey(ordinaryDraftScope('account-a'))).not.toBe(PHONE_WIDE_KEY);

    await persistCreationDrafts({ ...drafts, image: { ...drafts.image, prompt: 'account A private prompt' } }, ordinaryDraftScope('account-a'));

    await expect(loadOrdinaryCreationDrafts({ identityUserId: 'account-b', signedInAt })).resolves.toBeNull();
    await expect(loadOrdinaryCreationDrafts({ identityUserId: 'account-a', signedInAt })).resolves.toMatchObject({
      image: { prompt: 'account A private prompt' },
    });
    expect(memory.has(PHONE_WIDE_KEY)).toBe(false);
  });

  it('names its draft format for support diagnostics', () => {
    expect(CREATION_DRAFT_FORMAT).toBe('v1 per identity, remix 4');
  });

  it('keeps no remix session for a creator with no identity', () => {
    expect(remixDraftScope(null, { generationId: 'generation', postId: 'post' })).toBeUndefined();
    expect(remixDraftScope('reader', {})).toBeUndefined();
  });

  describe('a phone-wide draft left by an older build', () => {
    const signedInAt = '2026-09-16T09:00:00.000Z';
    const phoneWide = (prompt: string, updatedAt: string) => JSON.stringify({
      ...defaultDrafts(),
      image: { ...createDefaultCreationDraft('image'), prompt, sourceGenerationId: 'abandoned-remix' },
      updatedAt,
    });

    it('becomes the draft of the session that saved it, under that identity’s key', async () => {
      const memory = useMemoryStorage({ [PHONE_WIDE_KEY]: phoneWide('my unfinished prompt', '2026-09-16T09:30:00.000Z') });

      const inherited = await loadOrdinaryCreationDrafts({ identityUserId: 'account-a', signedInAt });

      expect(inherited).toMatchObject({ image: { prompt: 'my unfinished prompt', sourceGenerationId: null }, updatedAt: '2026-09-16T09:30:00.000Z' });
      expect(memory.has(PHONE_WIDE_KEY)).toBe(false);
      expect(JSON.parse(memory.get(creationDraftStorageKey(ordinaryDraftScope('account-a')))!)).toEqual(inherited);
    });

    it('is dropped, not handed over, when it was saved before this session signed in', async () => {
      const memory = useMemoryStorage({ [PHONE_WIDE_KEY]: phoneWide('the last person’s prompt', '2026-09-16T08:59:59.000Z') });

      await expect(loadOrdinaryCreationDrafts({ identityUserId: 'account-b', signedInAt })).resolves.toBeNull();

      expect([...memory.keys()]).toEqual([]);
    });

    it.each([
      ['the session’s sign-in time is unknown', phoneWide('a prompt', '2026-09-16T09:30:00.000Z'), undefined],
      ['the sign-in time is unreadable', phoneWide('a prompt', '2026-09-16T09:30:00.000Z'), 'not a time'],
      ['the draft has no save time', JSON.stringify({ ...defaultDrafts() }), signedInAt],
      ['the draft is unreadable', '{not json', signedInAt],
    ])('is dropped when %s', async (_label, raw, sessionSignedInAt) => {
      const memory = useMemoryStorage({ [PHONE_WIDE_KEY]: raw });

      await expect(loadOrdinaryCreationDrafts({ identityUserId: 'account-a', signedInAt: sessionSignedInAt })).resolves.toBeNull();

      expect([...memory.keys()]).toEqual([]);
    });

    it('never replaces a draft the identity already has', async () => {
      const own = JSON.stringify({ ...defaultDrafts(), image: { ...createDefaultCreationDraft('image'), prompt: 'my current draft' }, updatedAt: '2026-09-16T10:00:00.000Z' });
      const memory = useMemoryStorage({
        [PHONE_WIDE_KEY]: phoneWide('an older prompt', '2026-09-16T09:30:00.000Z'),
        [creationDraftStorageKey(ordinaryDraftScope('account-a'))]: own,
      });

      await expect(loadOrdinaryCreationDrafts({ identityUserId: 'account-a', signedInAt })).resolves.toMatchObject({
        image: { prompt: 'my current draft' },
      });
      expect(memory.get(creationDraftStorageKey(ordinaryDraftScope('account-a')))).toBe(own);
    });
  });

  // Remix restores before 2026-09-15 capped media at the placeholder video model, which
  // accepts no references, and autosaved the emptied draft (the unversioned scope). A
  // version 2 session saved while that fix was verified had lost a reference and its
  // @mention. A version 3 session could carry the catalog's own defaults saved as creator
  // edits. Resuming any of them reopens the wrong draft, so all of them restore afresh.
  it('does not resume remix sessions saved under earlier scopes', async () => {
    const memory = new Map<string, string>();
    storage.getItem.mockImplementation(async (key: string) => memory.get(key) ?? null);
    const drafts = defaultDrafts();
    const earlierScopes = [
      JSON.stringify(['remix', 'reader', 'post', 'generation']),
      JSON.stringify(['remix', 2, 'reader', 'post', 'generation']),
      JSON.stringify(['remix', 3, 'reader', 'post', 'generation']),
    ];
    for (const earlierScope of earlierScopes) {
      memory.set(creationDraftStorageKey(earlierScope), JSON.stringify({ ...drafts, remixRestored: true, updatedAt: '2026-09-15T02:05:00.000Z' }));
    }

    const scope = remixDraftScope('reader', { generationId: 'generation', postId: 'post' })!;

    expect(earlierScopes).not.toContain(scope);
    expect(await loadPersistedCreationDrafts(scope)).toBeNull();
  });
});
