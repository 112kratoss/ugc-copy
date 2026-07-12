import 'server-only';

import {
  enforceBackendRateLimit,
  MEDIA_TEMPLATE_MUTATION_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import {
  getTemplateApiAuth,
  readTemplateApiBody,
  templateApiErrorResponse,
  templateApiResponse,
} from '@/lib/media-template-api';
import {
  createMediaTemplate,
  disableMediaTemplate,
  getMediaTemplate,
  listActiveMediaTemplates,
  listOwnedMediaTemplates,
  publishMediaTemplate,
  updateMediaTemplate,
  validateMediaTemplateGraph,
} from '@/lib/media-template-service';
import { MediaTemplateError } from '@/lib/media-template-types';
import {
  approveTemplateRunStep,
  cancelTemplateRun,
  createTemplateInputUploadIntent,
  createTemplateRun,
  finalizeTemplateRunInputs,
  retryTemplateRunStep,
  startTemplateRun,
  syncTemplateRun,
} from '@/lib/template-run-service';

type IdContext = { params: Promise<{ id: string }> };
type RunStepContext = { params: Promise<{ id: string; stepId: string }> };
type AdapterResult = { body: unknown; status?: number };

async function respond(
  request: Request,
  action: () => Promise<AdapterResult>,
) {
  try {
    const result = await action();
    return templateApiResponse(request, result.body, result.status);
  } catch (error) {
    return templateApiErrorResponse(request, error);
  }
}

async function mutationAuth(request: Request) {
  const auth = await getTemplateApiAuth(request);
  await enforceBackendRateLimit(auth.adminClient, {
    ...MEDIA_TEMPLATE_MUTATION_RATE_LIMIT,
    key: auth.userId!,
  });
  return auth;
}

async function readOptionalBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MediaTemplateError('Invalid JSON body.', 400, 'INVALID_JSON');
  }
}

export function createMediaTemplatesRouteHandlers() {
  return {
    GET: (request: Request) => respond(request, async () => {
      const mine = new URL(request.url).searchParams.get('mine') === '1';
      const auth = await getTemplateApiAuth(request, mine);
      const templates = mine
        ? await listOwnedMediaTemplates(auth.adminClient, auth.userId!)
        : await listActiveMediaTemplates(auth.adminClient);
      return { body: { templates } };
    }),
    POST: (request: Request) => respond(request, async () => {
      const auth = await mutationAuth(request);
      const template = await createMediaTemplate(
        auth.adminClient,
        auth.userId!,
        await readTemplateApiBody(request),
      );
      return { body: { template }, status: 201 };
    }),
  };
}

export function createOwnedMediaTemplatesRouteHandlers() {
  return {
    GET: (request: Request) => respond(request, async () => {
      const auth = await getTemplateApiAuth(request);
      return {
        body: { templates: await listOwnedMediaTemplates(auth.adminClient, auth.userId!) },
      };
    }),
  };
}

export function createMediaTemplateValidationRouteHandlers() {
  return {
    POST: (request: Request) => respond(request, async () => {
      const auth = await mutationAuth(request);
      const validation = await validateMediaTemplateGraph({
        client: auth.adminClient,
        userId: auth.userId!,
        body: await readTemplateApiBody(request),
      });
      return { body: { validation } };
    }),
  };
}

export function createMediaTemplateDetailRouteHandlers() {
  return {
    GET: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await getTemplateApiAuth(request, false);
      return { body: { template: await getMediaTemplate(auth.adminClient, id, auth.userId) } };
    }),
    PATCH: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await mutationAuth(request);
      const template = await updateMediaTemplate(
        auth.adminClient,
        auth.userId!,
        id,
        await readTemplateApiBody(request),
      );
      return { body: { template } };
    }),
  };
}

export function createMediaTemplateDisableRouteHandlers() {
  return {
    POST: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await mutationAuth(request);
      return { body: { template: await disableMediaTemplate(auth.adminClient, auth.userId!, id) } };
    }),
  };
}

export function createMediaTemplatePublishRouteHandlers() {
  return {
    POST: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await mutationAuth(request);
      const template = await publishMediaTemplate(
        auth.adminClient,
        auth.userId!,
        id,
        await readTemplateApiBody(request),
      );
      return { body: { template } };
    }),
  };
}

export function createMediaTemplateRunsRouteHandlers({ isTest = false } = {}) {
  return {
    POST: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await mutationAuth(request);
      const run = await createTemplateRun({
        client: auth.adminClient,
        templateId: id,
        userId: auth.userId!,
        isTest,
        body: await readOptionalBody(request),
        idempotencyKey: request.headers.get('idempotency-key'),
      });
      return { body: { run }, status: 201 };
    }),
  };
}

export function createTemplateRunRouteHandlers() {
  return {
    GET: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await getTemplateApiAuth(request);
      const run = await syncTemplateRun({
        adminClient: auth.adminClient,
        request,
        runId: id,
        userClient: auth.userClient,
        userId: auth.userId!,
      });
      return { body: { run } };
    }),
  };
}

export function createTemplateRunInputSignRouteHandlers() {
  return {
    POST: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await mutationAuth(request);
      const result = await createTemplateInputUploadIntent({
        body: await readTemplateApiBody(request),
        client: auth.adminClient,
        runId: id,
        userId: auth.userId!,
      });
      return { body: result };
    }),
  };
}

export function createTemplateRunInputFinalizeRouteHandlers() {
  return {
    POST: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await mutationAuth(request);
      const run = await finalizeTemplateRunInputs({
        body: await readTemplateApiBody(request),
        client: auth.adminClient,
        runId: id,
        userId: auth.userId!,
      });
      return { body: { run } };
    }),
  };
}

export function createTemplateRunStartRouteHandlers() {
  return {
    POST: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await mutationAuth(request);
      const run = await startTemplateRun({
        adminClient: auth.adminClient,
        runId: id,
        userId: auth.userId!,
      });
      return { body: { run } };
    }),
  };
}

export function createTemplateRunStepRetryRouteHandlers() {
  return {
    POST: (request: Request, context: RunStepContext) => respond(request, async () => {
      const { id, stepId } = await context.params;
      const auth = await mutationAuth(request);
      const run = await retryTemplateRunStep({
        adminClient: auth.adminClient,
        runId: id,
        stepId,
        userId: auth.userId!,
      });
      return { body: { run } };
    }),
  };
}

export function createTemplateRunStepApprovalRouteHandlers() {
  return {
    POST: (request: Request, context: RunStepContext) => respond(request, async () => {
      const { id, stepId } = await context.params;
      const auth = await mutationAuth(request);
      const run = await approveTemplateRunStep({
        adminClient: auth.adminClient,
        runId: id,
        stepId,
        userId: auth.userId!,
      });
      return { body: { run } };
    }),
  };
}

export function createTemplateRunCancelRouteHandlers() {
  return {
    POST: (request: Request, context: IdContext) => respond(request, async () => {
      const { id } = await context.params;
      const auth = await mutationAuth(request);
      return { body: { run: await cancelTemplateRun(auth.adminClient, id, auth.userId!) } };
    }),
  };
}
