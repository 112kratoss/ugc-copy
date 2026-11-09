import { randomUUID } from 'node:crypto';

import { McpServer, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { isOwnOrLinkedAccountId } from '@/lib/account-identity';
import {
  AGENT_BASE64_MAX_BYTES,
  AGENT_BASE64_MAX_CHARACTERS,
  AGENT_OPEN_UPLOADS_MAX,
  AGENT_URL_FETCH_MAX_BYTES_BY_KIND,
  agentUploadCurlCommand,
  readAgentStagedUploads,
  requestAgentUpload,
  stageAgentInput,
  type AgentStagedUpload,
} from '@/lib/agent-input-upload';
import { agentPostState, readPostForAgent, type AgentPostState, type AgentPostView } from '@/lib/agent-post-read';
import { buildAgentPublishRequest } from '@/lib/agent-publish-request';
import {
  agentUploadPostId,
  buildAgentUploadPublishFormData,
  refuseAgentMadeWith,
} from '@/lib/agent-upload-publish-request';
import {
  AGENT_PUBLISH_RECORD_CODES,
  countAgentPublicPublishesSince,
  nextUtcMidnight,
  startOfUtcDay,
  uuidOrNull,
} from '@/lib/agent-tool-calls';
import { logBackendError } from '@/lib/backend-logger';
import {
  AGENT_PUBLISH_RATE_LIMIT,
  AGENT_UPLOAD_INPUT_RATE_LIMIT,
  BackendRateLimitError,
  OWNER_GENERATIONS_READ_RATE_LIMIT,
  SHOWCASE_PUBLISH_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import { getCreationPostTitleSuggestion } from '@/lib/creation-post-title';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import { createGenerationModelQuote } from '@/lib/generation-model-quote-service';
import { fetchImageContentBlock } from '@/lib/mcp-preview-image';
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
import { createOwnerPostForRoute } from '@/lib/post-create-route-service';
import { deleteOwnerPostForRoute } from '@/lib/post-delete-service';
import { DESCRIPTION_MAX_LENGTH } from '@/lib/post-description-limit';
import { TITLE_MAX_LENGTH } from '@/lib/post-limits';
import { MAX_POST_MEDIA_ITEMS } from '@/lib/post-media';
import { updateOwnerPostForRoute } from '@/lib/post-update-service';
import { BODY_MAX_LENGTH } from '@/lib/posts-server';
import { enhancePromptForUser } from '@/lib/prompt-enhancement-service';
import { getPromptEnhancementCost } from '@/lib/prompt-enhancer';
import { publishGenerationToShowcaseForRoute } from '@/lib/showcase-publish-service';
import { postUnifiedGenerationForRoute } from '@/lib/unified-generation-route-service';
import {
  buildUnifiedGenerationQuoteInput,
  parseUnifiedGenerationRequest,
} from '@/lib/unified-generation-start-service';

/**
 * The MCP server's tool registry: what an agent acting as a signed-in creator can do, and the
 * handler behind each tool (`docs/plans/agent-mcp-server-plan-2026-11-09.md`; phase 1 the
 * create-media job, phase 2 the publish job and uploads, phase 4 posts of media made elsewhere).
 *
 * The tools are a thin layer over the services the web and the app already call. Nothing here
 * prices a run, reads the catalog on its own or touches credits: the quote service prices, the
 * unified start charges (and refuses a run above the price the agent confirmed), the owner
 * library read answers what a run became, the publish service makes the post the web would make
 * from a creation and the composer service the one it would make from uploaded files,
 * and every rate limit is the creator's own, keyed on the creator as the web's routes key it.
 * What this layer adds is the agent's view of those answers: snake_case fields, a sentence of
 * text beside the data, stable error codes, and in every description the next call to make.
 *
 * A short balance is answered with the balance and the shortfall and never a purchase link
 * (ChatGPT's directory forbids selling credits in-app; the Anthropic and ChatGPT paths stay
 * equal). Prompts are the creator's own and travel in results, never into logs.
 */

export const MCP_SERVER_NAME = 'magicbooklet';
export const MCP_SERVER_VERSION = '1.2.0';

/**
 * The time get_generation may spend waiting for a run, within the route's 60-second budget. The
 * descriptions suggest the shorter wait: a cold start, the admission round trips, the wait and the
 * final read must all fit under the route's 60 seconds and the MCP client's own 60-second request
 * timeout, so 45 leaves little room on a slow day.
 */
export const MCP_GENERATION_WAIT_MAX_SECONDS = 45;
export const MCP_GENERATION_WAIT_SUGGESTED_SECONDS = 30;
export const MCP_GENERATION_POLL_INTERVAL_MS = 3_000;
export const MCP_LIST_PAGE_MAX = 50;

/** How upload_input's answer names the file it staged, each kind with its own article. */
const STAGED_KIND_NOUN: Record<'image' | 'video' | 'audio', string> = {
  image: 'an image',
  video: 'a video',
  audio: 'an audio file',
};

const CATALOG_PLATFORM = 'web' as const;

export type McpToolName =
  | 'list_models'
  | 'get_model'
  | 'quote_generation'
  | 'upload_input'
  | 'request_upload'
  | 'create_media'
  | 'get_generation'
  | 'list_creations'
  | 'publish_post'
  | 'get_post'
  | 'delete_post'
  | 'enhance_prompt';

export type McpToolCallRecord = {
  tool: McpToolName;
  outcome: 'ok' | 'error' | 'threw';
  code: string | null;
  costCredits: number | null;
  /** The creation the call was about, from its answer or its arguments; for the audit row. */
  generationId: string | null;
  /** The post the call was about, from its answer or its arguments; for the audit row. */
  postId: string | null;
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
  publishGenerationToShowcaseForRoute: typeof publishGenerationToShowcaseForRoute;
  /** The composer's own create: the post the web makes from uploaded files. */
  createOwnerPostForRoute: typeof createOwnerPostForRoute;
  /** The composer's own save: how a post without a creation changes its visibility. */
  updateOwnerPostForRoute: typeof updateOwnerPostForRoute;
  deleteOwnerPostForRoute: typeof deleteOwnerPostForRoute;
  readPostForAgent: typeof readPostForAgent;
  stageAgentInput: typeof stageAgentInput;
  /** Signs an upload for a file on the agent's own machine. */
  requestAgentUpload: typeof requestAgentUpload;
  /** The caller's staged uploads behind the paths a publish names. */
  readAgentStagedUploads: typeof readAgentStagedUploads;
  /** The preview of a finished picture as an inline image block, or null when it is not to be had. */
  fetchImageContentBlock: typeof fetchImageContentBlock;
  enforceBackendRateLimit: typeof enforceBackendRateLimit;
  /** The creator's total spendable balance (`profiles.credits`). */
  readCreditBalance: (admin: SupabaseClient, userId: string) => Promise<number>;
  /** The creation a publish is asked for, as the publish service will judge it; null for none. */
  readCreationForPublish: (admin: SupabaseClient, params: { generationId: string; userId: string }) => Promise<CreationForPublish | null>;
  /** The day's public publications by agents for the account: the daily cap's count. */
  countAgentPublicPublishesSince: typeof countAgentPublicPublishesSince;
  /** Whether a creation's owner is the caller or an identity linked to the caller (a guest's run). */
  isOwnOrLinkedAccountId: typeof isOwnOrLinkedAccountId;
  promptEnhancementCost: () => number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type CreationForPublish = {
  id: string;
  userId: string;
  status: string;
  prompt: string | null;
  title: string | null;
  model: string | null;
  category: string | null;
  creationMode: string | null;
  /** Set where the creator archived the creation: nothing of it is published by an agent. */
  archivedAt: string | null;
  /** Set where an operator removed the creation: it does not exist for an agent. */
  moderationRemovedAt: string | null;
  /** The post this creation already has, where it has one, with its state as the post page reads it. */
  post: { id: string; visibility: 'public' | 'private'; state: AgentPostState } | null;
};

export async function readCreationForPublish(
  admin: SupabaseClient,
  { generationId, userId }: { generationId: string; userId: string },
): Promise<CreationForPublish | null> {
  // The service client reads both: the authenticated Data API has no SELECT on `generations`
  // (`showcase-publish-service.ts` says why), and the post is the caller's own, filed under the
  // account as the publish service files it, whichever linked identity made the creation.
  const [generation, post] = await Promise.all([
    admin
      .from('generations')
      .select('id, user_id, status, prompt, title, model, category, creation_mode, archived_at, moderation_removed_at')
      .eq('id', generationId)
      .maybeSingle(),
    admin
      .from('posts')
      .select('id, visibility, review_status, archived_at, tombstoned_at')
      .eq('generation_id', generationId)
      .eq('user_id', userId)
      .maybeSingle(),
  ]);
  if (generation.error) throw generation.error;
  if (post.error) throw post.error;
  const row = generation.data as {
    id: string; user_id: string; status: string; prompt: string | null; title: string | null; model: string | null;
    category: string | null; creation_mode: string | null; archived_at: string | null; moderation_removed_at: string | null;
  } | null;
  if (!row) return null;
  const existing = post.data as {
    id: string; visibility: string | null; review_status: string | null; archived_at: string | null; tombstoned_at: string | null;
  } | null;
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    prompt: row.prompt,
    title: row.title,
    model: row.model,
    category: row.category,
    creationMode: row.creation_mode,
    archivedAt: row.archived_at,
    moderationRemovedAt: row.moderation_removed_at,
    post: existing
      ? { id: existing.id, visibility: existing.visibility === 'public' ? 'public' : 'private', state: agentPostState(existing) }
      : null,
  };
}

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
  /** Told once per tool call, whatever the outcome; the adapter logs it and writes the audit row. */
  onToolCall?: (record: McpToolCallRecord) => void;
  /** Where work that need not hold the answer goes (Next's `after`), when the route has one. */
  runAfterResponse?: RunAfterResponse;
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
    publishGenerationToShowcaseForRoute,
    createOwnerPostForRoute,
    updateOwnerPostForRoute,
    deleteOwnerPostForRoute,
    readPostForAgent,
    stageAgentInput,
    requestAgentUpload,
    readAgentStagedUploads,
    fetchImageContentBlock,
    enforceBackendRateLimit,
    readCreditBalance,
    readCreationForPublish,
    countAgentPublicPublishesSince,
    isOwnOrLinkedAccountId,
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
  /**
   * What a successful answer records in the audit row beyond the defaults (`runMcpTool`): a
   * `code` naming which answer it was, and the post it names, where the tool distinguishes an
   * answer that made or changed a post from one that only described it.
   */
  audit?(structured: Record<string, unknown>): { code?: string | null; postId?: string | null };
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
const POST_ID = z.uuid().describe('The post_id publish_post, get_post or list_creations gave.');

function creationUrl(siteOrigin: string, generationId: string): string {
  return `${siteOrigin}/creations?generation=${encodeURIComponent(generationId)}`;
}

/** The post's page, `/showcase/<id>` (`src/app/showcase/[id]`; `/post/<id>` is only the editor's folder). */
function postUrl(siteOrigin: string, postId: string): string {
  return `${siteOrigin}/showcase/${encodeURIComponent(postId)}`;
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
  // A database or configuration failure, not the caller's: the operator needs the cause, which the
  // tool answer (UNAVAILABLE) and the call's log line do not carry.
  logBackendError('mcp_catalog_read_failed', { error });
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
  url: z.url().optional().describe('The media\'s URL as Magicbooklet gave it: the input.url upload_input answered for a file you staged, or an output URL from get_generation or list_creations (one of the creator\'s own creations). Any other web URL is refused: stage outside media with upload_input first.'),
  storage_path: z.string().min(1).max(512).optional().describe('The input.storage_path upload_input answered beside the URL; send both for a staged file.'),
  asset_id: z.string().min(1).max(200).optional().describe('A Magicbooklet asset id (a saved input of the creator\'s, or a prepared Seedance asset) in place of a URL.'),
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
    'idempotency_key is required: mint a UUID per run, and reuse the same key on any retry of that run (after a timeout or a dropped connection the run may have started), which returns the run instead of charging again.',
    'Inputs are the creator\'s own: a file staged with upload_input (its url and storage_path), an output URL from get_generation or list_creations, or an asset_id; any other web URL is refused.',
    'A staged file feeds a run here (inputs[]) or becomes a post as it is (publish_post.uploads[]); the run\'s own output is published with publish_post and its generation_id.',
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
    idempotency_key: z.string().min(1).max(256).describe('Your own key for this run, a UUID you mint. A repeat with the same key returns the run started under it instead of starting another, so a retry after a timeout or a dropped connection must reuse it.'),
  }),
  async handle(args, context) {
    const { services } = context;
    // The schema requires the key; this holds for a caller that reached the handler another way.
    // Without a key every retry would be a new run and a new charge.
    const idempotencyKey = typeof args.idempotency_key === 'string' ? args.idempotency_key.trim() : '';
    if (!idempotencyKey) {
      return toolFailure(
        MCP_ERROR_CODES.INVALID_REQUEST,
        'idempotency_key is required: mint a UUID for this run and send the same one on any retry of it.',
        { field_errors: { idempotency_key: 'Required.' } },
      );
    }
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
        storagePath: input.storage_path,
        assetId: input.asset_id,
        durationSeconds: input.duration_seconds ?? null,
        label: input.label,
        handle: input.handle,
        sourceGenerationId: input.source_generation_id,
      })),
      sourceGenerationId: args.source_generation_id,
      expectedCostCredits: args.expected_cost_credits,
      idempotencyKey,
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
            ? `It is processing. Call get_generation with generation_id ${generationId} and wait_seconds ${MCP_GENERATION_WAIT_SUGGESTED_SECONDS} until its status is succeeded or failed.`
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
    `Pass wait_seconds to wait for a running generation before answering (${MCP_GENERATION_WAIT_SUGGESTED_SECONDS} is the suggested wait; ${MCP_GENERATION_WAIT_MAX_SECONDS} is the most, and only for a client whose request timeout is well over a minute), and call again while settled is false.`,
    'Images finish within a minute; videos take a few minutes. Give the person the permanent link; the signed URL expires.',
    'Pass include_preview true on the call that reads a finished picture to get it inline as an image block (its preview, under half a megabyte); leave it out while polling, so answers stay small.',
  ].join(' '),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({
    generation_id: GENERATION_ID,
    wait_seconds: z.int().min(0).max(MCP_GENERATION_WAIT_MAX_SECONDS).optional()
      .describe(`How long to wait for the run to finish before answering: ${MCP_GENERATION_WAIT_SUGGESTED_SECONDS} suggested, ${MCP_GENERATION_WAIT_MAX_SECONDS} at most.`),
    include_preview: z.boolean().optional()
      .describe('True to receive a finished picture inline as an image block (its preview, under half a megabyte). Default false: leave it out while polling.'),
  }),
  async handle({ generation_id: generationId, wait_seconds: waitSeconds = 0, include_preview: includePreview = false }, context) {
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
      ? `Run ${generationId} succeeded (${summary.kind ?? 'media'} on ${summary.model_id ?? 'its model'}, ${summary.cost_credits === null ? 'cost unknown' : credits(summary.cost_credits as number)}). ${outputs.length} output${outputs.length === 1 ? '' : 's'}; permanent link ${summary.creation_url}. The signed media URL expires; give the person the permanent link.${summary.posted ? '' : ' To post it, call publish_post with this generation_id and a title.'}`
      : summary.status === 'failed'
        ? `Run ${generationId} failed${failureReason ? `: ${failureReason}` : ''}. ${summary.refunded ? 'Its credits were refunded.' : 'Its credits are refunded when the failure settles.'}`
        : `Run ${generationId} is still ${summary.status ?? 'running'} after ${waitSeconds} seconds. Call get_generation again with wait_seconds ${MCP_GENERATION_WAIT_SUGGESTED_SECONDS}.`;
    const result = toolSuccess(text, {
      ...summary,
      prompt: typeof item.prompt === 'string' ? item.prompt : null,
      failure_reason: failureReason,
      outputs,
    });
    // A finished picture travels inline too, from its preview, for the clients that draw an image
    // block, when the caller asked (a poll stays small); a preview that is missing, too large or
    // slow leaves the answer as it is (`mcp-preview-image.ts`).
    const previewUrl = includePreview && summary.status === 'succeeded' && summary.kind === 'image'
      ? stringOrNull(outputs[0]?.preview_url)
      : null;
    if (previewUrl) {
      const image = await services.fetchImageContentBlock(previewUrl);
      if (image) result.content = [...result.content, image];
    }
    return result;
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
    // The cost is a constant of the service, so the agent reads it here before the call: there is
    // no quote step for an enhancement.
    `Returns enhanced_prompt with quality warnings. Each call spends a fixed ${credits(getPromptEnhancementCost())} of the creator's, with no quote step, so tell the person before calling it repeatedly.`,
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
// upload_input

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Counted before any byte is fetched or any upload signed, so a loop of large or failing files is stopped here. */
async function refuseUploadOverLimit(context: McpToolContext): Promise<CallToolResult | null> {
  try {
    await context.services.enforceBackendRateLimit(context.createAdminSupabase(), { ...AGENT_UPLOAD_INPUT_RATE_LIMIT, key: context.userId });
    return null;
  } catch (error) {
    if (error instanceof BackendRateLimitError) return rateLimited(error.retryAfterSeconds);
    throw error;
  }
}

const uploadInputTool = defineTool({
  name: 'upload_input',
  title: 'Stage a file',
  description: [
    'Stage a picture, clip or track of the person\'s own, and get back what create_media takes for it as an input and publish_post as an upload.',
    `Give exactly one source. url: a public https URL this server fetches (at most ${megabytes(AGENT_URL_FETCH_MAX_BYTES_BY_KIND.image)} for a picture, ${megabytes(AGENT_URL_FETCH_MAX_BYTES_BY_KIND.video)} for a clip, ${megabytes(AGENT_URL_FETCH_MAX_BYTES_BY_KIND.audio)} for a track; one redirect on the same host is followed). base64 with mime_type (at most ${megabytes(AGENT_BASE64_MAX_BYTES)} decoded; send a larger file by url). upload_id: a file on your own machine that you sent to the upload_url request_upload gave, once that upload has finished.`,
    'The answer\'s input (url and storage_path) feeds a run in create_media.inputs[], with the slot and kind get_model names, or becomes a post as it is: its storage_path goes into publish_post.uploads[] (a picture or a clip; a track is for a run only). The staged file is kept about two hours and the signed URL about an hour, so stage right before you create or publish.',
    'Only public hosts are fetched (PRIVATE_ADDRESS otherwise), and only the picture, clip and track types Magicbooklet takes, checked against the file\'s own bytes (UNSUPPORTED_MEDIA). The creator\'s own outputs need no staging: pass their URL from get_generation or list_creations.',
    'With upload_id, NOT_READY means nothing is stored yet (send the file, then call again), and UPLOAD_BYTES_LIMIT, from any source, that the creator\'s open uploads hold all the staging space an account has.',
  ].join(' '),
  // Open world: by URL it reaches hosts outside Magicbooklet.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object({
    url: z.url().optional().describe('A public https URL of the file. Give exactly one of url, base64 or upload_id.'),
    base64: z.string().min(4).max(AGENT_BASE64_MAX_CHARACTERS).optional().describe(`The file\'s bytes in standard base64 (a data: URL is accepted), at most ${megabytes(AGENT_BASE64_MAX_BYTES)} decoded.`),
    mime_type: z.string().min(3).max(100).optional().describe('The file\'s own type, required with base64 (image/jpeg, image/png, video/mp4, audio/mpeg, …).'),
    upload_id: z.uuid().optional().describe('The upload_id request_upload gave, after the file was PUT to its upload_url. The file is checked against the size and type request_upload was told.'),
  }),
  async handle({ url, base64, mime_type: mimeType, upload_id: uploadId }, context) {
    const sources = [url, base64, uploadId].filter((source) => source !== undefined).length;
    if (sources !== 1) {
      return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, 'Give exactly one of url, base64 or upload_id.', {
        field_errors: { url: 'Give url, base64 or upload_id: one of them, and only one.' },
      });
    }
    if (base64 !== undefined && !mimeType) {
      return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, 'mime_type is required with base64: the file\'s own type.', {
        field_errors: { mime_type: 'Required with base64.' },
      });
    }
    const limited = await refuseUploadOverLimit(context);
    if (limited) return limited;
    const staged = await context.services.stageAgentInput({
      admin: context.createAdminSupabase(),
      userId: context.userId,
      source: url !== undefined
        ? { url }
        : base64 !== undefined
          ? { base64, mimeType: mimeType as string }
          : { uploadId: uploadId as string },
    });
    if (!staged.ok) {
      if (staged.code === 'RATE_LIMITED') return rateLimited(staged.retryAfterSeconds);
      if (staged.code === 'UPLOAD_FAILED') {
        return toolFailure(MCP_ERROR_CODES.UNAVAILABLE, `${staged.message} Try again in a moment.`, staged.details ?? {});
      }
      const next = staged.code === 'TOO_LARGE' && base64 !== undefined
        ? ' Send the file by url instead.'
        : staged.code === 'PRIVATE_ADDRESS' || staged.code === 'UNRESOLVABLE_HOST'
          ? ' Give a URL on a public host, or send the bytes as base64.'
          : '';
      return toolFailure(staged.code, `${staged.message}${next}`, staged.details ?? {});
    }
    return toolSuccess(
      [
        `Staged ${STAGED_KIND_NOUN[staged.kind]} of ${staged.bytes} bytes (${staged.mimeType}).`,
        'For a run: in create_media.inputs[], send this input\'s url and storage_path with the slot and kind get_model names for it.',
        staged.kind === 'audio'
          ? 'A track feeds a run only; a post takes pictures and clips.'
          : 'For a post of the file as it is: put its storage_path in publish_post.uploads[], with a title and made_with.',
        `The staged file is kept about two hours; its URL lasts ${Math.round(staged.expiresInSeconds / 60)} minutes.`,
      ].join(' '),
      {
        input: { url: staged.input.url, storage_path: staged.input.storagePath },
        kind: staged.kind,
        bytes: staged.bytes,
        mime_type: staged.mimeType,
        expires_in_seconds: staged.expiresInSeconds,
        source_url: staged.sourceUrl,
      },
    );
  },
});

