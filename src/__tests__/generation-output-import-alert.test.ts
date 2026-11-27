import { describe, expect, it, vi } from 'vitest';

import {
  collectGenerationOutputImportFailures,
  generationOutputImportAlertFromStatus,
} from '@/lib/generation-output-import-alert';

function createClient(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const name of ['select', 'gte', 'neq', 'order']) builder[name] = vi.fn(() => builder);
  builder.limit = vi.fn(async () => result);
  return { client: { from: vi.fn(() => builder) }, builder };
}

describe('generation output import alert', () => {
  const now = new Date('2026-11-27T12:00:00.000Z');

  it('reads jobs that exhausted their tries in the last day and have not succeeded since', async () => {
    const { client, builder } = createClient({
      data: [
        { status: 'failed', last_error: 'Remote media host is not allowlisted.' },
        { status: 'pending', last_error: 'Remote media host is not allowlisted.' },
        { status: 'failed', last_error: 'Bucket not found' },
      ],
      error: null,
    });

    const status = await collectGenerationOutputImportFailures(client as never, now);

    expect(client.from).toHaveBeenCalledWith('generation_output_import_jobs');
    expect(builder.gte).toHaveBeenCalledWith('attempt_count', 10);
    expect(builder.neq).toHaveBeenCalledWith('status', 'succeeded');
    expect(builder.gte).toHaveBeenCalledWith('updated_at', '2026-11-26T12:00:00.000Z');
    expect(status).toEqual({
      available: true,
      error: null,
      count: 3,
      truncated: false,
      byClass: { host_not_allowed: 2, storage_failed: 1 },
    });

    const alert = generationOutputImportAlertFromStatus(status);
    expect(alert).toEqual({
      code: 'GENERATION_OUTPUT_IMPORT_FAILING',
      message: expect.stringContaining('3 generation output import(s)'),
    });
    expect(alert?.message).toContain('host_not_allowed: 2');
    expect(alert?.message).toContain('storage_failed: 1');
    expect(alert?.message).toContain('MEDIA_IMPORT_HOST_ALLOWLIST');
  });

  it('raises nothing when no import is failing, and nothing it cannot read', async () => {
    const quiet = await collectGenerationOutputImportFailures(createClient({ data: [], error: null }).client as never, now);
    expect(generationOutputImportAlertFromStatus(quiet)).toBeNull();

    const unreadable = await collectGenerationOutputImportFailures({ service: 'supabase' } as never, now);
    expect(unreadable).toMatchObject({ available: false });
    expect(generationOutputImportAlertFromStatus(unreadable)).toBeNull();
  });
});
