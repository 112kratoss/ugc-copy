import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { STORAGE_BUCKET_ALLOWED_MIME_TYPES } from '@/lib/storage-upload-mime-policy';

const migrationsDirectory = path.resolve(process.cwd(), 'supabase/migrations');

function readMigration(name: string): string {
  return fs.readFileSync(path.join(migrationsDirectory, name), 'utf8');
}

function readBucketMimeTypes(migration: string, bucket: string): string[] {
  const updates = migration.matchAll(
    /UPDATE storage\.buckets\s+SET[\s\S]*?allowed_mime_types\s*=\s*ARRAY\[([\s\S]*?)\]::text\[\]\s*WHERE ([^;]+);/gi,
  );

  for (const update of updates) {
    if (!update[2]?.includes(`'${bucket}'`)) continue;
    return Array.from(update[1]?.matchAll(/'([^']+)'/g) ?? [], (match) => match[1]);
  }

  return [];
}

describe('generation security hardening migrations', () => {
  it('makes authoritative generation state backend-owned', () => {
    const migration = readMigration(
      '20260714100500_harden_generation_and_storage_write_boundaries.sql',
    );

    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.generations FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.generation_input_media FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Users can create own ordinary generations" ON public.generations',
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Users can insert own generation input media" ON public.generation_input_media',
    );
  });

  it('removes direct client uploads and enforces bucket limits', () => {
    const migration = readMigration(
      '20260714100500_harden_generation_and_storage_write_boundaries.sql',
    );

    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Authenticated users can upload own files" ON storage.objects',
    );
    expect(migration).toContain(
      'DROP POLICY IF EXISTS "Users can upload own generation inputs" ON storage.objects',
    );
    expect(migration).toMatch(/SET file_size_limit = 26214400,[\s\S]*WHERE id = 'generated_images'/i);
    expect(migration).toMatch(/SET file_size_limit = 5242880,[\s\S]*WHERE id = 'profiles'/i);
    expect(migration).toContain('allowed_mime_types');
  });

  it('keeps signed-upload MIME policy exactly aligned with restricted storage buckets', () => {
    const migration = readMigration(
      '20260714100500_harden_generation_and_storage_write_boundaries.sql',
    );

    for (const [bucket, mimeTypes] of Object.entries(STORAGE_BUCKET_ALLOWED_MIME_TYPES)) {
      expect(readBucketMimeTypes(migration, bucket), bucket).toEqual([...mimeTypes]);
    }
  });

  it('binds each idempotency key to one canonical request hash', () => {
    const migration = readMigration(
      '20260714100600_bind_generation_idempotency_to_request.sql',
    );

    expect(migration).toContain('PRIMARY KEY (user_id, key_hash)');
    expect(migration).toContain('request_hash text NOT NULL');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_catalog');
    expect(migration).toContain("RETURN 'payload_mismatch'");
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_generation_start_request\(uuid, text, text\) FROM PUBLIC, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_generation_start_request\(uuid, text, text\) TO service_role/i,
    );
  });
});
