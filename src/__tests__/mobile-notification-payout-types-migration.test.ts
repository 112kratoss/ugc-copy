import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261015145442_mobile_notification_payout_types.sql',
), 'utf8');

describe('mobile notification payout types migration', () => {
  it('re-creates the type check with the two payout outcomes and every earlier type', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS mobile_notifications_type_check');
    expect(migration).toContain('ADD CONSTRAINT mobile_notifications_type_check CHECK (type IN (');
    for (const type of [
      'generation_succeeded', 'generation_failed', 'credits_purchased', 'purchases_restored',
      'marketplace_unlocked', 'post_resource_unlocked', 'creator_followed', 'post_saved', 'post_remixed',
      'post_shared', 'referral_reward_earned', 'referral_reward_reversed',
      'creator_payout_paid', 'creator_payout_rejected',
    ]) {
      expect(migration).toContain(`'${type}'`);
    }
  });

  it('says why the check moved', () => {
    expect(migration).toContain('notifyCreatorPayoutResolved');
  });
});
