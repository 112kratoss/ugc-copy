import 'server-only';

import { WELCOME_CREDIT_PROGRAM_KEY } from '@/lib/onboarding';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * The credits a new account is given while the welcome program is on, or null
 * while it is off. Home's shelf marks what fits it "Free to try", and the
 * creators tell a signed-out visitor what signing up gives them.
 */
export async function loadWelcomeCreditAmount(): Promise<number | null> {
  const { data, error } = await createServiceClient()
    .from('credit_grant_programs')
    .select('amount, enabled')
    .eq('program_key', WELCOME_CREDIT_PROGRAM_KEY)
    .maybeSingle();
  if (error) throw error;
  const program = data as { amount?: unknown; enabled?: unknown } | null;
  const amount = Number(program?.amount);
  return program?.enabled === true && Number.isFinite(amount) && amount > 0 ? amount : null;
}
