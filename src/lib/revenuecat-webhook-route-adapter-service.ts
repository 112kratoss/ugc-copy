import 'server-only';

import { NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { reconcileMobilePurchaseAdjustment } from '@/lib/mobile-commerce';
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
  logError?: typeof console.error;
  parseRevenueCatRefundEvent?: typeof parseRevenueCatRefundEvent;
  readBoundedWebhookBody?: typeof readBoundedWebhookBody;
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
    logError: dependencies?.logError ?? console.error,
    parseRevenueCatRefundEvent:
      dependencies?.parseRevenueCatRefundEvent ?? parseRevenueCatRefundEvent,
    readBoundedWebhookBody:
      dependencies?.readBoundedWebhookBody ?? readBoundedWebhookBody,
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
    return NextResponse.json({ error: 'Refund reconciliation failed.' }, { status: 503 });
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
