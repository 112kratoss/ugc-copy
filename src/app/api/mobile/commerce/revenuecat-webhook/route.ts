import { NextResponse } from 'next/server';

import {
  parseRevenueCatRefundEvent,
  webhookAuthorizationMatches,
} from '@/lib/revenuecat-webhook';
import { createServiceClient } from '@/lib/server-helpers';

export async function POST(request: Request) {
  const expectedAuthorization = process.env.REVENUECAT_WEBHOOK_AUTH_TOKEN;
  if (!expectedAuthorization) {
    console.error('RevenueCat webhook authorization is not configured.');
    return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 503 });
  }

  if (!webhookAuthorizationMatches(request.headers.get('authorization'), expectedAuthorization)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const parsed = parseRevenueCatRefundEvent(body);
  if (parsed.kind === 'ignored') {
    return NextResponse.json({ received: true, ignored: true });
  }

  if (parsed.kind === 'invalid') {
    return NextResponse.json({ error: parsed.message }, { status: 400 });
  }

  const { event } = parsed;
  const { data, error } = await createServiceClient().rpc('reconcile_mobile_credit_refund', {
    p_action: event.action,
    p_event_id: event.eventId,
    p_event_timestamp_ms: event.eventTimestampMs,
    p_external_order_id: event.externalOrderId,
    p_product_id: event.productId,
    p_user_id: event.userId,
  });

  if (error || typeof data !== 'string') {
    console.error('RevenueCat credit refund reconciliation failed:', error);
    return NextResponse.json({ error: 'Refund reconciliation failed.' }, { status: 503 });
  }

  return NextResponse.json({ received: true, result: data });
}
