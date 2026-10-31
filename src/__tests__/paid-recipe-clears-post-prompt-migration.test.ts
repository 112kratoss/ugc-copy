import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261031055009_paid_recipe_clears_post_prompt.sql', 'utf8');
// The statements alone: the header names functions and columns it never writes.
const statements = sql.replace(/--.*$/gm, '');
// supabase/tests/database/paid_recipe_clears_post_prompt.test.sql runs the
// triggers; this file pins what a replay cannot show again, the one-off clear,
// and how the file takes its locks.
const backfill = statements
  .slice(statements.lastIndexOf('UPDATE public.posts AS posts'), statements.lastIndexOf('COMMIT;'))
  .trim();

describe('paid recipe clears post prompt migration', () => {
  it('runs as one transaction that gives up on a busy table instead of queueing the feed behind it', () => {
    // The CLI applies a file's statements outside a transaction block, where
    // SET LOCAL does nothing and LOCK TABLE is refused.
    expect(statements.trim()).toMatch(/^BEGIN;\s+SET LOCAL lock_timeout = '5s';/);
    expect(statements.trim()).toMatch(/COMMIT;$/);
    // posts before its recipes, the order the publish and edit routes lock in.
    expect(statements).toMatch(
      /LOCK TABLE public\.posts IN SHARE ROW EXCLUSIVE MODE;\s+LOCK TABLE public\.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;/,
    );
    // DROP TRIGGER takes ACCESS EXCLUSIVE, which would stop every read of posts.
    expect(statements).not.toMatch(/DROP TRIGGER/i);
  });

  it('clears the prompt of every post whose recipe is paid, drafts included', () => {
    expect(backfill).toMatch(/^UPDATE public\.posts AS posts\s+SET prompt = NULL\s+WHERE posts\.prompt IS NOT NULL/);
    expect(backfill).toMatch(
      /EXISTS \(\s*SELECT 1\s+FROM public\.post_resource_bundles AS bundles\s+WHERE bundles\.post_id = posts\.id\s+AND bundles\.access_mode = 'paid'\s*\)/,
    );
    // A retired sold recipe is a draft, and its post must not get its prompt back.
    expect(backfill).not.toMatch(/status/);
  });

  it('writes nothing but the prompt', () => {
    // The SET list is pinned above to `prompt = NULL` alone: updated_at, the
    // search document and the NSFW revision follow from the posts triggers,
    // and the title, body and description are the creator's.
    expect(backfill.match(/;/g)).toHaveLength(1);
  });

  it('leaves the posts of an account being deleted alone, which the content freeze would refuse', () => {
    // reject_post_write_during_account_deletion raises on a direct write to
    // such a post; one matching row would fail the migration and the release.
    expect(backfill).toContain('AND NOT public.is_account_deletion_requested(posts.user_id)');
  });

  it('clears the prompt when a recipe is saved as paid or made paid, after the write', () => {
    expect(statements).toMatch(
      /CREATE OR REPLACE TRIGGER post_resource_bundles_clear_post_prompt_when_paid\s+AFTER INSERT OR UPDATE OF access_mode, post_id ON public\.post_resource_bundles\s+FOR EACH ROW\s+WHEN \(NEW\.access_mode = 'paid'\)\s+EXECUTE FUNCTION public\.clear_post_prompt_for_paid_recipe\(\);/,
    );
    // The post is locked before the clear, so a concurrent write of its prompt
    // waits for the recipe and is then dropped by the posts trigger.
    expect(statements).toMatch(/PERFORM 1\s+FROM public\.posts\s+WHERE id = NEW\.post_id\s+FOR UPDATE;/);
    // A post that holds no prompt is not rewritten: no re-embed, no new NSFW revision.
    expect(statements).toMatch(/SET prompt = NULL\s+WHERE id = NEW\.post_id\s+AND prompt IS NOT NULL;/);
  });

  it('drops a later prompt before the row is written', () => {
    // Its name order against the unlisted rule and the NSFW revision is pinned
    // where the triggers exist: the pgTAP test reads pg_trigger.
    expect(statements).toMatch(
      /CREATE OR REPLACE TRIGGER b_posts_keep_prompt_out_of_paid_recipe\s+BEFORE UPDATE OF prompt ON public\.posts\s+FOR EACH ROW\s+WHEN \(NEW\.prompt IS NOT NULL\)\s+EXECUTE FUNCTION public\.keep_post_prompt_out_of_paid_recipe\(\);/,
    );
  });

  it('runs both functions as their owner and lets no client call them', () => {
    for (const fn of ['clear_post_prompt_for_paid_recipe', 'keep_post_prompt_out_of_paid_recipe']) {
      expect(statements).toMatch(
        new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(\\)\\s+RETURNS trigger\\s+LANGUAGE plpgsql\\s+SECURITY DEFINER\\s+SET search_path = ''`),
      );
      expect(statements).toContain(
        `REVOKE ALL ON FUNCTION public.${fn}()\n  FROM PUBLIC, anon, authenticated, service_role;`,
      );
    }
  });
});
