import 'server-only';
import { logBackendRouteError } from '@/lib/backend-logger';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import { verifyRazorpaySignature } from '@/lib/razorpay-signature';
import { processRazorpayWebhookForRoute } from '@/lib/razorpay-webhook-service';
import { createServiceClient } from '@/lib/server-helpers';
import { isWebhookPayloadTooLarge, readBoundedWebhookBody } from '@/lib/webhook-request';

type RazorpayWebhookRouteDependencies = {
  createServiceClient?: typeof createServiceClient;
  getWebhookSecret?: () => string | undefined;
  isWebhookPayloadTooLarge?: typeof isWebhookPayloadTooLarge;
  logError?: typeof logBackendRouteError;
  processRazorpayWebhookForRoute?: typeof processRazorpayWebhookForRoute;
  verifyRazorpaySignature?: typeof verifyRazorpaySignature;
};

function resolveDependencies(dependencies: RazorpayWebhookRouteDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    getWebhookSecret: dependencies?.getWebhookSecret ?? (() => process.env.RAZORPAY_WEBHOOK_SECRET),
    isWebhookPayloadTooLarge: dependencies?.isWebhookPayloadTooLarge ?? isWebhookPayloadTooLarge,
    logError: dependencies?.logError ?? logBackendRouteError,
    processRazorpayWebhookForRoute:
      dependencies?.processRazorpayWebhookForRoute ?? processRazorpayWebhookForRoute,
    verifyRazorpaySignature: dependencies?.verifyRazorpaySignature ?? verifyRazorpaySignature,
  };
}

async function handleRazorpayWebhookPOST(
  request: Request,
  dependencies: ReturnType<typeof resolveDependencies>,
) {
  try {
    const webhookSecret = dependencies.getWebhookSecret();
    if (!webhookSecret) {
      dependencies.logError('RAZORPAY_WEBHOOK_SECRET not configured');
      return new Response('Webhook secret not configured', { status: 500 });
    }

    if (dependencies.isWebhookPayloadTooLarge(request)) {
      return new Response('Webhook payload too large', { status: 413 });
    }

    const boundedBody = await readBoundedWebhookBody(request);
    if (!boundedBody.ok) {
      return new Response('Webhook payload too large', { status: 413 });
    }
    const body = boundedBody.text;
    const signature = request.headers.get('x-razorpay-signature');

    if (!signature) {
      return new Response('Missing signature', { status: 400 });
    }

    if (!dependencies.verifyRazorpaySignature({
      payload: body,
      signature,
      secret: webhookSecret,
    })) {
      dependencies.logError('Invalid webhook signature');
      return new Response('Invalid signature', { status: 400 });
    }

    const result = await dependencies.processRazorpayWebhookForRoute({
      createAdminSupabase: dependencies.createServiceClient,
      rawBody: body,
    });

    return new Response(result.body, { status: result.status });
  } catch (error) {
    dependencies.logError('Webhook processing error:', error);
    return new Response('Internal error', { status: 500 });
  }
}

export async function postRazorpayWebhookRouteResponse({
  dependencies,
  request,
}: {
  dependencies?: RazorpayWebhookRouteDependencies;
  request: Request;
}) {
  return applyPrivateNoStoreApiResponseHeaders(
    await handleRazorpayWebhookPOST(request, resolveDependencies(dependencies)),
    request,
  );
}