// ---------------------------------------------------------------------------------------------
// request_upload

const requestUploadTool = defineTool({
  name: 'request_upload',
  title: 'Request an upload for a local file',
  description: [
    'Get a signed URL to send a file from your own machine to Magicbooklet\'s staging, for an agent that can run a command (Claude Code, Codex, Cursor). An agent with no shell stages by link instead: upload_input with url.',
    `Tell it the file's name, its own type (mime_type) and its exact size in bytes (size_bytes): at most ${megabytes(AGENT_URL_FETCH_MAX_BYTES_BY_KIND.image)} for a picture, ${megabytes(AGENT_URL_FETCH_MAX_BYTES_BY_KIND.video)} for a clip, ${megabytes(AGENT_URL_FETCH_MAX_BYTES_BY_KIND.audio)} for a track.`,
    'The answer gives upload_url, the headers to send and the one curl command that does it (PUT the raw bytes; any HTTP client that sends the same method, headers and body works). Run it with the file\'s path, wait for it to finish, then call upload_input with the upload_id: that checks the stored file against the size and type given here and its own bytes, and answers the input create_media and publish_post take.',
    'Nothing is staged until upload_input says so, and a file whose size or type differs from what was declared is removed. The URL lasts about two hours; tell the person which file you are sending before you send it.',
    `Send and stage one file at a time (request_upload, the command, upload_input, then the next file): a creator can have at most ${AGENT_OPEN_UPLOADS_MAX} uploads open at once, and one that was refused or never finished keeps its place for up to a day (UPLOAD_BYTES_LIMIT says so).`,
  ].join(' '),
  // It reserves an upload and reaches nothing outside Magicbooklet: the agent's own PUT does the sending.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: z.object({
    file_name: z.string().trim().min(1).max(200).describe('The file\'s name with its extension (photo.png, clip.mp4). The upload is filed under a cleaned form of it.'),
    mime_type: z.string().trim().min(3).max(100).describe('The file\'s own type: image/jpeg, image/png, image/webp, image/gif, video/mp4, video/quicktime, video/webm, audio/mpeg, audio/wav, …'),
    size_bytes: z.int().min(1).describe('The file\'s exact size in bytes (wc -c < FILE). The stored file must be exactly this size.'),
  }),
  async handle({ file_name: fileName, mime_type: mimeType, size_bytes: sizeBytes }, context) {
    const limited = await refuseUploadOverLimit(context);
    if (limited) return limited;
    const upload = await context.services.requestAgentUpload({
      admin: context.createAdminSupabase(),
      userId: context.userId,
      request: { fileName, mimeType, sizeBytes },
    });
    if (!upload.ok) {
      if (upload.code === 'RATE_LIMITED') return rateLimited(upload.retryAfterSeconds);
      if (upload.code === 'UPLOAD_FAILED') {
        return toolFailure(MCP_ERROR_CODES.UNAVAILABLE, `${upload.message} Try again in a moment.`, upload.details ?? {});
      }
      return toolFailure(upload.code, upload.message, upload.details ?? {});
    }
    const curl = agentUploadCurlCommand(upload);
    return toolSuccess(
      [
        `Upload ${upload.uploadId} is ready for ${STAGED_KIND_NOUN[upload.kind]} of exactly ${upload.sizeBytes} bytes (${upload.mimeType}). Send the file with this command, FILE replaced by its path (in double quotes if the path holds a space):`,
        curl,
        `then call upload_input with this upload_id (${upload.uploadId}). The command prints {"Key": ...} once the file is stored; any other answer is a refusal, and nothing was stored. The URL lasts ${Math.round(upload.expiresInSeconds / 60)} minutes and takes the file once.`,
      ].join('\n'),
      {
        upload_id: upload.uploadId,
        upload_url: upload.uploadUrl,
        method: 'PUT',
        headers: upload.headers,
        curl,
        storage_path: upload.storagePath,
        kind: upload.kind,
        mime_type: upload.mimeType,
        size_bytes: upload.sizeBytes,
        expires_in_seconds: upload.expiresInSeconds,
        max_bytes: upload.maxBytes,
      },
    );
  },
});

