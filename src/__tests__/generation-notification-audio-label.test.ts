import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMobileNotificationHistory,
  withMobileNotificationHistory,
} from '@/__tests__/fixtures/mobile-notification-history';
import { processGenerationOutputImportJobs } from '@/lib/generation-output-import-jobs-processor';
import { syncGenerationStatusByPredictionId } from '@/lib/generation-status-sync';
import { notifyGenerationStatus } from '@/lib/mobile-notifications';
import { SOUND_EFFECT_MODELS, VOICEOVER_MODELS } from '@/lib/models';

// The provider key is read once, when the generation modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
});

type GenerationRow = {
  id: string;
  user_id: string;
  prediction_id: string;
  status: string;
  output_url: string | null;
  model: string;
  category: string | null;
  workflow_settings: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
};

type Status = 'succeeded' | 'failed';

/**
 * What the audio start services have written to `generations.model`, and what
 * the creator is told each one is. Both kinds are stored as `category:
 * 'audio'`, so the model is all that tells a voiceover from a sound effect.
 */
const STORED_AUDIO_MODELS: Array<[string, string]> = [
  ['elevenlabs/text-to-speech-turbo-2-5', 'voiceover'],
  ['elevenlabs/text-to-speech-multilingual-v2', 'voiceover'],
  ['elevenlabs/text-to-dialogue-v3', 'voiceover'],
  ['elevenlabs/sound-effect-v2', 'sound effect'],
];

/** Nothing but the notification history may be read: the name comes from the row the notifier is handed. */
const NO_OTHER_TABLES = {
  from(table: string) {
    throw new Error(`Unexpected table: ${table}`);
  },
  rpc(name: string) {
    throw new Error(`Unexpected call: ${name}`);
  },
} as unknown as SupabaseClient;

/** The notification the real notifier writes for one generation. */
async function notificationFor(
  generation: { category?: string | null; model?: string | null },
  status: Status,
) {
  const history = createMobileNotificationHistory();
  await notifyGenerationStatus(
    withMobileNotificationHistory(NO_OTHER_TABLES, history),
    // An ordinary creation, said to be one: left unsaid, the notifier reads the row to find out.
    { id: 'gen-1', user_id: 'user-1', template_run_id: null, ...generation },
    status,
  );

  expect(history.sent).toHaveLength(1);
  return history.sent[0];
}

async function titleFor(generation: { category?: string | null; model?: string | null }, status: Status) {
  return (await notificationFor(generation, status)).title;
}

describe('what an audio generation is called in its notification', () => {
  it.each(STORED_AUDIO_MODELS)('says a finished %s render is a %s', async (model, name) => {
    expect(await titleFor({ category: 'audio', model }, 'succeeded')).toBe(`Your ${name} is ready`);
  });

  it.each(STORED_AUDIO_MODELS)('says a failed %s render is a %s', async (model, name) => {
    expect(await titleFor({ category: 'audio', model }, 'failed')).toBe(`Your ${name} failed`);
  });

  it('has a name for every audio model the start services can store', async () => {
    // A model added to either table is named with it, by the id the provider
    // knows it by and by the id the app does.
    for (const model of Object.values(VOICEOVER_MODELS)) {
      for (const id of [model.apiModelId, model.id]) {
        expect(await titleFor({ category: 'audio', model: id }, 'succeeded'), id).toBe('Your voiceover is ready');
      }
    }
    for (const model of Object.values(SOUND_EFFECT_MODELS)) {
      for (const id of [model.apiModelId, model.id]) {
        expect(await titleFor({ category: 'audio', model: id }, 'succeeded'), id).toBe('Your sound effect is ready');
      }
    }
  });

  it.each([
    ['a model it has no name for', 'elevenlabs/music-v1'],
    ['no model', null],
    ['the model left out', undefined],
  ])('falls back to "audio" for an audio generation with %s', async (_case, model) => {
    expect(await titleFor({ category: 'audio', model }, 'succeeded')).toBe('Your audio is ready');
    expect(await titleFor({ category: 'audio', model }, 'failed')).toBe('Your audio failed');
  });

  it('names an audio model on a row that carries no category', async () => {
    expect(await titleFor({ category: null, model: 'elevenlabs/sound-effect-v2' }, 'succeeded'))
      .toBe('Your sound effect is ready');
    expect(await titleFor({ model: 'elevenlabs/text-to-dialogue-v3' }, 'failed'))
      .toBe('Your voiceover failed');
  });

  it('changes the title and nothing else', async () => {
    expect(await notificationFor({ category: 'audio', model: 'elevenlabs/sound-effect-v2' }, 'succeeded')).toEqual({
      user_id: 'user-1',
      actor_user_id: null,
      type: 'generation_succeeded',
      category: 'generation',
      title: 'Your sound effect is ready',
      body: 'Open it in your mobile history.',
      deep_link: '/viewer?source=studio-creations&initialId=gen-1',
      object_type: 'generation',
      object_id: 'gen-1',
      dedupe_key: 'generation:gen-1:succeeded',
      aggregation_key: null,
    });
    expect(await notificationFor({ category: 'audio', model: 'elevenlabs/text-to-speech-turbo-2-5' }, 'failed')).toEqual({
      user_id: 'user-1',
      actor_user_id: null,
      type: 'generation_failed',
      category: 'generation',
      title: 'Your voiceover failed',
      body: 'Open Magicbooklet to try again or adjust the prompt.',
      deep_link: '/viewer?source=studio-creations&initialId=gen-1',
      object_type: 'generation',
      object_id: 'gen-1',
      dedupe_key: 'generation:gen-1:failed',
      aggregation_key: null,
    });
  });
});

