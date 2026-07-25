import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { reconcileMobilePurchaseAdjustment } from '@/lib/mobile-commerce';
import {
  REVENUECAT_WEBHOOK_PROCESSING_SERVICE_NAME,
  recordPaymentWebhookProcessingFailure,
} from '@/lib/provider-dependency-telemetry';
import {
  parseRevenueCatRefundEvent,
  webhookAuthorizationMatches,
} from '@/lib/revenuecat-webhook';
import { createServiceClient } from '@/lib/server-helpers';
import { readBoundedWebhookBody } from '@/lib/webhook-request';

type RevenueCatRefundRpcClient = Parameters<typeof reconcileMobilePurchaseAdjustment>[0];

type RevenueCatWebhookRouteDependencies = {
  createServiceClient?: () => RevenueCatRefundRpcClient;
  getExpectedAuthorization?: () => string | undefined;
  logError?: typeof logBackendRouteError;
  parseRevenueCatRefundEvent?: typeof parseRevenueCatRefundEvent;
  readBoundedWebhookBody?: typeof readBoundedWebhookBody;
  recordPaymentWebhookProcessingFailure?: typeof recordPaymentWebhookProcessingFailure;
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
    logError: dependencies?.logError ?? logBackendRouteError,
    parseRevenueCatRefundEvent:
      dependencies?.parseRevenueCatRefundEvent ?? parseRevenueCatRefundEvent,
    readBoundedWebhookBody:
      dependencies?.readBoundedWebhookBody ?? readBoundedWebhookBody,
    recordPaymentWebhookProcessingFailure:
      dependencies?.recordPaymentWebhookProcessingFailure
      ?? recordPaymentWebhookProcessingFailure,
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

  const boundedBody = await dependencies.readBoundedWebhookBody(request);
  if (!boundedBody.ok) {
    return NextResponse.json({ error: 'Webhook payload is too large.' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(boundedBody.text) as unknown;
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
  const adminSupabase = dependencies.createServiceClient();
  let settlement;
  try {
    settlement = await reconcileMobilePurchaseAdjustment(adminSupabase, {
      action: event.action,
      externalOrderId: event.externalOrderId,
      productId: event.productId,
      providerEventId: event.eventId,
      providerEventTimestampMs: event.eventTimestampMs,
      userId: event.userId,
    });
  } catch (error) {
    dependencies.logError('RevenueCat purchase adjustment reconciliation failed:', error);
    await dependencies.recordPaymentWebhookProcessingFailure({
      serviceName: REVENUECAT_WEBHOOK_PROCESSING_SERVICE_NAME,
      failureCode: 'refund_reconciliation_failed',
      status: 503,
    }, adminSupabase);
    return NextResponse.json({ error: 'Refund reconciliation failed.' }, { status: 503 });
  }

  if (settlement.status === 'not_found') {
    // The refunded purchase has not been synced into the ledger yet (webhook
    // raced the client sync). A 200 would end RevenueCat's redelivery and lose
    // the refund; answer retryable so a later attempt lands after the sync.
    dependencies.logError('RevenueCat refund arrived before the purchase was synced; requesting retry.');
    await dependencies.recordPaymentWebhookProcessingFailure({
      serviceName: REVENUECAT_WEBHOOK_PROCESSING_SERVICE_NAME,
      failureCode: 'refund_purchase_not_synced',
      status: 503,
    }, adminSupabase);
    return NextResponse.json({ error: 'Purchase is not synced yet.' }, { status: 503 });
  }

  return NextResponse.json({ received: true, result: settlement.status });
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
