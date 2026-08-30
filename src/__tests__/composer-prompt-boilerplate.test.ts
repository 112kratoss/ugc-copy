import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMPOSER_PROMPT_CARD_PREVIEW,
  normalizePostResourceSections,
} from '@/lib/post-resource-bundles';

const projectRoot = process.cwd();

function section(overrides: Record<string, unknown>) {
  return { id: 'creation-prompt', title: 'Exact generation prompt', resourceType: 'prompt', ...overrides };
}

/**
 * The composer writes this line on the creator's behalf and it only restates
 * the card's own title. Both apps read the same normalized sections, so it has
 * to go in one place or the two disagree about the same post.
 */
describe('composer prompt boilerplate', () => {
  it('drops the composer line from a prompt section', () => {
    const [result] = normalizePostResourceSections([
      section({ description: COMPOSER_PROMPT_CARD_PREVIEW }),
    ]);
    expect(result.description).toBeNull();
  });

  it('keeps what the creator actually wrote', () => {
    const [result] = normalizePostResourceSections([
      section({ description: 'Swap the jacket colour and keep the flames.' }),
    ]);
    expect(result.description).toBe('Swap the jacket colour and keep the flames.');
  });

  it('leaves the same sentence alone on a section that is not a prompt', () => {
    const [result] = normalizePostResourceSections([
      section({ resourceType: 'settings', description: COMPOSER_PROMPT_CARD_PREVIEW }),
    ]);
    expect(result.description).toBe(COMPOSER_PROMPT_CARD_PREVIEW);
  });

  // The two workspaces cannot import from each other, so the mobile copy is
  // pinned here instead: a copy edit on either side alone would put the
  // sentence back on one platform and not the other.
  it('matches the string the mobile composer writes', () => {
    const mobile = fs.readFileSync(path.join(
      projectRoot,
      'ugc-mobile/lib/post-resource-bundle-view-model.ts',
    ), 'utf8');
    expect(mobile).toContain(`export const COMPOSER_PROMPT_CARD_PREVIEW = '${COMPOSER_PROMPT_CARD_PREVIEW}';`);
  });

  /**
   * Stored rows keep the line until their creator's own next edit rewrites them
   * through the write path, and that is deliberate.
   *
   * A migration was written to clear them and production rejected it:
   * `post_resource_bundle_revisions` carries an immutability trigger, because a
   * revision is the record of what a buyer paid for. `post_resource_bundles` is
   * no better a target — writing it fires `capture_post_resource_bundle_revision`,
   * which would mint a revision representing no creator action at all, and
   * `protect_sold_post_resource_bundle_content` guards it besides.
   *
   * Reading is where this belongs, and every reader already passes through the
   * normalizer above — including the purchased revision a buyer sees. So these
   * two pin that no reader is left out, rather than any stored-row shape.
   */
  it('normalizes the live bundle and the purchased revision through the same funnel', () => {
    const server = fs.readFileSync(path.join(projectRoot, 'src/lib/post-resource-bundles-server.ts'), 'utf8');
    const purchasedRevision = server.slice(server.indexOf('function toPurchasedRevision'));
    expect(purchasedRevision.slice(0, purchasedRevision.indexOf('\n}'))).toContain('normalizePostResourceSections');
    const liveBundle = server.slice(server.indexOf('function normalizeResources'));
    expect(liveBundle.slice(0, liveBundle.indexOf('\n}'))).toContain('normalizePostResourceSections');
  });

  it('ships no migration that rewrites bundles or their revisions', () => {
    const migrations = fs.readdirSync(path.join(projectRoot, 'supabase/migrations'))
      .filter((name) => name >= '20260830000000' && name.endsWith('.sql'));
    for (const name of migrations) {
      const sql = fs.readFileSync(path.join(projectRoot, 'supabase/migrations', name), 'utf8');
      expect(sql, `${name} must not rewrite bundle rows`).not.toMatch(
        /UPDATE\s+public\.post_resource_bundle/i,
      );
    }
  });
});