// ---------------------------------------------------------------------------------------------
// publish_post, get_post and delete_post

const PUBLISH_VISIBILITY = z.enum(['public', 'private']);

function postView(post: AgentPostView, context: McpToolContext): Record<string, unknown> {
  return {
    post_id: post.postId,
    post_url: postUrl(context.siteOrigin, post.postId),
    generation_id: post.generationId,
    title: post.title,
    description: post.description,
    body: post.body,
    category: post.category,
    visibility: post.visibility,
    state: post.state,
    is_nsfw: post.isNsfw,
    allow_remixes: post.remixesAllowed,
    counts: post.counts,
    created_at: post.createdAt,
    is_own: post.isOwn,
  };
}

function describeState(post: AgentPostView): string {
  switch (post.state) {
    case 'live': return 'live: public, on the creator\'s profile and in the showcase';
    case 'private': return 'private: on the creator\'s profile, visible to them alone';
    case 'archived': return 'archived by the creator, off every public surface';
    case 'hidden': return 'hidden by moderation';
    case 'removed': return 'removed, kept only for the people who unlocked its recipe';
  }
}

/** The publish service's refusals, as stable codes with the next step. */
function publishRefusal(result: { status: number; body: { error: string; field?: string; code?: string } }): CallToolResult {
  const { status, body } = result;
  // Another creator's creation and a missing one answer alike: what exists under an id that is
  // not the caller's is not the caller's to learn (the service's own rule for template results).
  if (status === 403 || status === 404) {
    return toolFailure(MCP_ERROR_CODES.NOT_FOUND, 'No such creation of this creator\'s. list_creations lists theirs.');
  }
  if (status === 400 && /has not succeeded|no media to publish/iu.test(body.error)) {
    return toolFailure(MCP_ERROR_CODES.NOT_READY, `${body.error}. Wait for get_generation to say succeeded, then publish.`);
  }
  if (body.code === 'CREATION_RECIPE_REQUIRED') {
    return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, `${body.error} Publish with allow_remixes false to post the media alone.`, {
      field_errors: { allow_remixes: body.error },
    });
  }
  if (status === 409) {
    return toolFailure('CONFLICT', `${body.error} Edit the post on the website instead.`, { publish_code: body.code ?? null });
  }
  if (status === 400) {
    return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, body.error, body.field ? { field_errors: { [body.field]: body.error } } : {});
  }
  return toolFailure(MCP_ERROR_CODES.UNAVAILABLE, `${body.error} Try again in a moment.`);
}

