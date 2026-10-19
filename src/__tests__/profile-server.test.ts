import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findShareableProfileByUsername,
  recordSaverNoticeSeen,
} from '@/lib/profile-server';

type ProfileRow = { id: string; username: string | null; identity_state: 'active' | 'merged' | 'deleting' };

function createProfilesClient(rows: ProfileRow[]) {
  const selectedColumns: string[] = [];
  const client = {
    from: vi.fn((table: string) => {
      if (table !== 'profiles') throw new Error(`Unexpected table: ${table}`);
      return {
        select(columns: string) {
          selectedColumns.push(columns);
          return {
            eq(column: keyof ProfileRow, value: unknown) {
              return {
                async maybeSingle() {
                  return { data: rows.find((row) => row[column] === value) ?? null, error: null };
                },
              };
            },
          };
        },
      };
    }),
  } as unknown as SupabaseClient;

  return { client, selectedColumns };
}

describe('findShareableProfileByUsername', () => {
  it('resolves a handle, in any case and with a leading @, to the profile behind it', async () => {
    const { client } = createProfilesClient([{ id: 'creator-1', username: 'nova', identity_state: 'active' }]);

    await expect(findShareableProfileByUsername('@Nova', client)).resolves.toEqual({
      id: 'creator-1',
      username: 'nova',
    });
  });

  it('has nothing to share for an account whose deletion has started', async () => {
    const { client, selectedColumns } = createProfilesClient([
      { id: 'creator-1', username: 'nova', identity_state: 'deleting' },
    ]);

    await expect(findShareableProfileByUsername('nova', client)).resolves.toBeNull();
    expect(selectedColumns).toEqual([expect.stringContaining('identity_state')]);
  });

  it('answers null for an unknown or empty handle', async () => {
    const { client } = createProfilesClient([{ id: 'creator-1', username: 'nova', identity_state: 'active' }]);

    await expect(findShareableProfileByUsername('someone-else', client)).resolves.toBeNull();
    await expect(findShareableProfileByUsername('  @ ', client)).resolves.toBeNull();
  });
});

/**
 * A client that keeps every call its queries make, in order, and answers each
 * query in turn with the next of `results`, however it ends: `maybeSingle()`,
 * or awaited as it is.
 */
function createRecordingClient(...results: Array<{ data: unknown; error: unknown }>) {
  const calls: unknown[][] = [];
  const next = () => results.shift() ?? { data: null, error: null };
  const query: Record<string, unknown> = {};
  for (const method of ['select', 'update', 'eq', 'is']) {
    query[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  }
  query.maybeSingle = async () => {
    calls.push(['maybeSingle']);
    return next();
  };
  query.then = (resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) => (
    Promise.resolve(next()).then(resolve, reject)
  );
  const client = {
    from(table: string) {
      calls.push(['from', table]);
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

// The record is read with the profile both clients load; only its write lives here.
describe("the account's saver notice record", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the telling on that account alone, and only where none is on record, keeping the first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T08:30:00.000Z'));
    const { client, calls } = createRecordingClient({ data: [{ id: 'user-1' }], error: null });

    await expect(recordSaverNoticeSeen(client, 'user-1')).resolves.toBe(true);
    expect(calls).toEqual([
      ['from', 'profiles'],
      ['update', { saver_notice_seen_at: '2026-10-20T08:30:00.000Z' }],
      ['eq', 'id', 'user-1'],
      ['is', 'saver_notice_seen_at', null],
      ['select', 'id'],
    ]);
  });

  it('answers recorded for an account told before, whose first time is kept', async () => {
    const { client, calls } = createRecordingClient(
      { data: [], error: null },
      { data: { saver_notice_seen_at: '2026-10-19T09:00:00.000Z' }, error: null },
    );

    await expect(recordSaverNoticeSeen(client, 'user-1')).resolves.toBe(true);
    expect(calls.slice(5)).toEqual([
      ['from', 'profiles'],
      ['select', 'saver_notice_seen_at'],
      ['eq', 'id', 'user-1'],
      ['maybeSingle'],
    ]);
  });

  // Review 4 finding #20: an update that matched no row is not a record.
  it('answers not recorded for an account with no profile row', async () => {
    const { client } = createRecordingClient({ data: [], error: null }, { data: null, error: null });

    await expect(recordSaverNoticeSeen(client, 'user-1')).resolves.toBe(false);
  });

  it('throws what the database refused, on either query', async () => {
    const refusal = { message: 'permission denied for table profiles' };

    await expect(recordSaverNoticeSeen(createRecordingClient({ data: null, error: refusal }).client, 'user-1'))
      .rejects.toBe(refusal);
    await expect(recordSaverNoticeSeen(createRecordingClient({ data: [], error: null }, { data: null, error: refusal }).client, 'user-1'))
      .rejects.toBe(refusal);
  });
});
