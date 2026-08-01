import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260801130000_post_system_consistency_cleanup.sql',
), 'utf8');

describe('post system consistency cleanup migration', () => {
  it('realigns the surface check with the category vocabulary', () => {
    // posts_category_check dropped motion and ugc-ad in 20260619133531; the
    // surface check kept enumerating them, so the two disagreed about what a
    // media post may be.
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS posts_public_surface_check');
    expect(migration).toContain('ADD CONSTRAINT posts_public_surface_check');
    expect(migration).toContain("AND category IN ('image', 'video')");

    // Assert against the constraint body, not the whole file: the comment above
    // it names the dropped categories to explain why they are gone.
    const constraint = migration.slice(migration.indexOf('ADD CONSTRAINT posts_public_surface_check'));
    const constraintBody = constraint.slice(0, constraint.indexOf(');'));
    expect(constraintBody).not.toContain("'motion'");
    expect(constraintBody).not.toContain("'ugc-ad'");
  });

  it('sweeps abandoned free-unlock orders without touching fulfilled ones', () => {
    expect(migration).toContain("razorpay_order_id LIKE 'free_bundle_%'");
    expect(migration).toContain('amount_subunits = 0');
    // An order that produced an entitlement is history, not litter.
    expect(migration).toContain('FROM public.post_resource_bundle_purchases AS purchases\n      WHERE purchases.order_id = post_resource_bundle_orders.id');
  });

  it('publishes the set of storage paths an orphan sweep must never delete', () => {
    // A purchased revision that references a deleted file is a menu with no
    // kitchen, so purchased revisions pin their attachments.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.list_referenced_post_resource_storage_paths');
    expect(migration).toContain('WHERE purchases.revision_id = revisions.id');
    expect(migration).toContain('FROM public.post_resource_bundles AS bundles');
    expect(migration).toContain("->>'storagePath'");
  });

  it('gives post_share_events the retention policy it never had', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prune_post_share_events');
    expect(migration).toContain("p_older_than interval DEFAULT interval '90 days'");
  });

  it('keeps every new maintenance function service-role only', () => {
    for (const signature of [
      'public.prune_abandoned_free_unlock_orders(interval)',
      'public.list_referenced_post_resource_storage_paths()',
      'public.prune_post_share_events(interval)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${signature}\n  FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${signature}\n  TO service_role;`);
    }
  });
});
