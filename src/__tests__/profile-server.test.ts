import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { findShareableProfileByUsername } from '@/lib/profile-server';

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
