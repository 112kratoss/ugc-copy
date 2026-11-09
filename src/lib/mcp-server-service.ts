import { randomUUID } from 'node:crypto';

import { McpServer, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import {
  BackendRateLimitError,
  OWNER_GENERATIONS_READ_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { createGenerationModelQuote } from '@/lib/generation-model-quote-service';
import { MCP_ERROR_CODES, toolFailure, toolSuccess } from '@/lib/mcp-tool-results';
import {
  readModelCatalogCurrent,
  readModelCatalogDetails,
  readModelCatalogPage,
} from '@/lib/model-catalog-read-service';
import {
  ModelCatalogTransportError,
  decodeCatalogCursor,
  encodeCatalogCursor,
  type ModelCatalogKind,
} from '@/lib/model-catalog-transport';
import { listOwnerGenerationsForRoute } from '@/lib/owner-generations-route-service';
import { enhancePromptForUser } from '@/lib/prompt-enhancement-service';
import { getPromptEnhancementCost } from '@/lib/prompt-enhancer';
import { postUnifiedGenerationForRoute } from '@/lib/unified-generation-route-service';
import {
  buildUnifiedGenerationQuoteInput,
  parseUnifiedGenerationRequest,
} from '@/lib/unified-generation-start-service';

/**
 * The MCP server's tool registry: what an agent acting as a signed-in creator can do, and the
 * handler behind each tool (`docs/plans/agent-mcp-server-plan-2026-11-09.md`, phase 1: the
 * create-media job).
 *
 * The tools are a thin layer over the services the web and the app already call. Nothing here
 * prices a run, reads the catalog on its own or touches credits: the quote service prices, the
 * unified start charges (and refuses a run above the price the agent confirmed), the owner
 * library read answers what a run became, and every rate limit is the creator's own, keyed on
 * the creator as the web's routes key it. What this layer adds is the agent's view of those
 * answers: snake_case fields, a sentence of text beside the data, stable error codes, and in
 * every description the next call to make.
 *
 * A short balance is answered with the balance and the shortfall and never a purchase link
 * (ChatGPT's directory forbids selling credits in-app; the Anthropic and ChatGPT paths stay
 * equal). Prompts are the creator's own and travel in results, never into logs.
 */

export const MCP_SERVER_NAME = 'magicbooklet';
export const MCP_SERVER_VERSION = '1.0.0';

/** The time get_generation may spend waiting for a run, within the route's 60-second budget. */
export const MCP_GENERATION_WAIT_MAX_SECONDS = 45;
export const MCP_GENERATION_POLL_INTERVAL_MS = 3_000;
export const MCP_LIST_PAGE_MAX = 50;

const CATALOG_PLATFORM = 'web' as const;

export type McpToolName =
  | 'list_models'
  | 'get_model'
  | 'quote_generation'
  | 'create_media'
  | 'get_generation'
  | 'list_creations'
  | 'enhance_prompt';

export type McpToolCallRecord = {
  tool: McpToolName;
  outcome: 'ok' | 'error' | 'threw';
  code: string | null;
  costCredits: number | null;
  elapsedMs: number;
  error?: unknown;
};

/** The services a tool calls. Injected so each handler is tested against a fake of the real one. */
export type McpToolServices = {
  readModelCatalogCurrent: typeof readModelCatalogCurrent;
  readModelCatalogPage: typeof readModelCatalogPage;
  readModelCatalogDetails: typeof readModelCatalogDetails;
  createGenerationModelQuote: typeof createGenerationModelQuote;
  postUnifiedGenerationForRoute: typeof postUnifiedGenerationForRoute;
  listOwnerGenerationsForRoute: typeof listOwnerGenerationsForRoute;
  enhancePromptForUser: typeof enhancePromptForUser;
  enforceBackendRateLimit: typeof enforceBackendRateLimit;
  /** The creator's total spendable balance (`profiles.credits`). */
  readCreditBalance: (admin: SupabaseClient, userId: string) => Promise<number>;
  promptEnhancementCost: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/**
 * One admitted request's context: who is calling, through which OAuth client, with the admitted
 * request the services read the trusted identity assertion from.
 */
export type McpToolContext = {
  /** The admitted request: the agent's bearer token plus the route's fresh identity assertion. */
  request: Request;
  userId: string;
  /** The OAuth client the token was issued to (`agent-token.ts`). */
  clientId: string;
  /** The site's origin, for the permanent links results carry. */
  siteOrigin: string;
  kieApiKey: string | undefined;
  createUserSupabase: () => SupabaseClient;
  createAdminSupabase: () => SupabaseClient;
  services: McpToolServices;
  /** Told once per tool call, whatever the outcome; the adapter logs it. */
  onToolCall?: (record: McpToolCallRecord) => void;
};

export async function readCreditBalance(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  const credits = (data as { credits?: unknown } | null)?.credits;
  return typeof credits === 'number' ? credits : 0;
}

export function defaultMcpToolServices(): McpToolServices {
  return {
    readModelCatalogCurrent,
    readModelCatalogPage,
    readModelCatalogDetails,
    createGenerationModelQuote,
    postUnifiedGenerationForRoute,
    listOwnerGenerationsForRoute,
    enhancePromptForUser,
    enforceBackendRateLimit,
    readCreditBalance,
    promptEnhancementCost: getPromptEnhancementCost,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

type AnySchema = z.ZodObject<z.ZodRawShape>;

export interface McpToolDefinition<Schema extends AnySchema = AnySchema> {
  name: McpToolName;
  title: string;
  /** Written for the agent: when to call the tool and what to do with the answer. */
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Schema;
  // A method signature rather than a property: TypeScript relates methods bivariantly, so a
  // tool whose handler takes its own schema's output is assignable to the registry's element
  // type, while the SDK still gives each handler the arguments its schema parsed.
  handle(args: z.output<Schema>, context: McpToolContext): Promise<CallToolResult>;
}

function defineTool<Schema extends AnySchema>(definition: McpToolDefinition<Schema>): McpToolDefinition {
  return definition;
}

// ---------------------------------------------------------------------------------------------
// Shared shapes

const KIND = z.enum(['image', 'video', 'motion']);
const SETTING_VALUE = z.union([z.string(), z.number(), z.boolean()]);
const SETTINGS = z.record(z.string(), SETTING_VALUE)
  .describe('Setting key to value, as get_model lists the model\'s controls (for example aspectRatio, duration, resolution). Leave a key out to use its default.');
const INPUT_KIND = z.enum(['image', 'video', 'audio', 'character', 'preparedVoice']);
const INPUT_COUNTS = z.object({
  images: z.int().min(0).optional(),
  videos: z.int().min(0).optional(),
  audios: z.int().min(0).optional(),
  prepared_audios: z.int().min(0).optional(),
  characters: z.int().min(0).optional(),
}).describe('How many inputs of each kind the run will carry, so the quote prices them.');
const INPUT_METADATA = z.object({
  reference_video_durations_seconds: z.array(z.number().nonnegative()).max(64).optional()
    .describe('The length of each reference clip in seconds, for models that price by it. A COST_CHANGED answer with measured_inputs gives you the lengths to send.'),
}).optional();
const GENERATION_ID = z.uuid().describe('The generation_id create_media or list_creations gave.');

function creationUrl(siteOrigin: string, generationId: string): string {
  return `${siteOrigin}/creations?generation=${encodeURIComponent(generationId)}`;
}

function postUrl(siteOrigin: string, postId: string): string {
  return `${siteOrigin}/post/${encodeURIComponent(postId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function excerpt(value: unknown, length: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > length ? `${trimmed.slice(0, length - 1)}…` : trimmed;
}

function credits(count: number): string {
  return `${count} credit${count === 1 ? '' : 's'}`;
}

/** Every run reads the creator's own library limit once, polls included, as the studio does. */
async function refuseReadOverLimit(context: McpToolContext): Promise<CallToolResult | null> {
  try {
    await context.services.enforceBackendRateLimit(context.createAdminSupabase(), {
      ...OWNER_GENERATIONS_READ_RATE_LIMIT,
      key: context.userId,
    });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) return rateLimited(error.retryAfterSeconds);
    throw error;
  }
}

function rateLimited(retryAfterSeconds: number | undefined): CallToolResult {
  const wait = retryAfterSeconds ?? 60;
  return toolFailure(
    MCP_ERROR_CODES.RATE_LIMITED,
    `The creator's limit for this action is spent for now. Wait ${wait} seconds, then try again.`,
    { retry_after_seconds: wait },
  );
}

function insufficientCredits(balance: number, cost: number, what: string): CallToolResult {
  const shortfall = Math.max(0, cost - balance);
  return toolFailure(
    MCP_ERROR_CODES.INSUFFICIENT_CREDITS,
    `The creator has ${credits(balance)} and ${what} costs ${credits(cost)}: ${credits(shortfall)} short. Nothing was charged. Tell the person their balance and the shortfall; the balance is theirs to change.`,
    { balance_credits: balance, cost_credits: cost, shortfall_credits: shortfall },
  );
}

function catalogUnavailable(error: unknown): CallToolResult {
  if (error instanceof ModelCatalogTransportError) {
    if (error.code === 'CATALOG_REVISION_UNAVAILABLE') {
      return toolFailure(
        'CATALOG_CHANGED',
        'The model catalog has moved to a new revision. Call list_models again and quote again from it.',
        { catalog_error: error.code },
      );
    }
    return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, error.message, { catalog_error: error.code });
  }
  return toolFailure(
    MCP_ERROR_CODES.UNAVAILABLE,
    'The model catalog could not be read right now. Try again in a moment.',
  );
}

// ---------------------------------------------------------------------------------------------
// list_models

const listModelsTool = defineTool({
  name: 'list_models',
  title: 'List generation models',
  description: [
    'List the generation models a creator can run on Magicbooklet, with the catalog_revision every quote and run must name.',
    'Call it first, before quote_generation or create_media, and again when a call answers CATALOG_CHANGED or MODEL_UNAVAILABLE.',
    'Filter by kind (image, video or motion) and page with next_cursor; defaults names the model each kind opens on.',
    'Then call get_model for a model\'s settings and inputs.',
  ].join(' '),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({
    kind: KIND.optional().describe('Only models of this kind: image, video or motion.'),
    limit: z.int().min(1).max(MCP_LIST_PAGE_MAX).optional().describe('Models per page, at most 50 (default 32).'),
    cursor: z.string().max(1024).optional().describe('next_cursor from the previous page.'),
  }),
  async handle({ kind, limit = 32, cursor }, context) {
    const { services } = context;
    try {
      const current = await services.readModelCatalogCurrent(CATALOG_PLATFORM);
      const revision = current.revision;
      const kindFilter: ModelCatalogKind | null = kind ?? null;
      const after = decodeCatalogCursor(cursor ?? null, revision, kindFilter, CATALOG_PLATFORM);
      const rows = await services.readModelCatalogPage({
        platform: CATALOG_PLATFORM,
        revision,
        kind: kindFilter,
        after,
        limit,
      });
      const page = rows.slice(0, limit);
      const nextCursor = rows.length > limit && page.length
        ? encodeCatalogCursor(revision, kindFilter, page[page.length - 1], CATALOG_PLATFORM)
        : null;
      const models = page.map((model) => ({
        model_id: model.id,
        kind: model.kind,
        display_name: model.displayName,
        description: model.description,
        badge: model.badge,
        recommended: model.recommended,
      }));
      const lines = models.map((model) => (
        `- ${model.model_id} (${model.kind}): ${model.display_name}${model.recommended ? ', recommended' : ''}`
      ));
      return toolSuccess(
        [
          `${models.length} model${models.length === 1 ? '' : 's'}${kind ? ` of kind ${kind}` : ''}, catalog revision ${revision}.`,
          ...lines,
          nextCursor ? 'More models follow: call again with next_cursor.' : '',
          'Call get_model for a model\'s settings and inputs, then quote_generation for its price.',
        ].filter(Boolean).join('\n'),
        {
          catalog_revision: revision,
          defaults: current.defaults,
          models,
          next_cursor: nextCursor,
        },
      );
    } catch (error) {
      return catalogUnavailable(error);
    }
  },
});

// ---------------------------------------------------------------------------------------------
// get_model

const getModelTool = defineTool({
  name: 'get_model',
  title: 'Describe a model',
  description: [
    'Describe one model: its settings (controls with their options and defaults), the inputs it takes (reference pictures, clips, sounds, start and end frames, with counts and limits), and its capabilities.',
    'Call it after list_models and build the settings and inputs you give quote_generation and create_media from it.',
    'Prices are not here: quote_generation prices a run.',
  ].join(' '),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({
    model_id: z.string().min(1).max(200).describe('A model_id from list_models.'),
  }),
  async handle({ model_id: modelId }, context) {
    const { services } = context;
    try {
      const current = await services.readModelCatalogCurrent(CATALOG_PLATFORM);
      const models = await services.readModelCatalogDetails(current.revision, [modelId], CATALOG_PLATFORM);
      const model = models.find((candidate) => candidate.id === modelId);
      if (!model) {
        return toolFailure(
          MCP_ERROR_CODES.NOT_FOUND,
          `No model ${modelId} in catalog revision ${current.revision}. Call list_models for the models on offer.`,
          { model_id: modelId, catalog_revision: current.revision },
        );
      }
      // The compact descriptor the catalog route serves: the legacy `inputs` block is the
      // schema-v1 projection, superseded by inputModes and inputConstraints.
      const { inputs: _legacyInputs, ...descriptor } = model;
      void _legacyInputs;
      const controls = model.controls.map((control) => control.key).join(', ');
      return toolSuccess(
        [
          `${model.displayName} (${model.id}, ${model.kind}), catalog revision ${current.revision}.`,
          model.description,
          controls ? `Settings: ${controls}.` : 'No settings to choose.',
          `Quote a run on it with quote_generation, naming catalog_revision ${current.revision}.`,
        ].join('\n'),
        { catalog_revision: current.revision, model: descriptor },
      );
    } catch (error) {
      return catalogUnavailable(error);
    }
  },
});

// ---------------------------------------------------------------------------------------------
// quote_generation

function quoteBodyOf(args: {
  kind: 'image' | 'video' | 'motion';
  model_id: string;
  settings?: Record<string, string | number | boolean>;
  input_counts?: z.output<typeof INPUT_COUNTS>;
  input_metadata?: z.output<typeof INPUT_METADATA>;
  catalog_revision?: string;
}): GenerationModelQuoteInput {
  return {
    kind: args.kind,
    modelId: args.model_id,
    schemaVersion: 3,
    settings: args.settings ?? {},
    inputCounts: args.input_counts
      ? {
        images: args.input_counts.images,
        videos: args.input_counts.videos,
        audios: args.input_counts.audios,
        preparedAudios: args.input_counts.prepared_audios,
        characters: args.input_counts.characters,
      }
      : undefined,
    inputMetadata: args.input_metadata?.reference_video_durations_seconds
      ? { referenceVideoDurationsSeconds: args.input_metadata.reference_video_durations_seconds }
      : undefined,
    catalogRevision: args.catalog_revision ?? null,
  };
}

async function quote(context: McpToolContext, body: GenerationModelQuoteInput) {
  return context.services.createGenerationModelQuote({
    body,
    rateLimitKey: context.userId,
    rateLimitClient: context.createAdminSupabase(),
    platform: CATALOG_PLATFORM,
  });
}

function quoteRefusal(result: Extract<Awaited<ReturnType<typeof createGenerationModelQuote>>, { ok: false }>): CallToolResult {
  if (result.code === 'RATE_LIMITED') return rateLimited(result.retryAfterSeconds);
  if (result.code === 'CATALOG_CHANGED') {
    return toolFailure('CATALOG_CHANGED', `${result.error} Call list_models again and quote from its revision.`);
  }
  if (result.code === 'MODEL_UNAVAILABLE') {
    return toolFailure(MCP_ERROR_CODES.NOT_FOUND, `${result.error} Call list_models for the models on offer.`, { catalog_error: result.code });
  }
  if (result.code === 'INVALID_MODEL_SETTINGS') {
    return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, `${result.error} Check the settings against get_model.`, { field_errors: result.fieldErrors });
  }
  if (result.status >= 500) return toolFailure(MCP_ERROR_CODES.UNAVAILABLE, result.error);
  return toolFailure(result.code, result.error, { field_errors: result.fieldErrors });
}

const quoteGenerationTool = defineTool({
  name: 'quote_generation',
  title: 'Price a run',
  description: [
    'Price a run before starting it. Free: it spends no credits.',
    'Returns cost_credits, the creator\'s balance_credits, affordable, and the catalog_revision the price belongs to.',
    'Send the kind, model_id, settings and input_counts you will give create_media, then give create_media the cost as expected_cost_credits: a run is never charged more than the price it was confirmed at.',
    'Tell the person the price before you create.',
  ].join(' '),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({
    kind: KIND,
    model_id: z.string().min(1).max(200),
    settings: SETTINGS.optional(),
    input_counts: INPUT_COUNTS.optional(),
    input_metadata: INPUT_METADATA,
    catalog_revision: z.string().min(1).max(200).optional().describe('The catalog_revision list_models gave; left out, the current one is used.'),
  }),
  async handle(args, context) {
    const result = await quote(context, quoteBodyOf(args));
    if (!result.ok) return quoteRefusal(result);
    const balance = await context.services.readCreditBalance(context.createAdminSupabase(), context.userId);
    const cost = result.quote.costCredits;
    const affordable = balance >= cost;
    return toolSuccess(
      [
        `${credits(cost)} for a ${args.kind} run on ${result.quote.modelId}; the creator has ${credits(balance)}, so the run is ${affordable ? 'affordable' : `not affordable (${credits(cost - balance)} short)`}.`,
        `Catalog revision ${result.quote.catalogRevision}.`,
        affordable
          ? `To start it, call create_media with the same run, catalog_revision ${result.quote.catalogRevision} and expected_cost_credits ${cost}, once the person has agreed to the price.`
          : 'Tell the person the balance and the shortfall before anything else.',
      ].join('\n'),
      {
        cost_credits: cost,
        balance_credits: balance,
        affordable,
        catalog_revision: result.quote.catalogRevision,
        model_id: result.quote.modelId,
        normalized_settings: result.quote.normalizedSettings,
      },
    );
  },
});

// ---------------------------------------------------------------------------------------------
// create_media

const CREATE_MEDIA_INPUT = z.object({
  slot: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).describe('The input slot key from get_model (for example references, startFrame, endFrame).'),
  kind: INPUT_KIND,
  url: z.url().optional().describe('An https URL of the media.'),
  asset_id: z.string().min(1).max(200).optional().describe('A Magicbooklet asset id (a saved input, or a prepared Seedance asset) in place of a URL.'),
  duration_seconds: z.number().nonnegative().optional().describe('A clip or track\'s length, where known.'),
  label: z.string().max(200).optional(),
  handle: z.string().max(64).optional().describe('The @handle the prompt names this input by, on models that take named subjects.'),
  source_generation_id: z.uuid().optional().describe('The creation this input came from, when it is one of the creator\'s own outputs.'),
});

const createMediaTool = defineTool({
  name: 'create_media',
  title: 'Create media',
  description: [
    'Start an image, video or motion run with the creator\'s own credits.',
    'Requires expected_cost_credits, the cost quote_generation gave for this exact run, and charges at most that: when the price has changed the answer is COST_CHANGED with the fresh price and nothing is charged, so quote again and ask the person before confirming the new price.',
    'Returns a generation_id at once; the run continues in the background, so call get_generation with wait_seconds to wait for it.',
    'Send an idempotency_key of your own to make a retry safe; without one, every call starts a new run.',
    'A failed run refunds its credits by itself. INSUFFICIENT_CREDITS states the balance and the shortfall.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: z.object({
    kind: KIND,
    model_id: z.string().min(1).max(200).describe('A model_id from list_models.'),
    catalog_revision: z.string().min(1).max(200).describe('The catalog_revision the quote named.'),
    prompt: z.string().max(20_000).optional().describe('The prompt. Required by most models; a motion run may take only inputs.'),
    settings: SETTINGS.optional(),
    shots: z.array(z.object({
      prompt: z.string().min(1).max(20_000),
      duration: z.number().positive().optional().describe('Seconds.'),
      settings: SETTINGS.optional(),
    })).max(20).optional().describe('A multi-shot story on models that support it; settings.duration must equal the shots\' total.'),
    inputs: z.array(CREATE_MEDIA_INPUT).max(64).optional(),
    source_generation_id: z.uuid().optional().describe('The creation this run remixes, when it is one.'),
    expected_cost_credits: z.int().min(0).describe('The cost_credits quote_generation gave for this run. The run is refused, not charged more, if the price is higher now.'),
    idempotency_key: z.string().min(1).max(256).optional().describe('Your own key for this run; a repeat with the same key returns the run started under it instead of starting another.'),
  }),
  async handle(args, context) {
    const { services } = context;
    const body: Record<string, unknown> = {
      kind: args.kind,
      modelId: args.model_id,
      catalogRevision: args.catalog_revision,
      prompt: args.prompt ?? '',
      settings: args.settings ?? {},
      shots: (args.shots ?? []).map((shot) => ({
        prompt: shot.prompt,
        duration: shot.duration ?? null,
        settings: shot.settings ?? {},
      })),
      inputs: (args.inputs ?? []).map((input) => ({
        slot: input.slot,
        kind: input.kind,
        url: input.url,
        assetId: input.asset_id,
        durationSeconds: input.duration_seconds ?? null,
        label: input.label,
        handle: input.handle,
        sourceGenerationId: input.source_generation_id,
      })),
      sourceGenerationId: args.source_generation_id,
      expectedCostCredits: args.expected_cost_credits,
      idempotencyKey: args.idempotency_key ?? randomUUID(),
    };

    const result = await services.postUnifiedGenerationForRoute({
      request: context.request,
      readRequestBody: async () => body,
      createUserSupabase: context.createUserSupabase,
      createAdminSupabase: context.createAdminSupabase,
      kieApiKey: context.kieApiKey,
    });

    if (result.ok) {
      const payload = result.body;
      const generationId = stringOrNull(payload.generationId);
      const cost = numberOrNull(payload.cost) ?? args.expected_cost_credits;
      const balance = numberOrNull(payload.remainingCredits);
      const replay = payload.idempotentReplay === true;
      return toolSuccess(
        [
          replay
            ? `This idempotency key already started ${args.kind} run ${generationId ?? payload.predictionId}; here it is again, nothing new was charged.`
            : `Started ${args.kind} run ${generationId ?? payload.predictionId} on ${args.model_id} for ${credits(cost)}${balance === null ? '' : `; the creator has ${credits(balance)} left`}.`,
          generationId
            ? `It is processing. Call get_generation with generation_id ${generationId} and wait_seconds ${MCP_GENERATION_WAIT_MAX_SECONDS} until its status is succeeded or failed.`
            : 'It is processing; find it with list_creations in a moment.',
        ].join('\n'),
        {
          generation_id: generationId,
          prediction_id: stringOrNull(payload.predictionId),
          status: 'processing',
          cost_credits: cost,
          balance_credits: balance,
          catalog_revision: stringOrNull(payload.catalogRevision) ?? args.catalog_revision,
          model_id: stringOrNull(payload.modelId) ?? args.model_id,
          idempotent_replay: replay,
          creation_url: generationId ? creationUrl(context.siteOrigin, generationId) : null,
        },
      );
    }

    const code = typeof result.body.code === 'string' ? result.body.code : 'GENERATION_START_FAILED';
    const message = typeof result.body.error === 'string' ? result.body.error : 'The run could not be started.';

    if (code === 'cost_changed' || code === 'REFERENCE_DURATION_CHANGED') {
      const fresh = code === 'REFERENCE_DURATION_CHANGED'
        ? numberOrNull(result.body.costCredits)
        : await freshQuoteCost(context, body);
      return toolFailure(
        MCP_ERROR_CODES.COST_CHANGED,
        fresh === null
          ? `The price of this run is no longer the ${credits(args.expected_cost_credits)} you confirmed. Nothing was charged. Call quote_generation again, confirm the new price with the person, then create again with it.`
          : `This run now costs ${credits(fresh)}, not the ${credits(args.expected_cost_credits)} you confirmed. Nothing was charged. Confirm the new price with the person, then call create_media again with expected_cost_credits ${fresh}.`,
        {
          expected_cost_credits: args.expected_cost_credits,
          cost_credits: fresh,
          ...(code === 'REFERENCE_DURATION_CHANGED'
            ? { quoted_cost_credits: numberOrNull(result.body.quotedCostCredits), measured_inputs: result.body.inputs ?? [] }
            : {}),
        },
      );
    }
    if (code === 'insufficient_credits') {
      const [balance, fresh] = await Promise.all([
        services.readCreditBalance(context.createAdminSupabase(), context.userId),
        freshQuoteCost(context, body),
      ]);
      return insufficientCredits(balance, fresh ?? args.expected_cost_credits, 'this run');
    }
    if (code === 'RATE_LIMITED') return rateLimited(result.rateLimitError?.retryAfterSeconds);
    if (code === 'UNAUTHORIZED') {
      return toolFailure(MCP_ERROR_CODES.UNAUTHORIZED, 'The creator\'s identity could not be read from the token. Reconnect and try again.');
    }
    if (code === 'INVALID_GENERATION_REQUEST' || code === 'INVALID_MODEL_SETTINGS') {
      return toolFailure(
        MCP_ERROR_CODES.INVALID_REQUEST,
        `${message} Check the settings and inputs against get_model.`,
        { field_errors: isRecord(result.body.fieldErrors) ? result.body.fieldErrors : {} },
      );
    }
    if (code === 'CATALOG_CHANGED') {
      return toolFailure('CATALOG_CHANGED', `${message} Call list_models again, quote again from its revision, and create with that revision.`);
    }
    if (code === 'MODEL_UNAVAILABLE') {
      return toolFailure(MCP_ERROR_CODES.NOT_FOUND, `${message} Call list_models for the models on offer.`, { catalog_error: code });
    }
    if (result.status >= 500 || code === 'provider_unavailable' || code === 'GENERATION_SERVICE_UNAVAILABLE' || code === 'GENERATION_ADAPTER_UNAVAILABLE') {
      return toolFailure(MCP_ERROR_CODES.UNAVAILABLE, `${message} Try again in a moment; a retry with the same idempotency_key is safe.`, { start_error: code });
    }
    return toolFailure(code.toUpperCase(), message, {
      ...(isRecord(result.body.fieldErrors) ? { field_errors: result.body.fieldErrors } : {}),
      ...(typeof result.body.generationId === 'string' ? { generation_id: result.body.generationId } : {}),
    });
  },
});

