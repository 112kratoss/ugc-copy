import type { SupabaseClient } from '@supabase/supabase-js';

export class AiUsageLedgerError extends Error {
  status: number;
  code: 'CREDIT_DEDUCTION_FAILED' | 'INSUFFICIENT_CREDITS' | 'USAGE_EVENT_FAILED';
  requiredCredits?: number;

  constructor(
    message: string,
    status: number,
    code: AiUsageLedgerError['code'],
    requiredCredits?: number,
  ) {
    super(message);
    this.name = 'AiUsageLedgerError';
    this.status = status;
    this.code = code;
    this.requiredCredits = requiredCredits;
  }
}

export type AiUsageLedgerStartInput = {
  userId: string;
  cost: number;
  feature: string;
  provider: string;
  model: string;
  medium: string | null;
  inputPrompt: string;
};

export type AiUsageLedger = {
  eventId: string;
  remainingCredits: number;
  cost: number;
  userId: string;
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

async function refundCreditsQuietly(client: SupabaseClient, userId: string, amount: number) {
  try {
    await client.rpc('refund_credits', { p_user_id: userId, p_amount: amount });
  } catch (error) {
    console.error('Failed to refund AI usage credits after ledger error:', error);
  }
}

export async function startAiUsageLedger(
  client: SupabaseClient,
  input: AiUsageLedgerStartInput,
): Promise<AiUsageLedger> {
  const { data: remainingCredits, error: deductError } = await client.rpc('deduct_credits', {
    p_user_id: input.userId,
    p_cost: input.cost,
  });

  if (deductError) {
    throw new AiUsageLedgerError(
      errorMessage(deductError, 'Failed to deduct credits.'),
      500,
      'CREDIT_DEDUCTION_FAILED',
    );
  }

  if (remainingCredits === -1) {
    throw new AiUsageLedgerError(
      `Insufficient credits. This action costs ${input.cost} credits.`,
      402,
      'INSUFFICIENT_CREDITS',
      input.cost,
    );
  }

  const { data: usageEvent, error: insertError } = await client
    .from('ai_usage_events')
    .insert({
      user_id: input.userId,
      feature: input.feature,
      provider: input.provider,
      model: input.model,
      medium: input.medium,
      cost: input.cost,
      status: 'pending',
      input_prompt: input.inputPrompt.slice(0, 5000),
    })
    .select('id')
    .single();

  const eventId = typeof usageEvent?.id === 'string' ? usageEvent.id : null;
  if (insertError || !eventId) {
    await refundCreditsQuietly(client, input.userId, input.cost);
    throw new AiUsageLedgerError(
      'Failed to record AI usage.',
      500,
      'USAGE_EVENT_FAILED',
    );
  }

  return {
    eventId,
    remainingCredits: Number(remainingCredits),
    cost: input.cost,
    userId: input.userId,
  };
}

export async function markAiUsageSucceeded(
  client: SupabaseClient,
  ledger: AiUsageLedger,
  outputText: string,
) {
  await client
    .from('ai_usage_events')
    .update({
      status: 'succeeded',
      output_text: outputText.slice(0, 5000),
    })
    .eq('id', ledger.eventId);
}

export async function refundAiUsageLedger(
  client: SupabaseClient,
  ledger: AiUsageLedger,
  error: unknown,
) {
  await client.rpc('refund_ai_usage_event', { p_event_id: ledger.eventId });
  await client
    .from('ai_usage_events')
    .update({
      error_message: errorMessage(error, 'Unknown error').slice(0, 1000),
    })
    .eq('id', ledger.eventId);
}