/**
 * The two limits a publish passes, in order: the web's publish limit, which counts attempts as
 * the route does, and the agent's daily cap on public posts, which counts only publications. The
 * cap is read from the audit ledger (`countAgentPublicPublishesSince`: today's rows recorded
 * PUBLISHED_PUBLIC), never from the attempt-counting limiter, so a publish the service refuses
 * spends nothing of it. The row is written behind the answer, so two publishes a moment apart
 * may both pass; the cap is a guard against a loop, not an exact quota, and the runbook says so.
 */
async function refusePublishOverLimit(context: McpToolContext, makesPublic: boolean): Promise<CallToolResult | null> {
  const admin = context.createAdminSupabase();
  try {
    await context.services.enforceBackendRateLimit(admin, { ...SHOWCASE_PUBLISH_RATE_LIMIT, key: context.userId });
  } catch (error) {
    if (!(error instanceof BackendRateLimitError)) throw error;
    return toolFailure(
      MCP_ERROR_CODES.RATE_LIMITED,
      `The creator's publish limit is spent for now. Wait ${error.retryAfterSeconds} seconds, then try again.`,
      { retry_after_seconds: error.retryAfterSeconds, reset_at: error.state.resetAt, limit: error.state.limit },
    );
  }
  if (!makesPublic) return null;
  const now = context.services.now();
  const published = await context.services.countAgentPublicPublishesSince(admin, { userId: context.userId, since: startOfUtcDay(now) });
  if (published < AGENT_PUBLISH_RATE_LIMIT.limit) return null;
  const resetAt = nextUtcMidnight(now);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000));
  return toolFailure(
    MCP_ERROR_CODES.RATE_LIMITED,
    `An agent may publish ${AGENT_PUBLISH_RATE_LIMIT.limit} public posts per UTC day for this creator, and that many are published today. The next is allowed at ${resetAt.toISOString()}; a private post (visibility private) is not counted.`,
    { retry_after_seconds: retryAfterSeconds, reset_at: resetAt.toISOString(), limit: AGENT_PUBLISH_RATE_LIMIT.limit, published_today: published },
  );
}

