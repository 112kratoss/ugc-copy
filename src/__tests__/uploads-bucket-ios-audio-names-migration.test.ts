import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { STORAGE_BUCKET_ALLOWED_MIME_TYPES } from '@/lib/storage-upload-mime-policy';

const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20261101213622_uploads_bucket_takes_ios_audio_names.sql'),
  'utf8',
);
const statements = migration
  .replace(/--.*$/gm, '')
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

describe('uploads bucket takes the iPhone audio names migration', () => {
  it('sets only the uploads bucket, to the policy list with every alias in it', () => {
    expect(statements).toHaveLength(1);
    const update = statements[0]?.match(
      /^UPDATE storage\.buckets\s+SET allowed_mime_types\s*=\s*ARRAY\[([\s\S]*?)\]::text\[\]\s*WHERE id = 'uploads'$/i,
    );
    expect(update).not.toBeNull();
    const types = Array.from(update?.[1]?.matchAll(/'([^']+)'/g) ?? [], (match) => match[1]);

    expect(types).toEqual([...STORAGE_BUCKET_ALLOWED_MIME_TYPES.uploads]);
  });
});
