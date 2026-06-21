export function buildKieWebhookCallbackUrl() {
  const secret = process.env.WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error('WEBHOOK_SECRET is not configured');
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  if (!supabaseUrl) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not configured');
  }

  return `${supabaseUrl}/functions/v1/kie-webhook?secret=${encodeURIComponent(secret)}`;
}
