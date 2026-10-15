export type RazorpayCheckoutVerificationResult =
  | { state: 'settled'; body: Record<string, unknown> }
  | { state: 'pending'; body: Record<string, unknown> };

const fallbackIntentKeys = new Map<string, string>();

function checkoutIntentStorageKey(scope: string) {
  return `magicbooklet:razorpay-checkout:${scope}`;
}

export function getOrCreateRazorpayCheckoutIntentKey(scope: string) {
  const storageKey = checkoutIntentStorageKey(scope);
  try {
    const existing = window.sessionStorage.getItem(storageKey)?.trim();
    if (
      existing
      && existing.length >= 16
      && existing.length <= 128
      && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(existing)
    ) {
      return existing;
    }

    const created = window.crypto.randomUUID();
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    const existing = fallbackIntentKeys.get(scope);
    if (existing) {
      return existing;
    }
    const created = window.crypto.randomUUID();
    fallbackIntentKeys.set(scope, created);
    return created;
  }
}

export function clearRazorpayCheckoutIntentKey(scope: string) {
  fallbackIntentKeys.delete(scope);
  try {
    window.sessionStorage.removeItem(checkoutIntentStorageKey(scope));
  } catch {
    // A storage-disabled browser still receives safe server-side idempotency
    // within the current request; there is simply nothing persistent to clear.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function paymentErrorMessage(body: Record<string, unknown>) {
  return typeof body.error === 'string' && body.error.trim()
    ? body.error.trim()
    : 'Payment verification failed.';
}

/**
 * The bearer for a verify attempt, or for a read after a payment, taken from the
 * browser's session at that moment. The buyer can spend minutes in the sheet,
 * long enough for the token held at the click to expire. The client is loaded
 * on first use, as the auth provider loads it, so a page that never takes a
 * payment never fetches it.
 */
export async function readCheckoutAccessToken(): Promise<string> {
  const { supabase } = await import('@/lib/supabase');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('The session ended while the payment was being made.');
  }
  return session.access_token;
}

export async function verifyRazorpayCheckoutUntilSettled({
  body,
  fetcher = fetch,
  maxAttempts = 5,
  sleep = (delayMs: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  }),
  token,
  url,
}: {
  body: Record<string, unknown>;
  fetcher?: typeof fetch;
  maxAttempts?: number;
  sleep?: (delayMs: number) => Promise<void>;
  /**
   * The bearer, or a reader called before every attempt. The sheet can stay
   * open for minutes, so a token read at the click may have expired by the time
   * the payment comes back to be verified.
   */
  token: string | (() => Promise<string>);
  url: string;
}): Promise<RazorpayCheckoutVerificationResult> {
  const boundedAttempts = Math.max(1, Math.min(8, Math.floor(maxAttempts)));

  for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
    const bearer = typeof token === 'function' ? await token() : token;
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => ({}));
    const responseBody = isRecord(parsed) ? parsed : {};

    if (response.status === 202 && responseBody.code === 'PAYMENT_PENDING') {
      if (attempt === boundedAttempts - 1) {
        return { state: 'pending', body: responseBody };
      }

      const retryAfterSeconds = typeof responseBody.retryAfterSeconds === 'number'
        && Number.isFinite(responseBody.retryAfterSeconds)
        ? responseBody.retryAfterSeconds
        : 2;
      await sleep(Math.max(500, Math.min(5_000, retryAfterSeconds * 1_000)));
      continue;
    }

    if (!response.ok || responseBody.success !== true) {
      throw new Error(paymentErrorMessage(responseBody));
    }

    return { state: 'settled', body: responseBody };
  }

  return {
    state: 'pending',
    body: {
      status: 'pending',
      code: 'PAYMENT_PENDING',
      message: 'Payment is waiting to be captured.',
    },
  };
}

const CREDIT_REFRESH_WINDOW_MS = 60_000;
const CREDIT_REFRESH_INTERVAL_MS = 5_000;

