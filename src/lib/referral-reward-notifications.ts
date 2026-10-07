import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export type ReferralNotificationDeliverySummary = { processed: number; delivered: number; failed: number };

export async function hasPendingReferralRewardNotifications(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.rpc('has_pending_referral_reward_notifications');
  if (error) throw error;
  if (typeof data !== 'boolean') throw new Error('Referral notification work check returned an invalid result');
  return data;
}

export async function deliverReferralRewardNotifications(client: SupabaseClient, eventKey?: string): Promise<ReferralNotificationDeliverySummary> {
  const { data, error } = await client.rpc('deliver_referral_reward_notifications', { p_limit: 100, ...(eventKey ? { p_event_key: eventKey } : {}) });
  if (error) throw error;
  if (!data || typeof data !== 'object'
    || !['processed', 'delivered', 'failed'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0)
    || data.processed > 100 || data.delivered + data.failed !== data.processed) {
    throw new Error('Referral notification delivery returned an invalid result');
  }
  return { processed: data.processed, delivered: data.delivered, failed: data.failed };
}
