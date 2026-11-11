/**
 * A creator's payout request, as the server, the web's Recipe sales page and
 * the app's Recipe Sales all read it (owner, 2026-11-11: withdraw in the app
 * too). Until then the server and the web each kept their own copy of the
 * methods and the details rule; a third copy in the app would drift.
 *
 * Imported by `src/lib/creator-payouts.ts`, `src/app/marketplace/sell/PayoutPanel.tsx`
 * and the app's `lib/creator-payout-view-model.ts` and `app/payout-request.tsx`.
 * Keep it free of React Native, Expo and Node imports: the web bundle and the
 * server compile it too.
 */

/**
 * What a new request may choose. Payouts are sent by hand in INR over Indian
 * rails (decision 7, 2026-10-17). A request stored earlier with another method
 * still reads and resolves: history and /admin treat the stored method as text.
 */
export const CREATOR_PAYOUT_METHOD_OPTIONS = [
  { value: 'upi', label: 'UPI', placeholder: 'your-name@bank', keyboard: 'email' },
  {
    value: 'bank_transfer',
    label: 'Indian bank transfer',
    placeholder: 'Account name and last 4 digits, plus a contact',
    keyboard: 'text',
  },
] as const;

export type CreatorPayoutMethod = (typeof CREATOR_PAYOUT_METHOD_OPTIONS)[number]['value'];

export const CREATOR_PAYOUT_METHODS: readonly CreatorPayoutMethod[] =
  CREATOR_PAYOUT_METHOD_OPTIONS.map((option) => option.value);

/** Drawn as "Coming soon" so a seller abroad sees they are planned; never selectable or sent. */
export const CREATOR_PAYOUT_COMING_SOON_LABELS = ['PayPal', 'International transfer'] as const;

/** Methods a request may name that are planned: refused as unavailable, not as unknown. */
export const CREATOR_PAYOUT_COMING_SOON_METHODS: readonly string[] = ['paypal'];

/** A request made before 2026-10-17 may name PayPal, and still reads by name. */
const STORED_METHOD_LABELS: Record<string, string> = { paypal: 'PayPal' };

export const CREATOR_PAYOUT_DETAILS_MIN_LENGTH = 3;
export const CREATOR_PAYOUT_DETAILS_MAX_LENGTH = 500;

/** How long a payout takes from the request, as every surface promises it. */
export const CREATOR_PAYOUT_ARRIVAL_DAYS = 14;

export const CREATOR_PAYOUT_DETAILS_MISSING = 'Add the account details we should send the payout to.';

/** Under the details field on both clients. */
export const CREATOR_PAYOUT_DETAILS_CAUTION =
  'Never paste a full account number here. Send a UPI ID, or the account name with the last four digits and a contact we can reach you on.';

export function isCreatorPayoutMethod(value: unknown): value is CreatorPayoutMethod {
  return typeof value === 'string' && (CREATOR_PAYOUT_METHODS as readonly string[]).includes(value);
}

/** Why a method a new request may not use is refused. */
export function creatorPayoutMethodRefusal(value: unknown): {
  code: 'METHOD_UNAVAILABLE' | 'INVALID_METHOD';
  error: string;
} {
  return typeof value === 'string' && CREATOR_PAYOUT_COMING_SOON_METHODS.includes(value)
    ? { code: 'METHOD_UNAVAILABLE', error: 'PayPal payouts are coming soon. Choose UPI or an Indian bank transfer.' }
    : { code: 'INVALID_METHOD', error: 'Choose how you want to be paid.' };
}

/** The server keeps the method's id ("bank_transfer"); the seller reads its name. */
export function formatCreatorPayoutMethod(value: string): string {
  return CREATOR_PAYOUT_METHOD_OPTIONS.find((option) => option.value === value)?.label
    ?? STORED_METHOD_LABELS[value]
    ?? value.replace(/_/g, ' ');
}

export type CreatorPayoutStatus = 'requested' | 'paid' | 'rejected';

export function creatorPayoutStatusLabel(status: CreatorPayoutStatus): string {
  return status === 'paid' ? 'Paid' : status === 'rejected' ? 'Rejected' : 'In progress';
}

/** Said under every balance below the floor: a seller abroad learns here that payouts go to Indian rails. */
export function creatorPayoutRailsLine(minimumUsd: string): string {
  return `Withdraw from ${minimumUsd}, paid in INR to UPI or an Indian bank.`;
}

/**
 * Whether the details a creator typed can be sent, or the words that say what
 * to fix. Runs in both forms (to keep Request payout from sending a refusal)
 * and on the server (the authority). `text` is what the creator typed; it is
 * trimmed here.
 */
export function checkPayoutDetails(method: CreatorPayoutMethod, text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < CREATOR_PAYOUT_DETAILS_MIN_LENGTH || trimmed.length > CREATOR_PAYOUT_DETAILS_MAX_LENGTH) {
    return CREATOR_PAYOUT_DETAILS_MISSING;
  }

  // TODO(owner): the per-method check. `method` is 'upi' or 'bank_transfer'.
  // Return null to accept, or one short sentence the creator can act on.
  void method;
  return null;
}
