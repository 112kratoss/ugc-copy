import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COMPOSER_PROMPT_CARD_PREVIEW,
  normalizePostResourceSections,
} from '@/lib/post-resource-bundles';

const projectRoot = process.cwd();
const migration = fs.readFileSync(path.join(
  projectRoot,
  'supabase/migrations/20260830160000_drop_composer_prompt_boilerplate.sql',
), 'utf8');

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

  it('clears rows that already stored it, in both the live table and its revisions', () => {
    for (const table of ['public.post_resource_bundles b', 'public.post_resource_bundle_revisions r']) {
      expect(migration).toContain(`UPDATE ${table}`);
    }
    // The creator's own description, and any non-prompt section, must survive.
    expect(migration.match(/section->>'resourceType' = 'prompt'/g)).toHaveLength(2);
    expect(migration.match(new RegExp(`section->>'description' = '${COMPOSER_PROMPT_CARD_PREVIEW}'`, 'g'))).toHaveLength(2);
    expect(migration.match(/section - 'description'/g)).toHaveLength(2);
    // Ordering is what the reader sees; aggregating without it would reshuffle.
    expect(migration.match(/ORDER BY ordinality/g)).toHaveLength(2);
  });
});
