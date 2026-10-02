import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/account-identity', () => ({ resolveLinkedAccountIds: async () => ['owner'] }));
vi.mock('@/lib/owned-media-url-batch', () => ({
  resolveOwnedStoredMediaUrlMap: async ({ outputUrls }: { outputUrls: Iterable<string> }) => new Map(
    Array.from(outputUrls, (path) => [path, `https://storage.example/${path}?token=signed`]),
  ),
}));

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import { listOwnerGenerationsForRoute, type OwnerGenerationsRouteClient } from '@/lib/owner-generations-route-service';

function clientFor(row: Record<string, unknown>) {
  return {
    from: (table: string) => ({
      select: (columns: string) => {
        // Only the columns the route asked for, as the database would answer.
        const data = table === 'generations'
          ? [Object.fromEntries(Object.entries(row).filter(([key]) => columns.split(',').map((c) => c.trim()).includes(key)))]
          : [];
        const query = {
          in: () => query, or: () => query, is: () => query, eq: () => query,
          order: () => query, range: () => query,
          then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
        };
        return query;
      },
    }),
  } as unknown as OwnerGenerationsRouteClient;
}

async function listOne(row: Record<string, unknown>, detail: 'summary' | 'full' = 'summary') {
  const client = clientFor(row);
  const result = await listOwnerGenerationsForRoute({
    userId: 'owner', supabase: client, getAdminSupabase: () => client,
    searchParams: new URLSearchParams(detail === 'summary' ? 'detail=summary' : ''),
  });
  return result.generations[0];
}

/** A finished voiceover as the import job leaves it (persistGeneratedOutput). */
const voiceover = {
  id: 'voiceover', user_id: 'owner', category: 'audio', model: 'elevenlabs/text-to-speech-turbo-2-5',
  status: 'succeeded', created_at: '2026-10-02T07:00:00Z', completed_at: '2026-10-02T07:00:20Z',
  prompt: 'Welcome to Magicbooklet.', title: null, description: null, cost: 4, duration: null,
  archived_at: null,
  output_url: 'generated_audio/owner/generated_task.mp3',
  preview_url: null, preview_status: 'failed',
};

describe('owner library: audio creations', () => {
  /**
   * The mobile app plays an audio creation from this payload: the file's signed
   * address on `output_url`, no visual descriptor to mistake it for a picture,
   * and the kind of sound it is. Nothing pinned any of it before.
   */
  it('delivers a voiceover as audio, with its file and its kind', async () => {
    const generation = await listOne(voiceover);

    expect(generation).toMatchObject({
      id: 'voiceover',
      category: 'audio',
      audioKind: 'voiceover',
      output_url: 'https://storage.example/generated_audio/owner/generated_task.mp3?token=signed',
      preview_url: null,
      media: null,
      creationMode: null,
    });
  });

  it.each([
    ['elevenlabs/text-to-speech-turbo-2-5', 'voiceover'],
    ['elevenlabs/text-to-speech-multilingual-v2', 'voiceover'],
    ['elevenlabs/text-to-dialogue-v3', 'voiceover'],
    ['elevenlabs/sound-effect-v2', 'sound-effect'],
    // Stored under the app id rather than the provider id.
    ['sound-effect-v2', 'sound-effect'],
    // Audio from a model in neither table is still audio.
    ['some-future/music-model', 'audio'],
  ])('names the kind of sound from the model (%s is %s)', async (model, audioKind) => {
    expect(await listOne({ ...voiceover, model })).toMatchObject({ category: 'audio', audioKind });
  });

  it('names the kind on the full read as well as the summary', async () => {
    expect(await listOne(voiceover, 'full')).toMatchObject({ category: 'audio', audioKind: 'voiceover' });
  });

  it('calls a row audio when only its file or its model says so', async () => {
    // No category on the row: the file is a sound file.
    expect(await listOne({ ...voiceover, category: null, model: 'unlisted-model' }))
      .toMatchObject({ category: 'audio', audioKind: 'audio', media: null });
    // No category and no file yet: the model is an audio model.
    expect(await listOne({ ...voiceover, category: null, status: 'processing', output_url: null }))
      .toMatchObject({ category: 'audio', audioKind: 'voiceover', media: null });
  });

  it('leaves pictures and videos without an audio kind', async () => {
    const image = await listOne({
      ...voiceover, id: 'image', category: 'image', model: 'nano-banana-2',
      output_url: 'generated_images/owner/source.png',
    });
    expect(image.category).toBe('image');
    expect(image).not.toHaveProperty('audioKind');
    expect(image.media).toMatchObject({ kind: 'image' });
  });

  it('matches the audio example in the shared mobile contract', async () => {
    const example = mobileApiContract.endpoints.listGenerations.response.generations
      .find((generation) => generation.category === 'audio');
    expect(example).toBeDefined();

    const generation = await listOne(voiceover);
    // Every field the contract documents for an audio creation is one the route sends.
    for (const key of Object.keys(example ?? {}).filter((field) => field !== 'previewUrl')) {
      expect(generation, `route payload is missing "${key}"`).toHaveProperty(key);
    }
    expect(example).toMatchObject({ audioKind: generation.audioKind, media: null, preview_url: null });
  });
});