/** How many tools a post's Made with holds, and how long a name may be: the composer's own limits (`source-tools.ts`). */
const MADE_WITH_MAX_ENTRIES = 5;
const MADE_WITH_NAME_MAX_LENGTH = 80;

const PUBLISH_POST_SCHEMA = z.object({
  generation_id: GENERATION_ID.optional().describe('A creation made here, to publish as a post: the generation_id create_media or list_creations gave. Give generation_id or uploads, not both.'),
  uploads: z.array(z.object({
    storage_path: z.string().trim().min(1).max(512).describe('The input.storage_path upload_input answered for the file.'),
  })).min(1).max(MAX_POST_MEDIA_ITEMS).optional()
    .describe(`Media made elsewhere, to publish as a post: 1 to ${MAX_POST_MEDIA_ITEMS} pictures or clips you staged with upload_input, in the order the post shows them. Needs title and made_with.`),
  made_with: z.array(z.object({
    tool: z.string().trim().min(1).max(MADE_WITH_NAME_MAX_LENGTH).describe('The tool or app that made the media, as its makers name it (Midjourney, Photoshop, Blender, a camera). Never Magic Booklet: media made here is published with generation_id.'),
    model: z.string().trim().min(1).max(MADE_WITH_NAME_MAX_LENGTH).optional().describe('The model or version, where the tool has one (v7, FLUX.1 Pro).'),
  })).min(1).max(MADE_WITH_MAX_ENTRIES).optional()
    .describe(`Required with uploads, refused with generation_id: what made the media, 1 to ${MADE_WITH_MAX_ENTRIES} tools, shown on the post as Made with. Ask the person when you do not know.`),
  title: z.string().trim().min(1).max(TITLE_MAX_LENGTH).optional().describe(`The post's title, at most ${TITLE_MAX_LENGTH} characters; 6 or more for a post with a recipe. Required with uploads. Left out with generation_id, the creation's own title is used, else the title the web's Publish suggests from its prompt.`),
  description: z.string().trim().max(DESCRIPTION_MAX_LENGTH).optional().describe('A short description under the title.'),
  body: z.string().trim().max(BODY_MAX_LENGTH).optional().describe('The post\'s text, shown with the media.'),
  category: z.enum(['image', 'video']).optional().describe('How the post is filed; left out, the creation or the first upload decides.'),
  visibility: PUBLISH_VISIBILITY.optional().describe('public (the default for a new post) or private. On a post that already exists, given, it changes the visibility; left out, the post stays as it is.'),
  is_nsfw: z.boolean().optional().describe('Mark the post mature: it stays covered until a viewer who allows mature content reveals it.'),
  allow_remixes: z.boolean().optional().describe('With generation_id only. Default true: the post carries the creation\'s free recipe (its exact prompt and the saved inputs it may share), so others can remix it. False posts the media alone. Refused with uploads, which have no recipe.'),
});

type PublishPostArgs = z.output<typeof PUBLISH_POST_SCHEMA>;

/** How an existing post's state reads in a sentence: its visibility, and what else holds it back. */
function describeExistingState(existing: { visibility: 'public' | 'private'; state: AgentPostState }): string {
  if (existing.state === 'live') return 'live, public';
  if (existing.state === 'private') return 'private';
  return `${existing.visibility}, but ${existing.state}`;
}

/** The composer's field names, as the tool's arguments name them. */
const UPLOAD_PUBLISH_FIELD: Record<string, string> = { sourceTools: 'made_with', isNsfw: 'is_nsfw', mediaItems: 'uploads' };

/**
 * The composer service's refusals for a post made from uploads (`createOwnerPostForRoute`, and
 * `updateOwnerPostForRoute` for a visibility change), as stable codes with the service's own
 * message. The web's follow-up links (`actionHref`, `actionLabel`: a profile to complete, credits
 * to buy) are never passed on. A failure that is not the caller's says to publish again with the
 * same uploads, which is safe by the post's derived id: it answers the post where one was saved,
 * and says so where the files were spent and must be staged again.
 */
function uploadPublishRefusal(
  result: { status: number; body: { error: string; field?: string; code?: string; retryAfterSeconds?: number } },
): CallToolResult {
  const { status, body } = result;
  if (status === 429) return rateLimited(body.retryAfterSeconds);
  if (status === 404) return toolFailure(MCP_ERROR_CODES.NOT_FOUND, body.error);
  if (status === 409) return toolFailure('CONFLICT', body.error, { publish_code: body.code ?? null });
  if (status === 400) {
    const field = body.field ? UPLOAD_PUBLISH_FIELD[body.field] ?? body.field : null;
    return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, body.error, field ? { field_errors: { [field]: body.error } } : {});
  }
  return toolFailure(
    MCP_ERROR_CODES.UNAVAILABLE,
    `${body.error} Call publish_post again with the same uploads: it answers the post if one was saved, and says so if the files must be staged again.`,
  );
}

/** Why a staged path cannot become a post, where the tool can tell; null when it can, or when the composer service is the one to say. */
function refuseStagedUpload(upload: AgentStagedUpload | undefined, index: number, storagePath: string): CallToolResult | null {
  const named = `uploads[${index}] (${storagePath})`;
  const details = { field_errors: { uploads: `uploads[${index}] cannot be published as it stands.` }, storage_path: storagePath };
  // Not in the caller's staging folder: the composer service refuses it by its ownership rule.
  if (!upload || upload.kind === 'foreign') return null;
  if (upload.kind === 'unknown') {
    return toolFailure(MCP_ERROR_CODES.NOT_FOUND, `${named} is not a file staged with upload_input. Stage the file, then give the storage_path its answer names.`, details);
  }
  switch (upload.status) {
    case 'finalized':
      return null;
    case 'reserved':
    case 'issued':
    case 'finalizing':
      return toolFailure(MCP_ERROR_CODES.NOT_READY, `${named} has not been through upload_input. Once the file is sent, call upload_input with its upload_id, then publish.`, details);
    case 'consuming':
    case 'consumed':
      return toolFailure('CONFLICT', `${named} was already used by a post or a run, and a staged file is used once. Stage the file again to publish it.`, details);
    default:
      return toolFailure(MCP_ERROR_CODES.NOT_FOUND, `${named} is no longer staged: it lapsed or was removed. Stage the file again, then publish.`, details);
  }
}

/**
 * `publish_post` with `uploads`: a post of media made elsewhere, from files the agent staged. It
 * goes through the composer's own create with the form the composer page sends, so the title and
 * text rules, the post limit, the ownership of every staged path, the consumption of each staged
 * file and the media processing are the web's. What this adds: Made with is required and never
 * Magicbooklet's own name, the agent's daily cap on public posts applies as it does to a
 * creation, and the post's id is derived from the creator and the staged paths, so a publish
 * repeated after a lost answer finds its post instead of making a second.
 */
