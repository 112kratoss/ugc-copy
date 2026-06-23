import 'server-only';

import { after, NextResponse } from 'next/server';

import { applyPrivateNoStoreApiResponseHeaders } from '@/lib/api-cache';
import {
  handleKieWebhookForRoute,
  type KieWebhookRouteInput,
} from '@/lib/kie-webhook-service';
import { createServiceClient } from '@/lib/server-helpers';

type KieWebhookRouteAdapterDependencies = {
  createServiceClient?: typeof createServiceClient;
  handleKieWebhookForRoute?: typeof handleKieWebhookForRoute;
  scheduleAfter?: KieWebhookRouteInput['scheduleAfter'];
};

function resolveDependencies(dependencies: KieWebhookRouteAdapterDependencies | undefined) {
  return {
    createServiceClient: dependencies?.createServiceClient ?? createServiceClient,
    handleKieWebhookForRoute: dependencies?.handleKieWebhookForRoute ?? handleKieWebhookForRoute,
    scheduleAfter: dependencies?.scheduleAfter ?? after,
  };
}

export function createKieWebhookRouteHandlers({
  dependencies,
}: {
  dependencies?: KieWebhookRouteAdapterDependencies;
} = {}) {
  return {
    async POST(request: Request) {
      const resolvedDependencies = resolveDependencies(dependencies);
      const result = await resolvedDependencies.handleKieWebhookForRoute({
        createServiceClient: resolvedDependencies.createServiceClient,
        request,
        scheduleAfter: resolvedDependencies.scheduleAfter,
      });

      return applyPrivateNoStoreApiResponseHeaders(
        NextResponse.json(result.body, { status: result.status }),
        request,
      );
    },
  };
}
