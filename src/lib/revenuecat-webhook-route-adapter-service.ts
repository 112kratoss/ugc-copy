import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  parseRevenueCatRefundEvent,
  webhookAuthorizationMatches,
} from '@/lib/revenuecat-webhook';
import { createServiceClient } from '@/lib/server-helpers';
import { isWebhookPayloadTooLarge } from '@/lib/webhook-request';

type RevenueCatRefundRpcClient = {
  rpc: (
    functionName: 'reconcile_mobile_credit_refund',
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

type RevenueCatWebhookRouteDependencies = {
  createServiceClient?: () => RevenueCatRefundRpcClient;
  getExpectedAuthorization?: () => string | undefined;
  isWebhookPayloadTooLarge?: typeof isWebhookPayloadTooLarge;
  logError?: typeof console.error;
  parseRevenueCatRefundEvent?: typeof parseRevenueCatRefundEvent;
  webhookAuthorizationMatches?: typeof webhookAuthorizationMatches;
};

function resolveDependencies(dependencies: RevenueCatWebhookRouteDependencies | undefined) {
  return {
    createServiceClient:
      dependencies?.createServiceClient
      ?? (() => createServiceClient() as RevenueCatRefundRpcClient),
    getExpectedAuthorization:
      dependencies?.getExpectedAuthorization
      ?? (() => process.env.REVENUECAT_WEBHOOK_AUTH_TOKEN),
    isWebhookPayloadTooLarge:
      dependencies?.isWebhookPayloadTooLarge ?? isWebhookPayloadTooLarge,
    logError: dependencies?.logError ?? console.error,
    parseRevenueCatRefundEvent:
      dependencies?.parseRevenueCatRefundEvent ?? parseRevenueCatRefundEvent,
    webhookAuthorizationMatches:
      dependencies?.webhookAuthorizationMatches ?? webhookAuthorizationMatches,
  };
}

async function handleRevenueCatWebhookPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  const expectedAuthorization = dependencies.getExpectedAuthorization();
  if (!expectedAuthorization) {
    dependencies.logError('RevenueCat webhook authorization is not configured.');
    return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 503 });
  }

  if (!dependencies.webhookAuthorizationMatches(request.headers.get('authorization'), expectedAuthorization)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  if (dependencies.isWebhookPayloadTooLarge(request)) {
    return NextResponse.json({ error: 'Webhook payload is too large.' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const parsed = dependencies.parseRevenueCatRefundEvent(body);
  if (parsed.kind === 'ignored') {
    return NextResponse.json({ received: true, ignored: true });
  }

  if (parsed.kind === 'invalid') {
    return NextResponse.json({ error: parsed.message }, { status: 400 });
  }

  const { event } = parsed;
  const { data, error } = await dependencies.createServiceClient().rpc('reconcile_mobile_credit_refund', {
    p_action: event.action,
    p_event_id: event.eventId,
    p_event_timestamp_ms: event.eventTimestampMs,
    p_external_order_id: event.externalOrderId,
    p_product_id: event.productId,
    p_user_id: event.userId,
  });

  if (error || typeof data !== 'string') {
    dependencies.logError('RevenueCat credit refund reconciliation failed:', error);
    return NextResponse.json({ error: 'Refund reconciliation failed.' }, { status: 503 });
  }

  return NextResponse.json({ received: true, result: data });
}

export async function postRevenueCatWebhookRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: RevenueCatWebhookRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleRevenueCatWebhookPOST(request, resolveDependencies(dependencies)),
    request,
  );
}