/** The price of the run as it stands, for a COST_CHANGED or a short balance; null when it cannot be read. */
async function freshQuoteCost(context: McpToolContext, body: Record<string, unknown>): Promise<number | null> {
  try {
    const quoteInput = buildUnifiedGenerationQuoteInput(parseUnifiedGenerationRequest(body));
    const result = await quote(context, quoteInput);
    return result.ok ? result.quote.costCredits : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// get_generation and list_creations

type GenerationItem = Record<string, unknown>;

async function readGenerations(
  context: McpToolContext,
  params: Record<string, string>,
): Promise<{ generations: GenerationItem[]; nextCursor: string | null }> {
  const payload = await context.services.listOwnerGenerationsForRoute({
    userId: context.userId,
    supabase: context.createUserSupabase(),
    getAdminSupabase: context.createAdminSupabase,
    searchParams: new URLSearchParams(params),
  });
  return { generations: payload.generations, nextCursor: payload.pagination.nextCursor };
}

function isSettled(status: string | null): boolean {
  return status === 'succeeded' || status === 'failed';
}

function outputsOf(item: GenerationItem): Array<Record<string, unknown>> {
  const media = isRecord(item.media) ? item.media : null;
  const outputUrls = Array.isArray(item.output_urls)
    ? item.output_urls.filter((url): url is string => typeof url === 'string')
    : [];
  if (outputUrls.length > 1) {
    return outputUrls.map((url, index) => ({
      url,
      preview_url: index === 0 ? (media?.previewUrl ?? item.preview_url ?? null) : null,
    }));
  }
  const url = media?.url ?? item.output_url;
  if (typeof url !== 'string') return [];
  return [{
    url,
    preview_url: media?.previewUrl ?? item.preview_url ?? null,
    kind: media?.kind ?? null,
    width: media?.width ?? null,
    height: media?.height ?? null,
    duration_seconds: media?.durationSeconds ?? null,
    expires_at: media?.expiresAt ?? null,
  }];
}

function summarize(item: GenerationItem, context: McpToolContext): Record<string, unknown> {
  const generationId = String(item.id);
  const postId = stringOrNull(item.linked_post_id);
  const media = isRecord(item.media) ? item.media : null;
  return {
    generation_id: generationId,
    status: stringOrNull(item.status),
    settled: isSettled(stringOrNull(item.status)),
    kind: stringOrNull(item.category),
    model_id: stringOrNull(item.model),
    prompt_excerpt: excerpt(item.prompt, 160),
    created_at: stringOrNull(item.created_at),
    completed_at: stringOrNull(item.completed_at),
    cost_credits: numberOrNull(item.cost),
    refunded: item.refunded === true,
    posted: postId !== null,
    post_id: postId,
    post_url: postId ? postUrl(context.siteOrigin, postId) : null,
    creation_url: creationUrl(context.siteOrigin, generationId),
    preview_url: stringOrNull(media?.previewUrl ?? item.preview_url),
  };
}

const getGenerationTool = defineTool({
  name: 'get_generation',
  title: 'Read a run',
  description: [
    'Read one of the creator\'s runs: its status (pending, processing, succeeded or failed), its outputs with a permanent magicbooklet.com link and a signed media URL (good for about an hour), what it cost, and why it failed when it did (a failed run\'s credits come back).',
    `Pass wait_seconds (0 to ${MCP_GENERATION_WAIT_MAX_SECONDS}) to wait for a running generation before answering, and call again while settled is false.`,
    'Images finish within a minute; videos take a few minutes. Give the person the permanent link; the signed URL expires.',
  ].join(' '),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({
    generation_id: GENERATION_ID,
    wait_seconds: z.int().min(0).max(MCP_GENERATION_WAIT_MAX_SECONDS).optional()
      .describe(`How long to wait for the run to finish before answering, at most ${MCP_GENERATION_WAIT_MAX_SECONDS}.`),
  }),
  async handle({ generation_id: generationId, wait_seconds: waitSeconds = 0 }, context) {
    const { services } = context;
    const limited = await refuseReadOverLimit(context);
    if (limited) return limited;

    const notFound = () => toolFailure(
      MCP_ERROR_CODES.NOT_FOUND,
      `No creation ${generationId} belongs to this creator. list_creations lists theirs.`,
      { generation_id: generationId },
    );
    const deadline = services.now() + waitSeconds * 1000;
    let status = await readGenerations(context, { id: generationId, detail: 'status', includeArchived: 'true' });
    if (status.generations.length === 0) return notFound();
    while (!isSettled(stringOrNull(status.generations[0].status))) {
      const remaining = deadline - services.now();
      if (remaining <= 0) break;
      await services.sleep(Math.min(MCP_GENERATION_POLL_INTERVAL_MS, remaining));
      status = await readGenerations(context, { id: generationId, detail: 'status', includeArchived: 'true' });
      if (status.generations.length === 0) return notFound();
    }

    const full = await readGenerations(context, { id: generationId, includeArchived: 'true' });
    const item = full.generations[0];
    if (!item) return notFound();
    const summary = summarize(item, context);
    const outputs = isSettled(summary.status as string | null) && summary.status === 'succeeded' ? outputsOf(item) : [];
    const failureReason = stringOrNull(item.error_message);
    const text = summary.status === 'succeeded'
      ? `Run ${generationId} succeeded (${summary.kind ?? 'media'} on ${summary.model_id ?? 'its model'}, ${summary.cost_credits === null ? 'cost unknown' : credits(summary.cost_credits as number)}). ${outputs.length} output${outputs.length === 1 ? '' : 's'}; permanent link ${summary.creation_url}. The signed media URL expires; give the person the permanent link.`
      : summary.status === 'failed'
        ? `Run ${generationId} failed${failureReason ? `: ${failureReason}` : ''}. ${summary.refunded ? 'Its credits were refunded.' : 'Its credits are refunded when the failure settles.'}`
        : `Run ${generationId} is still ${summary.status ?? 'running'} after ${waitSeconds} seconds. Call get_generation again with wait_seconds ${MCP_GENERATION_WAIT_MAX_SECONDS}.`;
    return toolSuccess(text, {
      ...summary,
      prompt: typeof item.prompt === 'string' ? item.prompt : null,
      failure_reason: failureReason,
      outputs,
    });
  },
});

const listCreationsTool = defineTool({
  name: 'list_creations',
  title: 'List creations',
  description: [
    'List the creator\'s creations, newest first: status, model, a short prompt, cost, a preview URL, the permanent link, and posted (whether it has been published as a post).',
    `Page with limit (at most ${MCP_LIST_PAGE_MAX}) and next_cursor.`,
    'Use it to find a creation to show the person, or to check what they have already made before creating again.',
  ].join(' '),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({
    limit: z.int().min(1).max(MCP_LIST_PAGE_MAX).optional().describe(`Creations per page, at most ${MCP_LIST_PAGE_MAX} (default 20).`),
    cursor: z.string().max(64).optional().describe('next_cursor from the previous page.'),
    include_archived: z.boolean().optional().describe('Also list creations the creator archived.'),
  }),
  async handle({ limit = 20, cursor, include_archived: includeArchived = false }, context) {
    const limited = await refuseReadOverLimit(context);
    if (limited) return limited;
    const page = await readGenerations(context, {
      detail: 'summary',
      limit: String(limit),
      ...(cursor ? { cursor } : {}),
      ...(includeArchived ? { includeArchived: 'true' } : {}),
    });
    const creations = page.generations.map((item) => summarize(item, context));
    return toolSuccess(
      [
        `${creations.length} creation${creations.length === 1 ? '' : 's'}${page.nextCursor ? ', more follow (call again with next_cursor)' : ''}.`,
        ...creations.map((creation) => (
          `- ${creation.generation_id}: ${creation.status}${creation.kind ? `, ${creation.kind}` : ''}${creation.model_id ? ` on ${creation.model_id}` : ''}${creation.posted ? ', posted' : ''}${creation.prompt_excerpt ? ` — ${creation.prompt_excerpt}` : ''}`
        )),
      ].join('\n'),
      { creations, next_cursor: page.nextCursor },
    );
  },
});

// ---------------------------------------------------------------------------------------------
// enhance_prompt

const enhancePromptTool = defineTool({
  name: 'enhance_prompt',
  title: 'Enhance a prompt',
  description: [
    'Rewrite a prompt in the idiom of the model it is for: subject, camera, light and motion made specific, and the provider\'s limits kept.',
    'Returns enhanced_prompt with quality warnings. It spends a small number of the creator\'s credits per call (cost_credits in the answer).',
    'Call it when the person\'s prompt is short or vague, show them the result, and create with it only once they agree.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: z.object({
    prompt: z.string().min(1).max(5_000),
    medium: z.enum(['image', 'video', 'motion', 'audio']).describe('What the prompt will make.'),
    model_id: z.string().min(1).max(200).describe('The model_id the prompt is for, from list_models.'),
    context: z.record(z.string(), z.unknown()).optional().describe('Optional hints the creators send: aspectRatio, duration, resolution, googleSearch, frameImageUrls.'),
  }),
  async handle({ prompt, medium, model_id: modelId, context: hints }, context) {
    const { services } = context;
    const result = await services.enhancePromptForUser({
      body: {
        prompt,
        medium,
        selectedModel: modelId,
        ...(hints ? { context: hints } : {}),
        idempotencyKey: randomUUID(),
      },
      userId: context.userId,
      request: context.request,
      client: context.createAdminSupabase,
    });
    const cost = services.promptEnhancementCost();
    if (!result.ok) {
      if (result.code === 'RATE_LIMITED') return rateLimited(result.retryAfterSeconds);
      if (result.status === 402) {
        const balance = result.remainingCredits
          ?? await services.readCreditBalance(context.createAdminSupabase(), context.userId);
        return insufficientCredits(balance, result.required ?? cost, 'enhancing a prompt');
      }
      if (result.status === 400) {
        return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, `${result.error}. Use a model_id from list_models.`);
      }
      if (result.status >= 500) return toolFailure(MCP_ERROR_CODES.UNAVAILABLE, result.error);
      return toolFailure(result.code ?? MCP_ERROR_CODES.UNAVAILABLE, result.error);
    }
    const response = result.response;
    const enhanced = stringOrNull(response.enhancedPrompt) ?? prompt;
    const warnings = Array.isArray(response.warnings) ? response.warnings : [];
    return toolSuccess(
      [
        `Enhanced prompt for ${modelId} (${credits(cost)} spent${typeof response.remainingCredits === 'number' ? `, ${credits(response.remainingCredits)} left` : ''}):`,
        enhanced,
        warnings.length ? `Warnings: ${warnings.map(String).join('; ')}` : '',
        'Show it to the person; create with it once they agree.',
      ].filter(Boolean).join('\n'),
      {
        enhanced_prompt: enhanced,
        original_prompt: prompt,
        model_id: modelId,
        medium,
        cost_credits: cost,
        balance_credits: numberOrNull(response.remainingCredits),
        quality_score: numberOrNull(response.qualityScore),
        warnings,
        applied_safeguards: Array.isArray(response.appliedSafeguards) ? response.appliedSafeguards : [],
      },
    );
  },
});

