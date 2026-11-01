import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';

const sql = readFileSync('supabase/migrations/20261101062452_made_with_keeps_dotted_model_slugs.sql', 'utf8');
// The statements alone: the header names functions and columns it never writes.
const statements = sql.replace(/--.*$/gm, '');
// supabase/tests/database/post_source_tools_catalog_slugs.test.sql runs the
// function; this file pins what a replay cannot show again, the one-off
// backfill, and the rules the function's shape carries.
const saveFunction = statements.slice(
  statements.indexOf('CREATE OR REPLACE FUNCTION public.save_post_source_tools_with_catalog('),
  statements.indexOf('$$;') + 3,
);
const backfill = statements
  .slice(statements.indexOf('WITH known_slugs AS'), statements.lastIndexOf('COMMIT;'))
  .trim();
const SLUG_SHAPE = /v_sent_model_slug !~ '([^']+)'/;

describe('made with keeps dotted model slugs migration', () => {
  it('replaces the function and its rows in one transaction', () => {
    // The CLI applies a file's statements outside a transaction block, where
    // SET LOCAL does nothing.
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    expect(statements.trim()).toMatch(/COMMIT;$/);
  });

  it('keeps the function service-role only and run with its caller\'s rights', () => {
    expect(saveFunction).toMatch(/SECURITY INVOKER\s+SET search_path = public/);
    expect(statements).toMatch(
      /REVOKE ALL ON FUNCTION public\.save_post_source_tools_with_catalog\(uuid, uuid, text, jsonb\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(statements).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.save_post_source_tools_with_catalog\(uuid, uuid, text, jsonb\)\s+TO service_role;/,
    );
  });

  it('finds a catalog model by either form of its slug, the slug sent as it is first', () => {
    expect(saveFunction).toMatch(
      /\) AS known\s+WHERE regexp_replace\(\s*regexp_replace\(replace\(lower\(btrim\(known\.slug\)\), '&', ' and '\), '\[\^a-z0-9\]\+', '-', 'g'\),\s*'\(\^-\+\|-\+\$\)',\s*'',\s*'g'\s*\) = v_model_slug\s+ORDER BY known\.slug = v_sent_model_slug DESC NULLS LAST, known\.sort_order, known\.slug\s+LIMIT 1;/,
    );
  });

  it('knows the app\'s models by their generation model ids, as the backfill does', () => {
    // The June seed lists 12 of the app's models; a composer sends one its
    // picker lacks, such as a model retired from the catalog, hyphenated.
    expect(saveFunction).toMatch(
      /FROM \(\s*SELECT label, slug, sort_order\s+FROM public\.source_tool_models\s+WHERE source_tool_id = v_tool_id\s+UNION ALL\s+SELECT v_model_label, model_id, 1000\s+FROM public\.generation_models\s+WHERE v_canonical_tool_slug = 'magicbooklet'\s+\) AS known/,
    );
  });

  it('stores and creates a model the catalog lacks under the slug it was sent with', () => {
    expect(saveFunction).toMatch(/v_new_model_slug := COALESCE\(v_sent_model_slug, v_model_slug\);/);
    expect(saveFunction).toMatch(/VALUES \(\s*v_tool_id,\s*v_new_model_slug,\s*v_model_label,/);
    // The model a lookup found is the one a creation reactivates.
    expect(saveFunction).toMatch(/AND slug = v_canonical_model_slug\s+AND NOT is_active;/);
  });

  it('accepts every model id the app runs as a slug to keep', () => {
    const shape = new RegExp(saveFunction.match(SLUG_SHAPE)![1]);
    const ids = Object.keys({ ...IMAGE_MODELS, ...VIDEO_MODELS, ...MOTION_MODELS });

    expect(ids.filter((id) => id.includes('.')).length).toBeGreaterThan(0);
    expect(ids.filter((id) => !shape.test(id))).toEqual([]);
    expect(shape.test('veo 3.1')).toBe(false);
    expect(shape.test('veo..3')).toBe(false);
  });

  it('keeps the label the server sent for the app\'s own models', () => {
    expect(saveFunction).toMatch(
      /IF v_canonical_tool_slug = 'magicbooklet' THEN\s+v_canonical_model_label := v_model_label;\s+END IF;/,
    );
  });

  it('writes the post only when its first tool changes, and still refuses an account being deleted', () => {
    expect(saveFunction).toMatch(
      /UPDATE public\.posts[\s\S]+WHERE id = p_post_id\s+AND user_id = p_owner_user_id\s+AND \(\s*source_tool IS DISTINCT FROM v_first_tool_label\s+OR source_tool_slug IS DISTINCT FROM v_first_tool_slug\s*\);/,
    );
    // posts_freeze_for_account_deletion raised through that write on every save.
    expect(saveFunction).toMatch(
      /IF public\.is_account_deletion_requested\(p_owner_user_id\) THEN\s+RAISE EXCEPTION 'Account deletion is already in progress'\s+USING ERRCODE = 'object_not_in_prerequisite_state';/,
    );
    expect(saveFunction.indexOf('is_account_deletion_requested')).toBeLessThan(
      saveFunction.indexOf('DELETE FROM public.post_source_tools'),
    );
  });

  it('refuses a new tool to a post with no media kind with the validation error', () => {
    // `NULL NOT IN (...)` is NULL: a text post reached source_tools' check
    // and a 500 instead of the message isCatalogValidationError answers with 400.
    expect(saveFunction).toMatch(
      /IF p_media_kind IS NULL OR p_media_kind NOT IN \('image', 'video'\) THEN\s+RAISE EXCEPTION 'Creating source tools requires image or video media\.';/,
    );
  });

  it('restores a hyphenated slug only where one slug its tool knows slugifies to it', () => {
    expect(backfill).toMatch(
      /SELECT 'magicbooklet', generation_models\.model_id\s+FROM public\.generation_models/,
    );
    expect(backfill).toMatch(/HAVING count\(DISTINCT known_slugs\.slug\) = 1/);
    // A model created under the hyphenated slug keeps its rows.
    expect(backfill).toMatch(
      /WHERE NOT EXISTS \(\s*SELECT 1\s+FROM known_slugs AS exact\s+WHERE exact\.tool_slug = stored\.tool_slug\s+AND exact\.slug = stored\.model_slug\s*\)/,
    );
    expect(backfill).toMatch(
      /UPDATE public\.post_source_tools AS stored\s+SET model_slug = restored\.slug,\s+updated_at = now\(\)\s+FROM restored\s+WHERE stored\.id = restored\.id;$/,
    );
    expect(backfill.match(/;/g)).toHaveLength(1);
  });
});