async function publishUploads(
  args: PublishPostArgs & { uploads: NonNullable<PublishPostArgs['uploads']> },
  context: McpToolContext,
): Promise<CallToolResult> {
  const { services } = context;
  const admin = context.createAdminSupabase();
  const invalid = (field: string, message: string) => (
    toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, message, { field_errors: { [field]: message } })
  );

  if (args.allow_remixes !== undefined) {
    return invalid('allow_remixes', 'allow_remixes goes with generation_id: a post made from uploads has no recipe to remix. Leave it out.');
  }
  if (!args.title) {
    return invalid('title', 'title is required with uploads: name the post, in the person\'s own words where they gave any.');
  }
  if (!args.made_with || args.made_with.length === 0) {
    return invalid('made_with', 'made_with is required with uploads: name the tool that made the media, and its model where it has one. Ask the person if you do not know.');
  }
  const madeWithRefusal = refuseAgentMadeWith(args.made_with);
  if (madeWithRefusal) return invalid('made_with', madeWithRefusal);
  const storagePaths = args.uploads.map((upload) => upload.storage_path.trim());
  if (storagePaths.length === 0 || storagePaths.length > MAX_POST_MEDIA_ITEMS) {
    return invalid('uploads', `A post takes 1 to ${MAX_POST_MEDIA_ITEMS} uploads.`);
  }
  if (new Set(storagePaths).size !== storagePaths.length) {
    return invalid('uploads', 'uploads names the same staged file twice; each file goes in once.');
  }

  const postId = agentUploadPostId(context.userId, storagePaths);
  const url = postUrl(context.siteOrigin, postId);
  const read = await services.readPostForAgent(admin, { postId, viewerUserId: context.userId });
  if (!read.ok && read.code === 'UNAVAILABLE') {
    return toolFailure(
      MCP_ERROR_CODES.UNAVAILABLE,
      'Whether these uploads are already published could not be read right now. Nothing was published; try again in a moment.',
    );
  }

  if (read.ok && read.post.isOwn) {
    // A publish of these uploads was made before: the post stands, and only an explicit, different
    // visibility changes it, through the composer's own save (the creation path's republish needs a
    // creation behind the post).
    const existing = read.post;
    if (!args.visibility || args.visibility === existing.visibility) {
      return toolSuccess(
        [
          `These uploads are already published as post ${postId} (${describeExistingState(existing)}): ${url}. Nothing was changed.`,
          existing.state === 'private' ? 'Publish again with the same uploads and visibility public to make it public.' : '',
        ].filter(Boolean).join(' '),
        { post_id: postId, post_url: url, visibility: existing.visibility, state: existing.state, already_published: true, visibility_changed: false, source: 'upload' },
      );
    }
    const limited = await refusePublishOverLimit(context, args.visibility === 'public');
    if (limited) return limited;
    const result = await services.updateOwnerPostForRoute({
      adminSupabase: admin,
      ownerUserId: context.userId,
      postId,
      body: { visibility: args.visibility },
      runAfterResponse: context.runAfterResponse,
    });
    if (!result.ok) return uploadPublishRefusal(result);
    const nowPublic = result.body.visibility === 'public';
    return toolSuccess(
      `Post ${postId} is now ${result.body.visibility}: ${url}.${nowPublic ? ' Anyone can see it.' : ' Only the creator sees it.'}`,
      {
        post_id: postId,
        post_url: url,
        visibility: result.body.visibility,
        state: nowPublic ? 'live' : 'private',
        already_published: true,
        visibility_changed: true,
        source: 'upload',
      },
    );
  }

  const staged = await services.readAgentStagedUploads(admin, { userId: context.userId, storagePaths });
  if (!staged.ok) {
    return toolFailure(
      MCP_ERROR_CODES.UNAVAILABLE,
      'The staged uploads could not be read right now. Nothing was published; try again in a moment.',
    );
  }
  for (const [index, storagePath] of storagePaths.entries()) {
    const refusal = refuseStagedUpload(staged.uploads.get(storagePath), index, storagePath);
    if (refusal) return refusal;
  }

  const visibility = args.visibility ?? 'public';
  const limited = await refusePublishOverLimit(context, visibility === 'public');
  if (limited) return limited;
  const formData = buildAgentUploadPublishFormData({
    title: args.title,
    description: args.description,
    body: args.body,
    category: args.category,
    visibility,
    isNsfw: args.is_nsfw,
    madeWith: args.made_with,
    uploads: storagePaths.map((storagePath) => {
      const upload = staged.uploads.get(storagePath);
      // The type the server recorded for the staged file, never the agent's word for it.
      return { storagePath, contentType: upload?.kind === 'staged' ? upload.contentType : null };
    }),
  });
  const result = await services.createOwnerPostForRoute({
    adminSupabase: admin,
    ownerUserId: context.userId,
    readFormData: async () => formData,
    createPostId: () => postId,
  });
  if (!result.ok) return uploadPublishRefusal(result);
  const isPublic = result.body.visibility === 'public';
  const files = `${storagePaths.length} upload${storagePaths.length === 1 ? '' : 's'}`;
  return toolSuccess(
    [
      isPublic
        ? `Published ${files} as post ${postId}: ${url}. It is public now; anyone can see it, and it goes through moderation as any post does.`
        : `Saved ${files} as private post ${postId}: ${url}. Only the creator sees it; publish again with the same uploads and visibility public to make it public.`,
      'Keep this post_id: list_creations lists creations, not posts made from uploads. get_post reads it and delete_post removes it.',
      'Give the person the link.',
    ].join(' '),
    {
      post_id: postId,
      post_url: url,
      visibility: result.body.visibility,
      state: isPublic ? 'live' : 'private',
      already_published: false,
      visibility_changed: false,
      source: 'upload',
      media_count: storagePaths.length,
      recipe_included: false,
    },
  );
}