describe('what every other generation is still called', () => {
  it.each([
    ['image', 'nano-banana-pro', 'image'],
    ['video', 'kling-3.0/video', 'video'],
    ['ugc-ad', 'veo3_fast', 'video'],
    ['motion', 'kling-2.6/motion-control', 'motion render'],
    ['text', null, 'post'],
    [null, null, 'image'],
  ])('calls a %s generation made with %s a %s', async (category, model, name) => {
    expect(await titleFor({ category, model }, 'succeeded')).toBe(`Your ${name} is ready`);
    expect(await titleFor({ category, model }, 'failed')).toBe(`Your ${name} failed`);
  });
});

describe('the jobs that announce an audio generation', () => {
  function audioGeneration(overrides: Partial<GenerationRow> = {}): GenerationRow {
    return {
      id: 'gen-1',
      user_id: 'user-1',
      prediction_id: 'task-1',
      status: 'processing',
      output_url: null,
      model: 'elevenlabs/sound-effect-v2',
      category: 'audio',
      workflow_settings: { model: 'sound-effect-v2' },
      created_at: '2026-10-02T10:00:00.000Z',
      completed_at: null,
      ...overrides,
    };
  }

  /**
   * One generation, with the import ticket and the failure settlement the two
   * jobs call. A read returns only the columns it asked for, as Postgres does:
   * the name can be right only when the job reads `category` and `model`.
   */
  function createGenerationsClient(row: GenerationRow, importTickets: Array<Record<string, unknown>> = []) {
    return {
      from(table: string) {
        if (table !== 'generations') throw new Error(`Unexpected table: ${table}`);
        return {
          select(columns: string) {
            const asked = columns.split(',').map((column) => column.trim());
            return {
              eq(column: keyof GenerationRow, value: unknown) {
                return {
                  async single() {
                    if (row[column] !== value) {
                      return { data: null, error: { code: 'PGRST116', message: 'No rows found' } };
                    }
                    return {
                      data: Object.fromEntries(asked.map((name) => [name, row[name as keyof GenerationRow]])),
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
      async rpc(name: string) {
        if (name === 'claim_generation_output_import_jobs') {
          return { data: importTickets.splice(0, 1), error: null };
        }
        if (name === 'finish_generation_output_import_job') {
          return { data: 'succeeded', error: null };
        }
        if (name === 'settle_generation_failed') {
          row.status = 'failed';
          return { data: { status: 'failed', generation_id: row.id, refunded: true }, error: null };
        }
        throw new Error(`Unexpected call: ${name}`);
      },
    } as unknown as SupabaseClient;
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Nothing here may reach the network.');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('tells the creator their sound effect is ready once its file is imported', async () => {
    // The file is already stored, as on a ticket claimed a second time, so the
    // job goes straight to the announcement every finished render gets.
    const row = audioGeneration({
      status: 'succeeded',
      output_url: 'user-1/generated/sound-effect.mp3',
      completed_at: '2026-10-02T10:00:20.000Z',
    });
    const history = createMobileNotificationHistory();
    const client = withMobileNotificationHistory(
      createGenerationsClient(row, [{
        id: 'import-1',
        generation_id: 'gen-1',
        prediction_id: 'task-1',
        output_urls: ['https://provider.invalid/sound-effect.mp3'],
        provider_completed_at: '2026-10-02T10:00:20.000Z',
        status: 'processing',
        attempt_count: 1,
      }]),
      history,
    );

    await expect(processGenerationOutputImportJobs({ client, lockedBy: 'import-worker' }))
      .resolves.toEqual({ claimed: 1, completed: 1, retried: 0, exhausted: 0 });

    expect(history.sent).toEqual([expect.objectContaining({
      user_id: 'user-1',
      type: 'generation_succeeded',
      title: 'Your sound effect is ready',
      dedupe_key: 'generation:gen-1:succeeded',
    })]);
  });

  it('tells the creator their voiceover failed when the provider reports the failure', async () => {
    const row = audioGeneration({
      model: 'elevenlabs/text-to-speech-turbo-2-5',
      workflow_settings: { model: 'text-to-speech-turbo-2-5' },
    });
    const history = createMobileNotificationHistory();
    const client = withMobileNotificationHistory(createGenerationsClient(row), history);

    await expect(syncGenerationStatusByPredictionId({
      supabase: client,
      creditSupabase: client,
      predictionId: 'task-1',
      providerPayload: { data: { taskId: 'task-1', state: 'fail', failMsg: 'provider failure' } },
    })).resolves.toMatchObject({ found: true, status: 'failed' });

    expect(fetch).not.toHaveBeenCalled();
    expect(history.sent).toEqual([expect.objectContaining({
      user_id: 'user-1',
      type: 'generation_failed',
      title: 'Your voiceover failed',
      dedupe_key: 'generation:gen-1:failed',
    })]);
  });
});