/**
 * Has every balance on the page read itself again (`credits_updated`) now and
 * every few seconds for a minute. A payment this page could not see settled is
 * settled by Razorpay's webhook, which can land after the page stopped asking.
 * Returns the function that stops it early.
 */
export function pollCreditBalanceAfterPayment({
  intervalMs = CREDIT_REFRESH_INTERVAL_MS,
  windowMs = CREDIT_REFRESH_WINDOW_MS,
}: { intervalMs?: number; windowMs?: number } = {}): () => void {
  const refresh = () => window.dispatchEvent(new Event('credits_updated'));
  refresh();
  const intervalId = window.setInterval(refresh, intervalMs);
  const timeoutId = window.setTimeout(() => window.clearInterval(intervalId), windowMs);
  return () => {
    window.clearInterval(intervalId);
    window.clearTimeout(timeoutId);
  };
}

/**
 * What a recipe checkout says once the sheet has taken the money and the page
 * could not see the purchase settle: never a failure, never "try again".
 */
export const RECIPE_PAYMENT_RECEIVED_MESSAGE = "Payment received. Your recipe opens here once it's confirmed.";

/** The part of a post's recipe read that says whether this viewer has it. */
export interface RecipeBundleAccess {
  viewerCanAccess: boolean;
  viewerIsOwner: boolean;
}

const BUNDLE_REFRESH_WINDOW_MS = 60_000;
const BUNDLE_REFRESH_INTERVAL_MS = 5_000;

/**
 * Reads a post's recipe now and every few seconds for a minute, each read with
 * the session's token as it is then, and hands the first read that shows it
 * unlocked to `onUnlocked`. A recipe payment this page could not see settle (a
 * verify that failed after the sheet took the money, or one still capturing)
 * is settled by Razorpay's webhook, which can land after the verify stopped
 * asking. A capture can outlast the minute, so the tab's next focus (the buyer
 * back from their bank app, say) reads once more. Reads never overlap, and one
 * that fails is simply the next one's turn. Returns the function that stops it.
 */
export function pollBundleUntilUnlocked<TBundle extends RecipeBundleAccess>({
  fetcher = fetch,
  intervalMs = BUNDLE_REFRESH_INTERVAL_MS,
  onUnlocked,
  postId,
  token,
  windowMs = BUNDLE_REFRESH_WINDOW_MS,
}: {
  fetcher?: typeof fetch;
  intervalMs?: number;
  onUnlocked: (bundle: TBundle) => void;
  postId: string;
  token: () => Promise<string>;
  windowMs?: number;
}): () => void {
  let stopped = false;
  let timeoutId: number | null = null;
  let readsLeft = 1 + Math.max(0, Math.floor(windowMs / intervalMs));

  const readUnlockedBundle = async (): Promise<TBundle | null> => {
    try {
      const response = await fetcher(`/api/posts/${postId}/resource-bundle`, {
        headers: { Authorization: `Bearer ${await token()}` },
      });
      const parsed: unknown = await response.json().catch(() => null);
      const bundle = isRecord(parsed) && isRecord(parsed.bundle) ? parsed.bundle : null;
      return response.ok && bundle && (bundle.viewerCanAccess === true || bundle.viewerIsOwner === true)
        ? bundle as unknown as TBundle
        : null;
    } catch {
      return null;
    }
  };

  const stop = () => {
    stopped = true;
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }
    window.removeEventListener('focus', readOnFocus);
  };

  const read = async (scheduleNext: boolean) => {
    const bundle = await readUnlockedBundle();
    if (stopped) {
      return;
    }
    if (bundle) {
      stop();
      onUnlocked(bundle);
      return;
    }
    if (!scheduleNext) {
      return;
    }
    readsLeft -= 1;
    if (readsLeft > 0) {
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void read(true);
      }, intervalMs);
    } else {
      window.addEventListener('focus', readOnFocus, { once: true });
    }
  };

  function readOnFocus() {
    void read(false);
  }

  void read(true);
  return stop;
}