const publishPostTool = defineTool({
  name: 'publish_post',
  title: 'Publish a post',
  description: [
    'Publish a post on the creator\'s profile and in the Magicbooklet showcase, from one of two sources. generation_id: one of the creator\'s finished creations made here. uploads: media made elsewhere (another tool, the person\'s own files), as 1 to 5 pictures or clips you staged with upload_input. Give exactly one.',
    'The post is public at once (visibility public, the default): anyone can see it, and it enters the feed and the moderation queue as any post does. Pass visibility private instead to keep it on the creator\'s profile, visible to them alone, which they can make public later. Tell the person before you publish, and give them post_url after.',
    `With generation_id, only the creator's own succeeded creation publishes (NOT_FOUND for any other creation, NOT_READY for a run still going or a creation its creator archived); get_generation says when a run has succeeded. Give a title of at least 6 characters, or leave it out for the title the web suggests from the creation; description, body (the post's text) and category are optional.`,
    'allow_remixes (default true) publishes the creation\'s recipe with the post, free, so others can remix it: its exact prompt and the saved inputs it may share. False posts the media alone, with no recipe.',
    'With uploads, title is required and so is made_with, which names what made the media (the tool, and its model where it has one) and is shown on the post as Made with: never Magic Booklet, whose own media is published with generation_id. Each upload is the storage_path upload_input answered, and is spent by the post. The answer\'s post_id is the only handle on such a post (list_creations lists creations), so keep it.',
    `Publishing the same creation, or the same uploads, again returns the existing post with already_published true and changes nothing, unless visibility is given and differs, which changes the post's visibility. Public posts by an agent are capped at ${AGENT_PUBLISH_RATE_LIMIT.limit} per creator per UTC day, counting publications, not refused attempts (RATE_LIMITED says when the next is allowed).`,
  ].join(' '),
  // Open world: the post is seen by everyone, outside the agent's conversation.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: PUBLISH_POST_SCHEMA,
  async handle(args, context) {
    if ((args.generation_id === undefined) === (args.uploads === undefined)) {
      const message = 'Give exactly one of generation_id (a creation made here) or uploads (files staged with upload_input).';
      return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, message, { field_errors: { generation_id: message } });
    }
    if (args.uploads !== undefined) return publishUploads({ ...args, uploads: args.uploads }, context);
    if (args.made_with !== undefined) {
      const message = 'made_with goes with uploads. A creation\'s Made with is fixed by the run that made it; leave made_with out.';
      return toolFailure(MCP_ERROR_CODES.INVALID_REQUEST, message, { field_errors: { made_with: message } });
    }
    const generationId = args.generation_id as string;
    const { services } = context;
    const admin = context.createAdminSupabase();
    const notFound = () => toolFailure(
      MCP_ERROR_CODES.NOT_FOUND,
      `No creation ${generationId} exists for this creator. list_creations lists theirs.`,
      { generation_id: generationId },
    );
    const creation = await services.readCreationForPublish(admin, { generationId, userId: context.userId });
    // A missing creation, another creator's, and one an operator removed answer alike: nothing
    // about what exists under an id that is not the caller's to publish.
    if (!creation || creation.moderationRemovedAt) return notFound();
    if (!(await services.isOwnOrLinkedAccountId(admin, context.userId, creation.userId))) return notFound();
    if (creation.archivedAt) {
      return toolFailure(
        MCP_ERROR_CODES.NOT_READY,
        `Creation ${generationId} is archived; the creator restores it on the website before it can be published.`,
        { generation_id: generationId, status: 'archived' },
      );
    }
    if (creation.status !== 'succeeded') {
      return toolFailure(
        MCP_ERROR_CODES.NOT_READY,
        `Creation ${generationId} is ${creation.status}, not succeeded. Call get_generation with wait_seconds ${MCP_GENERATION_WAIT_SUGGESTED_SECONDS} until it has, then publish.`,
        { generation_id: generationId, status: creation.status },
      );
    }

    const makePost = async (body: Parameters<typeof publishGenerationToShowcaseForRoute>[0]['body']) => (
      services.publishGenerationToShowcaseForRoute({
        adminSupabase: admin,
        body,
        dependencies: { runAfterResponse: context.runAfterResponse },
        userId: context.userId,
      })
    );

    if (creation.post) {
      const existing = creation.post;
      const url = postUrl(context.siteOrigin, existing.id);
      if (!args.visibility || args.visibility === existing.visibility) {
        return toolSuccess(
          `Creation ${generationId} is already published as post ${existing.id} (${describeExistingState(existing)}): ${url}. Nothing was changed; its text and recipe stay as the creator left them.`,
          { post_id: existing.id, post_url: url, visibility: existing.visibility, state: existing.state, already_published: true, visibility_changed: false },
        );
      }
      // A visibility change alone: the service republishes the stored post as it is.
      const limited = await refusePublishOverLimit(context, args.visibility === 'public');
      if (limited) return limited;
      const result = await makePost({ generationId, visibility: args.visibility });
      if (!result.ok) return publishRefusal(result);
      return toolSuccess(
        `Post ${existing.id} is now ${result.body.visibility}: ${url}.${result.body.visibility === 'public' ? ' Anyone can see it.' : ' Only the creator sees it.'}`,
        {
          post_id: existing.id,
          post_url: url,
          visibility: result.body.visibility,
          state: result.body.visibility === 'public' ? 'live' : 'private',
          already_published: true,
          visibility_changed: true,
        },
      );
    }

    const visibility = args.visibility ?? 'public';
    const allowRemixes = args.allow_remixes ?? true;
    // No title given: the web's Publish never sends an empty one; it starts from the creation's
    // own title, else a title suggested from the prompt (the prompt is public in a free recipe, so
    // nothing is kept private here), and a compose request without one is refused by the service.
    const title = args.title
      ?? getCreationPostTitleSuggestion(
        creation.title,
        { prompt: creation.prompt, model: creation.model, category: creation.category, creationMode: creation.creationMode },
        false,
      )?.title
      ?? undefined;
    const limited = await refusePublishOverLimit(context, visibility === 'public');
    if (limited) return limited;
    const result = await makePost(buildAgentPublishRequest({
      generationId,
      title,
      description: args.description,
      body: args.body,
      category: args.category,
      visibility,
      isNsfw: args.is_nsfw,
      allowRemixes,
      creationPrompt: creation.prompt,
    }));
    if (!result.ok) return publishRefusal(result);
    const postId = result.body.postId;
    const url = postId ? postUrl(context.siteOrigin, postId) : null;
    const recipeIncluded = result.body.resourceBundleStatus !== null;
    return toolSuccess(
      [
        result.body.visibility === 'public'
          ? `Published creation ${generationId} as post ${postId}: ${url}. It is public now; anyone can see it, and it goes through moderation as any post does.`
          : `Saved creation ${generationId} as private post ${postId}: ${url}. Only the creator sees it; publish again with visibility public to make it public.`,
        recipeIncluded ? 'Its free recipe (the exact prompt) is on the post, so others can remix it.' : 'It carries no recipe.',
        'Give the person the link.',
      ].join(' '),
      {
        post_id: postId,
        post_url: url,
        visibility: result.body.visibility,
        state: result.body.visibility === 'public' ? 'live' : 'private',
        already_published: false,
        visibility_changed: false,
        recipe_included: recipeIncluded,
        recipe_status: result.body.resourceBundleStatus,
        ...(typeof result.body.referencesNotCopied === 'number' && result.body.referencesNotCopied > 0
          ? { references_not_copied: result.body.referencesNotCopied }
          : {}),
      },
    );
  },
  // The audit row: which answer this was, and the post only where the agent made or changed one,
  // so the daily cap counts public publications and moderation lists no post a creator published
  // by hand (`agent-tool-calls.ts`). A creation's existing post may be the creator's own doing,
  // so an unchanged republish of it names no post. A post made from uploads has an id only this
  // tool derives, so it is an agent's whichever call finds it: an unchanged repeat still names
  // it, which keeps it on moderation's list when the call that made it never wrote its row (an
  // answer lost to a timeout is exactly when a publish is repeated).
  audit(structured) {
    const alreadyPublished = structured.already_published === true;
    const changed = structured.visibility_changed === true;
    if (alreadyPublished && !changed) {
      return structured.source === 'upload'
        ? { code: AGENT_PUBLISH_RECORD_CODES.ALREADY_PUBLISHED }
        : { code: AGENT_PUBLISH_RECORD_CODES.ALREADY_PUBLISHED, postId: null };
    }
    if (structured.visibility === 'public') return { code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PUBLIC };
    return { code: changed ? AGENT_PUBLISH_RECORD_CODES.MADE_PRIVATE : AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PRIVATE };
  },
});

const getPostTool = defineTool({
  name: 'get_post',
  title: 'Read a post',
  description: [
    'Read one post by post_id: the creator\'s own in any state, or anyone\'s while it is live.',
    'Returns its state (live, private, archived, hidden by moderation, or removed), post_url, title, visibility, whether remixes are allowed, and the counts the post page shows (saves, comments, remixes, shares).',
    'Call it after publish_post to confirm a post or before delete_post. A post that is not the creator\'s and not live answers NOT_FOUND.',
    'generation_id names the creation behind the post; it is null for a post made from uploads, which list_creations does not list.',
  ].join(' '),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({ post_id: POST_ID }),
  async handle({ post_id: postId }, context) {
    const limited = await refuseReadOverLimit(context);
    if (limited) return limited;
    const read = await context.services.readPostForAgent(context.createAdminSupabase(), { postId, viewerUserId: context.userId });
    if (!read.ok) {
      return read.code === 'NOT_FOUND'
        ? toolFailure(MCP_ERROR_CODES.NOT_FOUND, `No post ${postId} is live or the creator's. list_creations names the posts of the creator's creations; a post made from uploads is known by the post_id publish_post gave.`, { post_id: postId })
        : toolFailure(MCP_ERROR_CODES.UNAVAILABLE, 'The post could not be read right now. Try again in a moment.');
    }
    const { post } = read;
    const counts = post.counts;
    return toolSuccess(
      [
        `Post ${post.postId}${post.title ? ` "${post.title}"` : ''} is ${describeState(post)}: ${postUrl(context.siteOrigin, post.postId)}.`,
        `${counts.saves} save${counts.saves === 1 ? '' : 's'}, ${counts.comments} comment${counts.comments === 1 ? '' : 's'}, ${counts.remixes} remix${counts.remixes === 1 ? '' : 'es'}, ${counts.shares} share${counts.shares === 1 ? '' : 's'}.`,
        post.isOwn ? 'It is the creator\'s own.' : 'It is another creator\'s.',
        post.generationId ? '' : 'It was made from uploaded media, not from a creation here.',
      ].filter(Boolean).join(' '),
      postView(post, context),
    );
  },
});

