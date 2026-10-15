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
