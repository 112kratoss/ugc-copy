import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.resolve(projectRoot, relativePath), 'utf8');
const migration = read('supabase/migrations/20260827090000_generation_preview_dimensions.sql');

/** The migration with its `--` prose removed, so assertions read statements. */
function statementsOf(sql: string) {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('generation preview dimensions migration', () => {
  it('adds both columns, nullable, and is re-runnable', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS preview_width integer');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS preview_height integer');
    // A NOT NULL would need a default, and there is no honest default for a
    // dimension: every existing row's real value has to be measured.
    expect(migration).not.toMatch(/preview_(width|height) integer[^;,]*NOT NULL/i);
  });

  it('says in the schema which artefact the numbers describe', () => {
    // The distinction is load-bearing: the preview is a `fit: inside` resize, so
    // it is faithful on ratio and wrong on absolute size. A later reader who
    // assumes these are the source output's dimensions would be wrong.
    expect(migration).toContain('COMMENT ON COLUMN public.generations.preview_width');
    expect(migration).toContain('COMMENT ON COLUMN public.generations.preview_height');
    expect(migration).toMatch(/not the source output/);
  });

  it('grants nothing new', () => {
    // `generations` exposes a narrow column list to `authenticated`; a column
    // added here must not widen it, and the showcase feed reads as service role.
    // Prose is stripped first — the migration explains that reasoning in a
    // comment, and the comment is not a statement.
    expect(statementsOf(migration)).not.toMatch(/\bGRANT\b/i);
  });
});

describe('the columns are actually produced and consumed', () => {
  it('is written by the preview repair job, which is what heals existing rows', () => {
    const repair = read('src/lib/media-preview-repair.ts');

    expect(repair).toContain('preview_width: preview.previewWidth');
    expect(repair).toContain('preview_height: preview.previewHeight');
  });

  it('is measured once, at the single upload choke point every creator goes through', () => {
    const preview = read('src/lib/generation-media-preview.ts');

    expect(preview).toContain('previewWidth: width');
    expect(preview).toContain('previewHeight: height');
    // Image previews, video posters and both from-file variants all return
    // through `uploadGenerationPreview`, so measuring there covers the set.
    expect(preview).toMatch(/export async function uploadGenerationPreview/);
  });

  it('reads them in the shared preview-info loader the feed and owner surfaces hydrate from', () => {
    // The query and the size rule moved into generation-preview-info.ts when the
    // owner post surfaces started grafting the same preview as the feed.
    const previewInfo = read('src/lib/generation-preview-info.ts');

    expect(previewInfo).toContain('preview_url, preview_width, preview_height');
    expect(previewInfo).toContain('toUsablePreviewSize(generation.preview_width, generation.preview_height)');
    expect(read('src/lib/showcase-feed.ts')).toContain('loadGenerationPreviewInfoMap');
    expect(read('src/lib/owner-posts.ts')).toContain('loadGenerationPreviewInfoMap');
  });

  it('has a backfill for the rows whose preview already exists', () => {
    const script = read('scripts/backfill-generation-preview-dimensions.ts');
    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

    expect(packageJson.scripts['backfill:generation-preview-dimensions']).toContain(
      'scripts/backfill-generation-preview-dimensions.ts',
    );
    // Measuring the stored preview rather than the source is the whole point:
    // storage egress is this backend's scaling wall.
    expect(script).toContain('measureStoredPreview');
    // One rule for a usable size across the serializer, the backfill and the
    // pipeline that measures the bytes — not three that drift.
    expect(script).toContain('toUsablePreviewSize');
    expect(read('src/lib/generation-media-preview.ts')).toContain('toUsablePreviewSize');
    expect(script).not.toMatch(/output_url/);
    // Dry run unless told otherwise, like every other backfill here.
    expect(script).toContain('parseBackfillExecutionMode');
    expect(script).toContain('executionMode.dryRun');
    // A concurrent repair's measurement is fresher than this pass's.
    expect(script).toContain(".is('preview_width', null)");
  });
});