const deletePostTool = defineTool({
  name: 'delete_post',
  title: 'Delete a post',
  description: [
    'Delete one of the creator\'s own posts for good: it leaves their profile, the showcase and the feed, and its public media is removed; the creation itself stays in their library. A post made from uploads has no creation behind it, so its media goes with it.',
    'Confirm with the person first; it cannot be undone. Another creator\'s post is refused (NOT_OWNER).',
    'When people have unlocked the post\'s recipe, the post is not deleted but taken off every public surface, and the buyers keep what they unlocked: the answer is POST_HAS_BUYERS until you call again with force true, after telling the person.',
  ].join(' '),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: z.object({
    post_id: POST_ID,
    force: z.boolean().optional().describe('With people holding the post\'s recipe, true takes the post off every public surface while they keep their copy; false (the default) answers POST_HAS_BUYERS instead.'),
  }),
  async handle({ post_id: postId, force = false }, context) {
    const { services } = context;
    const admin = context.createAdminSupabase();
    const read = await services.readPostForAgent(admin, { postId, viewerUserId: context.userId });
    if (!read.ok) {
      return read.code === 'NOT_FOUND'
        ? toolFailure(MCP_ERROR_CODES.NOT_FOUND, `No post ${postId} is the creator's. list_creations names the posts of their creations; a post made from uploads is known by the post_id publish_post gave.`, { post_id: postId })
        : toolFailure(MCP_ERROR_CODES.UNAVAILABLE, 'The post could not be read right now. Try again in a moment.');
    }
    if (!read.post.isOwn) {
      return toolFailure(MCP_ERROR_CODES.NOT_OWNER, `Post ${postId} is another creator's; only its creator can delete it.`, { post_id: postId });
    }
    const result = await services.deleteOwnerPostForRoute({ adminSupabase: admin, ownerUserId: context.userId, postId, forceDelete: force });
    if (!result.ok) {
      if (result.status === 429) return rateLimited(result.rateLimitError.retryAfterSeconds);
      if (result.status === 404) return toolFailure(MCP_ERROR_CODES.NOT_FOUND, `No post ${postId} is the creator's.`, { post_id: postId });
      if (result.status === 409) {
        return toolFailure(
          'POST_HAS_BUYERS',
          `${result.body.error} Tell the person; to go ahead, call delete_post again with force true.`,
          { post_id: postId },
        );
      }
      return toolFailure(MCP_ERROR_CODES.UNAVAILABLE, `${result.body.error} Try again in a moment.`);
    }
    const tombstoned = result.body.tombstoned === true;
    // A post made from uploads has no creation behind it: its media was the post's alone.
    const whatStays = read.post.generationId
      ? 'The creation stays in the creator\'s library.'
      : 'It was made from uploaded media, which is removed with it.';
    return toolSuccess(
      tombstoned
        ? `Post ${postId} is off every public surface; the people who unlocked its recipe keep their copy. ${whatStays}`
        : `Post ${postId} is deleted. ${whatStays}`,
      { post_id: postId, deleted: true, tombstoned },
    );
  },
});

// ---------------------------------------------------------------------------------------------
// The registry

export const MCP_TOOLS: ReadonlyArray<McpToolDefinition> = [
  listModelsTool,
  getModelTool,
  quoteGenerationTool,
  uploadInputTool,
  requestUploadTool,
  createMediaTool,
  getGenerationTool,
  listCreationsTool,
  publishPostTool,
  getPostTool,
  deletePostTool,
  enhancePromptTool,
];

export const MCP_SERVER_INSTRUCTIONS = [
  'Magicbooklet makes AI images, videos and motion clips with the signed-in creator\'s credits, and publishes them, or media the creator made elsewhere, to the creator\'s profile.',
  'Flow for a creation: list_models → get_model → (upload_input for the person\'s own files) → quote_generation → tell the person the price → create_media with expected_cost_credits → get_generation with wait_seconds until settled.',
  'Flow for a post: once get_generation says succeeded, publish_post with the generation_id and a title. The post is public at once unless visibility is private; tell the person before publishing and give them post_url after. get_post reads a post, delete_post removes one of the creator\'s own.',
  'Flow for media made elsewhere (another tool, the person\'s own files): stage each picture or clip with upload_input, by url, or for a file on your machine request_upload → run the curl command it gives → upload_input with the upload_id; then publish_post with uploads, a title and made_with naming what made the media. Ask the person before posting it publicly, and keep the post_id.',
  'Every run spends the creator\'s credits; a failed run refunds them. Never promise a result before get_generation says succeeded.',
].join(' ');

/** The tools whose successful answer charged the creator; a quote's cost_credits is a price, not a charge. */
const CHARGING_TOOLS: ReadonlySet<McpToolName> = new Set(['create_media', 'enhance_prompt']);

/** Runs one tool call: the handler, then one record of it for the adapter's log, whatever happened. */
export async function runMcpTool(
  tool: McpToolDefinition,
  args: unknown,
  context: McpToolContext,
): Promise<CallToolResult> {
  const started = context.services.now();
  const argsRecord = isRecord(args) ? args : {};
  const report = (record: Omit<McpToolCallRecord, 'tool' | 'elapsedMs' | 'generationId' | 'postId'> & Partial<Pick<McpToolCallRecord, 'generationId' | 'postId'>>) => {
    context.onToolCall?.({
      tool: tool.name,
      elapsedMs: context.services.now() - started,
      // The ids the call was about, from its arguments unless its answer named them.
      generationId: record.generationId ?? uuidOrNull(argsRecord.generation_id),
      postId: record.postId ?? uuidOrNull(argsRecord.post_id),
      ...record,
    });
  };
  try {
    const result = await tool.handle(args as never, context);
    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    const error = isRecord(structured.error) ? structured.error : null;
    // A replay under an idempotency key answers the run started earlier: its cost was logged then.
    const charged = !result.isError && CHARGING_TOOLS.has(tool.name) && structured.idempotent_replay !== true;
    // A successful answer may say which answer it was, and whether it names a post the agent made
    // or changed (publish_post does); a failure records its code.
    const audit = !result.isError && tool.audit ? tool.audit(structured) : {};
    report({
      outcome: result.isError ? 'error' : 'ok',
      code: typeof error?.code === 'string' ? error.code : audit.code ?? null,
      costCredits: charged ? numberOrNull(structured.cost_credits) : null,
      generationId: uuidOrNull(structured.generation_id) ?? uuidOrNull(argsRecord.generation_id),
      postId: audit.postId === null ? null : uuidOrNull(audit.postId ?? structured.post_id) ?? uuidOrNull(argsRecord.post_id),
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
      description: 'Create AI media with your Magicbooklet credits, and publish it, or media you made elsewhere, to your profile.',
    },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  registerMcpTools(server, context);
  return server;
}
