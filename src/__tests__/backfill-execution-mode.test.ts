import { describe, expect, it } from 'vitest';

import {
  getSupabaseProjectRef,
  parseBackfillExecutionMode,
} from '../../scripts/backfill-execution-mode.mjs';

describe('backfill execution mode', () => {
  it('defaults to a dry run', () => {
    expect(parseBackfillExecutionMode({
      argv: [],
      supabaseUrl: 'https://project-one.supabase.co',
    })).toEqual({ dryRun: true, execute: false, projectRef: null });
  });

  it('requires an exact project confirmation before enabling writes', () => {
    expect(() => parseBackfillExecutionMode({
      argv: ['--execute'],
      supabaseUrl: 'https://project-one.supabase.co',
    })).toThrow('--project-ref');

    expect(() => parseBackfillExecutionMode({
      argv: ['--execute', '--project-ref=project-two'],
      supabaseUrl: 'https://project-one.supabase.co',
    })).toThrow('did not match project-one');

    expect(parseBackfillExecutionMode({
      argv: ['--execute', '--project-ref', 'project-one'],
      supabaseUrl: 'https://project-one.supabase.co',
    })).toEqual({ dryRun: false, execute: true, projectRef: 'project-one' });
  });

  it('supports an explicit project ref for custom Supabase domains', () => {
    expect(parseBackfillExecutionMode({
      argv: ['--execute', '--project-ref=custom-project'],
      supabaseUrl: 'https://supabase.internal.example',
      environmentProjectRef: 'custom-project',
    })).toMatchObject({ dryRun: false, execute: true });
  });

  it('rejects contradictory modes and extracts hosted project refs', () => {
    expect(() => parseBackfillExecutionMode({
      argv: ['--execute', '--dry-run', '--project-ref=project-one'],
      supabaseUrl: 'https://project-one.supabase.co',
    })).toThrow('not both');
    expect(getSupabaseProjectRef('https://project-one.supabase.co')).toBe('project-one');
    expect(getSupabaseProjectRef('not-a-url')).toBeNull();
  });
});