// ---------------------------------------------------------------------------------------------
// The registry

export const MCP_TOOLS: ReadonlyArray<McpToolDefinition> = [
  listModelsTool,
  getModelTool,
  quoteGenerationTool,
  createMediaTool,
  getGenerationTool,
  listCreationsTool,
  enhancePromptTool,
];

export const MCP_SERVER_INSTRUCTIONS = [
  'Magicbooklet makes AI images, videos and motion clips with the signed-in creator\'s credits, and publishes them to the creator\'s profile.',
  'Flow for a creation: list_models → get_model → quote_generation → tell the person the price → create_media with expected_cost_credits → get_generation with wait_seconds until settled.',
  'Every run spends the creator\'s credits; a failed run refunds them. Never promise a result before get_generation says succeeded.',
].join(' ');

/** Runs one tool call: the handler, then one record of it for the adapter's log, whatever happened. */
export async function runMcpTool(
  tool: McpToolDefinition,
  args: unknown,
  context: McpToolContext,
): Promise<CallToolResult> {
  const started = context.services.now();
  const report = (record: Omit<McpToolCallRecord, 'tool' | 'elapsedMs'>) => {
    context.onToolCall?.({ tool: tool.name, elapsedMs: context.services.now() - started, ...record });
  };
  try {
    const result = await tool.handle(args as never, context);
    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    const error = isRecord(structured.error) ? structured.error : null;
    report({
      outcome: result.isError ? 'error' : 'ok',
      code: typeof error?.code === 'string' ? error.code : null,
      costCredits: numberOrNull(structured.cost_credits),
    });
    return result;
  } catch (error) {
    report({ outcome: 'threw', code: 'INTERNAL_ERROR', costCredits: null, error });
    return toolFailure(
      'INTERNAL_ERROR',
      'The tool failed unexpectedly. Nothing is known to have been charged; try again, and if the run may have started, check list_creations first.',
    );
  }
}

export function registerMcpTools(server: McpServer, context: McpToolContext): void {
  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args) => runMcpTool(tool, args, context),
    );
  }
}

/** A server for one admitted request: the registry bound to that request's creator and client. */
export function createMcpServer(context: McpToolContext): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      title: 'Magicbooklet',
      websiteUrl: context.siteOrigin,
      description: 'Create AI media with your Magicbooklet credits and publish it to your profile.',
    },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  registerMcpTools(server, context);
  return server;
}
