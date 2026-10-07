/** `credits` is the total balance; promotional credits are a subset of it. */
export function planAdminCreditAdjustmentDeltas(
  intent: 'goodwill' | 'refund' | 'clawback',
  amount: number,
): { creditsDelta: number; promotionalCreditsDelta: number } {
  switch (intent) {
    case 'goodwill':
      return { creditsDelta: amount, promotionalCreditsDelta: amount };
    case 'refund':
      return { creditsDelta: amount, promotionalCreditsDelta: 0 };
    case 'clawback':
      return { creditsDelta: -amount, promotionalCreditsDelta: -amount };
    default: {
      const unhandled: never = intent;
      throw new Error(`Unsupported credit adjustment intent: ${String(unhandled)}`);
    }
  }
}
