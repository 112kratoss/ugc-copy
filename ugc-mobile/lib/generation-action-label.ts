/**
 * Every control that starts a paid generation says what it costs, in the same
 * words. HIG *Generative AI* asks you to "consider consequences and get
 * permission before performing irreversible or potentially problematic tasks"
 * and to "ask for confirmation before performing a significant action on
 * someone's behalf" — spending someone's credits is that action, and a button
 * that states the price is the confirmation.
 *
 * Before this, only the composer's Generate button carried a price: the
 * workspace's `Retry` ran a full new paid generation behind a bare verb.
 */

/** `8` → `8 credits`, `1` → `1 credit`. The count is the whole point, so it never rounds. */
export function formatCreditCost(cost: number) {
  return `${cost} ${cost === 1 ? 'credit' : 'credits'}`;
}

/**
 * `Generate` + 8 → `Generate · 8 credits`. An unknown cost — the quote has not
 * landed, or failed — returns the bare verb rather than inventing a price;
 * callers gate on their own quote status before offering the action.
 */
export function withCreditCost(label: string, cost: number | null | undefined) {
  return typeof cost === 'number' && Number.isFinite(cost)
    ? `${label} · ${formatCreditCost(cost)}`
    : label;
}
