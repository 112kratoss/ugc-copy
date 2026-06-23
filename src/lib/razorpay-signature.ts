import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function normalizeNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function createRazorpaySignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyRazorpaySignature(input: {
  payload: string;
  signature: string | null | undefined;
  secret: string | null | undefined;
}): boolean {
  const signature = normalizeNonEmpty(input.signature);
  const secret = normalizeNonEmpty(input.secret);

  if (!signature || !secret) return false;

  const expectedSignature = createRazorpaySignature(input.payload, secret);
  return timingSafeStringEqual(expectedSignature, signature);
}

export function verifyRazorpayPaymentSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string | null | undefined;
  secret: string | null | undefined;
}): boolean {
  return verifyRazorpaySignature({
    payload: `${input.orderId}|${input.paymentId}`,
    signature: input.signature,
    secret: input.secret,
  });
}
