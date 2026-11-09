import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentPostView } from '@/lib/agent-post-read';
import { AGENT_PUBLISH_RECORD_CODES } from '@/lib/agent-tool-calls';
import {
  AGENT_PUBLISH_RATE_LIMIT,
  AGENT_UPLOAD_INPUT_RATE_LIMIT,
  BackendRateLimitError,
  SHOWCASE_PUBLISH_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { getCreationPostTitleSuggestion } from '@/lib/creation-post-title';
import {
  MCP_GENERATION_POLL_INTERVAL_MS,
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOLS,
  createMcpServer,
  registerMcpTools,
  runMcpTool,
  type CreationForPublish,
  type McpToolCallRecord,
  type McpToolContext,
  type McpToolDefinition,
  type McpToolServices,
} from '@/lib/mcp-server-service';
import {
  MCP_RESULT_CHARACTER_CAP,
  capToolResult,
  toolFailure,
  toolFailureCode,
  toolSuccess,
} from '@/lib/mcp-tool-results';

const SITE = 'https://magicbooklet.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const GENERATION_ID = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';

const CURRENT = {
  transportVersion: 1 as const,
  descriptorSchemaVersion: 3 as const,
  revision: 'rev-1',
  defaults: { image: 'img-1', video: 'vid-1', motion: null },
  counts: { image: 2, video: 1, motion: 0 },
};
const SUMMARIES = [
  { id: 'img-1', kind: 'image' as const, displayName: 'Image One', description: 'Fast pictures.', badge: null, recommended: true, sortOrder: 1 },
  { id: 'img-2', kind: 'image' as const, displayName: 'Image Two', description: 'Slow pictures.', badge: 'New', recommended: false, sortOrder: 2 },
  { id: 'vid-1', kind: 'video' as const, displayName: 'Video One', description: 'Clips.', badge: null, recommended: false, sortOrder: 3 },
];
const DESCRIPTOR = {
  id: 'img-1',
  kind: 'image' as const,
  displayName: 'Image One',
  description: 'Fast pictures.',
  badge: null,
  recommended: true,
  sortOrder: 1,
  minClientSchemaVersion: 1,
  controls: [{ type: 'choice', key: 'aspectRatio', label: 'Aspect', defaultValue: '1:1', options: [{ value: '1:1', label: 'Square' }] }],
  capabilities: { multiShot: false, sound: false, fixedLens: false, googleSearch: false, outputFormat: false },
  inputs: { imageReferences: { max: 3, supportsNaming: false }, videoReferences: null, audioReferences: null, startFrame: false, endFrame: false },
  inputModes: [{ kind: 'references' }],
};

function tool(name: string): McpToolDefinition {
  const found = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function generation(overrides: Record<string, unknown> = {}) {
  return {
    id: GENERATION_ID,
    status: 'succeeded',
    category: 'image',
    model: 'img-1',
    prompt: 'a red bicycle at dawn, film grain',
    created_at: '2026-11-09T10:00:00Z',
    completed_at: '2026-11-09T10:00:30Z',
    cost: 19,
    refunded: false,
    error_message: null,
    output_url: 'https://cdn.magicbooklet.test/signed/output.jpg?token=abc',
    preview_url: 'https://cdn.magicbooklet.test/signed/preview.jpg?token=abc',
    media: {
      id: GENERATION_ID,
      kind: 'image',
      url: 'https://cdn.magicbooklet.test/signed/output.jpg?token=abc',
      previewUrl: 'https://cdn.magicbooklet.test/signed/preview.jpg?token=abc',
      width: 1024,
      height: 1024,
      durationSeconds: null,
      expiresAt: '2026-11-09T11:00:00Z',
    },
    linked_post_id: null,
    ...overrides,
  };
}

function creation(overrides: Partial<CreationForPublish> = {}): CreationForPublish {
  return {
    id: GENERATION_ID,
    userId: USER_ID,
    status: 'succeeded',
    prompt: 'a red bicycle at dawn, film grain',
    title: null,
    model: 'img-1',
    category: 'image',
    creationMode: null,
    archivedAt: null,
    moderationRemovedAt: null,
    post: null,
    ...overrides,
  };
}

function post(overrides: Partial<AgentPostView> = {}): AgentPostView {
  return {
    postId: POST_ID,
    ownerUserId: USER_ID,
    generationId: GENERATION_ID,
    title: 'Red bicycle',
    description: null,
    body: null,
    category: 'image',
    visibility: 'public',
    state: 'live',
    isNsfw: false,
    remixesAllowed: true,
    counts: { saves: 3, comments: 1, remixes: 0, shares: 2 },
    createdAt: '2026-11-09T10:00:00Z',
    isOwn: true,
    ...overrides,
  };
}

function published(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    body: {
      success: true as const,
      isPublic: true,
      visibility: 'public' as const,
      postId: POST_ID,
      showcasePath: `/showcase/${POST_ID}`,
      ownerPath: `/post/${POST_ID}/edit`,
      resourceBundlePath: `/showcase/${POST_ID}#recipe`,
      resourceBundleStatus: 'published' as const,
      message: 'Successfully published to showcase',
      ...overrides,
    },
  };
}

function clock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: vi.fn(async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    }),
    sleeps,
    advance(ms: number) { now += ms; },
  };
}

function harness(overrides: Partial<McpToolServices> = {}) {
  const time = clock();
  const records: McpToolCallRecord[] = [];
  const admin = { tag: 'admin' } as unknown as SupabaseClient;
  const user = { tag: 'user' } as unknown as SupabaseClient;
  const services: McpToolServices = {
    readModelCatalogCurrent: vi.fn(async () => CURRENT),
    readModelCatalogPage: vi.fn(async ({ limit }: { limit: number }) => SUMMARIES.slice(0, limit + 1)) as unknown as McpToolServices['readModelCatalogPage'],
    readModelCatalogDetails: vi.fn(async () => [DESCRIPTOR]) as unknown as McpToolServices['readModelCatalogDetails'],
    createGenerationModelQuote: vi.fn(async () => ({
      ok: true as const,
      quote: { modelId: 'img-1', catalogRevision: 'rev-1', normalizedSettings: { aspectRatio: '1:1' }, costCredits: 19 },
    })) as unknown as McpToolServices['createGenerationModelQuote'],
    postUnifiedGenerationForRoute: vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true,
        predictionId: 'pred-1',
        generationId: GENERATION_ID,
        status: 'processing',
        remainingCredits: 81,
        cost: 19,
        catalogRevision: 'rev-1',
        modelId: 'img-1',
      },
    })) as unknown as McpToolServices['postUnifiedGenerationForRoute'],
    listOwnerGenerationsForRoute: vi.fn(async () => ({
      generations: [generation()],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    })) as unknown as McpToolServices['listOwnerGenerationsForRoute'],
    enhancePromptForUser: vi.fn(async () => ({
      ok: true as const,
      response: {
        enhancedPrompt: 'A red bicycle leaning on a stone wall at dawn, soft film grain, 35mm.',
        remainingCredits: 99,
        agentId: 'image-v1',
        qualityScore: 0.9,
        warnings: [],
        appliedSafeguards: [],
      },
    })) as unknown as McpToolServices['enhancePromptForUser'],
    publishGenerationToShowcaseForRoute: vi.fn(async () => published()) as unknown as McpToolServices['publishGenerationToShowcaseForRoute'],
    deleteOwnerPostForRoute: vi.fn(async () => ({ ok: true as const, body: { success: true as const, deleted: true as const } })) as unknown as McpToolServices['deleteOwnerPostForRoute'],
    readPostForAgent: vi.fn(async () => ({ ok: true as const, post: post() })) as unknown as McpToolServices['readPostForAgent'],
    stageAgentInput: vi.fn(async () => ({
      ok: true as const,
      input: { url: 'https://project.supabase.test/storage/v1/object/sign/uploads/x?token=read', storagePath: `uploads/${USER_ID}/staged-agent-image.jpg` },
      kind: 'image' as const,
      bytes: 4096,
      mimeType: 'image/jpeg',
      expiresInSeconds: 3600,
      sourceUrl: 'https://cdn.example.com/a.jpg',
    })) as unknown as McpToolServices['stageAgentInput'],
    fetchImageContentBlock: vi.fn(async () => null) as unknown as McpToolServices['fetchImageContentBlock'],
    enforceBackendRateLimit: vi.fn(async () => undefined) as unknown as McpToolServices['enforceBackendRateLimit'],
    readCreditBalance: vi.fn(async () => 100),
    readCreationForPublish: vi.fn(async () => creation()),
    countAgentPublicPublishesSince: vi.fn(async () => 0) as unknown as McpToolServices['countAgentPublicPublishesSince'],
    isOwnOrLinkedAccountId: vi.fn(async (_admin: unknown, userId: string, ownerUserId: string | null | undefined) => ownerUserId === userId) as unknown as McpToolServices['isOwnOrLinkedAccountId'],
    promptEnhancementCost: () => 1,
    sleep: time.sleep,
    now: time.now,
    ...overrides,
  };
  const deferred: Array<Promise<unknown>> = [];
  const context: McpToolContext = {
    request: new Request(`${SITE}/api/mcp`, { method: 'POST', headers: { authorization: 'Bearer agent-token' } }),
    userId: USER_ID,
    clientId: 'client-claude',
    siteOrigin: SITE,
    kieApiKey: 'kie-test-key',
    createUserSupabase: () => user,
    createAdminSupabase: () => admin,
    services,
    onToolCall: (record) => records.push(record),
    runAfterResponse: (task) => { deferred.push(task()); },
  };
  return { context, services, records, time, admin, user, deferred };
}

function structured(result: Awaited<ReturnType<McpToolDefinition['handle']>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

function text(result: Awaited<ReturnType<McpToolDefinition['handle']>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

function rateLimit(retryAfterSeconds: number) {
  return new BackendRateLimitError({ allowed: false, limit: 10, remaining: 0, retryAfterSeconds, resetAt: '2026-11-09T10:10:00Z' });
}

describe('MCP tool registry', () => {
  it('holds every tool to a title, a description written for an agent, annotations and a schema', () => {
    expect(MCP_TOOLS.map((entry) => entry.name)).toEqual([
      'list_models', 'get_model', 'quote_generation', 'upload_input', 'create_media', 'get_generation', 'list_creations',
      'publish_post', 'get_post', 'delete_post', 'enhance_prompt',
    ]);
    for (const entry of MCP_TOOLS) {
      expect(entry.title.length, entry.name).toBeGreaterThan(3);
      // A description says when to call the tool and what to do with the answer, so it names
      // at least one other tool or the person the agent works for.
      expect(entry.description.length, entry.name).toBeGreaterThan(120);
      expect(entry.description, entry.name).toMatch(/list_models|get_model|quote_generation|create_media|get_generation|list_creations|publish_post|the person/);
      expect(entry.inputSchema, entry.name).toBeInstanceOf(z.ZodObject);
      expect(typeof entry.annotations.readOnlyHint, entry.name).toBe('boolean');
      expect(typeof entry.annotations.openWorldHint, entry.name).toBe('boolean');
    }
    const readOnly = MCP_TOOLS.filter((entry) => entry.annotations.readOnlyHint).map((entry) => entry.name);
    expect(readOnly).toEqual(['list_models', 'get_model', 'quote_generation', 'get_generation', 'list_creations', 'get_post']);
    // Open world: a publish is seen by everyone, and an upload by URL reaches hosts outside Magicbooklet.
    const openWorld = MCP_TOOLS.filter((entry) => entry.annotations.openWorldHint).map((entry) => entry.name);
    expect(openWorld).toEqual(['upload_input', 'publish_post']);
    // Spends credits: asked about by clients that prompt on destructive tools.
    expect(tool('create_media').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    // Spends a credit too, so not read-only, but creates nothing lasting.
    expect(tool('enhance_prompt').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool('publish_post').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(tool('delete_post').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    // The descriptions say what an agent must know before acting: the post is public at once, and how to keep it private.
    expect(tool('publish_post').description).toMatch(/public at once/u);
    expect(tool('publish_post').description).toMatch(/visibility private/u);
    expect(tool('publish_post').description).toContain('already_published');
    // The cap's window is the UTC day, and it counts publications: said where the agent reads it.
    expect(tool('publish_post').description).toContain('per UTC day');
    expect(tool('publish_post').description).toMatch(/not refused attempts/u);
    expect(tool('get_generation').description).toContain('include_preview');
    expect(tool('upload_input').description).toContain('25 MB for a picture, 50 MB for a clip, 50 MB for a track');
    expect(tool('upload_input').description).toContain('at most 3 MB decoded');
    expect(tool('create_media').description).toContain('upload_input');
    // A staged file's storage_path rides with its URL into the run.
    const staged = tool('create_media').inputSchema.parse({
      kind: 'image', model_id: 'img-1', catalog_revision: 'rev-1', expected_cost_credits: 1, idempotency_key: 'k',
      inputs: [{ slot: 'references', kind: 'image', url: 'https://project.supabase.test/sign/a.jpg', storage_path: 'uploads/u/a.jpg' }],
    }) as { inputs: Array<Record<string, unknown>> };
    expect(staged.inputs[0].storage_path).toBe('uploads/u/a.jpg');
    expect(tool('upload_input').description).toContain('create_media');
    expect(tool('delete_post').description).toMatch(/cannot be undone/u);
    expect(MCP_SERVER_INSTRUCTIONS).toContain('publish_post');
  });

  it('registers each tool on the server with its title, description, schema and annotations', () => {
    const registerTool = vi.fn();
    registerMcpTools({ registerTool } as never, harness().context);
    expect(registerTool).toHaveBeenCalledTimes(MCP_TOOLS.length);
    for (const [index, entry] of MCP_TOOLS.entries()) {
      const [name, config, callback] = registerTool.mock.calls[index];
      expect(name).toBe(entry.name);
      expect(config).toEqual({
        title: entry.title,
        description: entry.description,
        inputSchema: entry.inputSchema,
        annotations: entry.annotations,
      });
      expect(typeof callback).toBe('function');
    }
  });

  it('builds a server that lists the tools and carries the instructions', async () => {
    const server = createMcpServer(harness().context);
    expect(MCP_SERVER_INSTRUCTIONS).toContain('create_media with expected_cost_credits');
    // The SDK keeps the registry private; the registration walk above is the contract, and the
    // route adapter's test lists the tools through the real transport.
    expect(server).toBeDefined();
    await server.close();
  });
});

describe('list_models', () => {
  it('pages the web catalog at the current revision, with a cursor for the next page', async () => {
    const { context, services } = harness();
    const result = await tool('list_models').handle({ kind: 'image', limit: 2 }, context);
    expect(result.isError).toBeUndefined();
    const data = structured(result);
    expect(data.catalog_revision).toBe('rev-1');
    expect(data.defaults).toEqual(CURRENT.defaults);
    expect(data.models).toEqual([
      { model_id: 'img-1', kind: 'image', display_name: 'Image One', description: 'Fast pictures.', badge: null, recommended: true },
      { model_id: 'img-2', kind: 'image', display_name: 'Image Two', description: 'Slow pictures.', badge: 'New', recommended: false },
    ]);
    expect(typeof data.next_cursor).toBe('string');
    expect(text(result)).toContain('rev-1');
    expect(text(result)).toContain('get_model');
    expect(services.readModelCatalogPage).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'web', revision: 'rev-1', kind: 'image', after: null, limit: 2,
    }));

    // The cursor is the catalog's own: the next page starts after the last model listed.
    const next = await tool('list_models').handle({ kind: 'image', limit: 2, cursor: data.next_cursor as string }, context);
    expect(services.readModelCatalogPage).toHaveBeenLastCalledWith(expect.objectContaining({
      after: { id: 'img-2', sortOrder: 2 },
    }));
    expect(next.isError).toBeUndefined();
  });

  it('answers a cursor from another revision as an invalid request, and an unreadable catalog as unavailable', async () => {
    const { context } = harness();
    const stale = await tool('list_models').handle({ cursor: 'bm90LWEtY3Vyc29y' }, context);
    expect(toolFailureCode(stale)).toBe('INVALID_REQUEST');

    const broken = harness({ readModelCatalogCurrent: vi.fn(async () => { throw new Error('rpc down'); }) });
    const result = await tool('list_models').handle({}, broken.context);
    expect(toolFailureCode(result)).toBe('UNAVAILABLE');
  });
});

describe('get_model', () => {
  it('returns the descriptor without the legacy inputs block, and points at quote_generation', async () => {
    const { context } = harness();
    const result = await tool('get_model').handle({ model_id: 'img-1' }, context);
    const data = structured(result);
    expect(data.catalog_revision).toBe('rev-1');
    const model = data.model as Record<string, unknown>;
    expect(model.id).toBe('img-1');
    expect(model.controls).toEqual(DESCRIPTOR.controls);
    expect(model.inputModes).toEqual(DESCRIPTOR.inputModes);
    expect(model).not.toHaveProperty('inputs');
    expect(text(result)).toContain('quote_generation');
  });

  it('answers an unknown model NOT_FOUND with the revision it looked in', async () => {
    const { context } = harness({ readModelCatalogDetails: vi.fn(async () => []) as never });
    const result = await tool('get_model').handle({ model_id: 'nope' }, context);
    expect(toolFailureCode(result)).toBe('NOT_FOUND');
    expect(structured(result).error).toMatchObject({ model_id: 'nope', catalog_revision: 'rev-1' });
    expect(text(result)).toContain('list_models');
  });
});

describe('quote_generation', () => {
  it('prices the run through the quote service, keyed on the creator, and says whether the balance covers it', async () => {
    const { context, services } = harness();
    const result = await tool('quote_generation').handle({
      kind: 'image',
      model_id: 'img-1',
      settings: { aspectRatio: '1:1' },
      input_counts: { images: 2, prepared_audios: 1 },
      input_metadata: { reference_video_durations_seconds: [4.5] },
      catalog_revision: 'rev-1',
    }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      cost_credits: 19,
      balance_credits: 100,
      affordable: true,
      catalog_revision: 'rev-1',
      model_id: 'img-1',
      normalized_settings: { aspectRatio: '1:1' },
    });
    expect(text(result)).toContain('expected_cost_credits 19');
    const [call] = vi.mocked(services.createGenerationModelQuote).mock.calls as unknown as [[{ body: Record<string, unknown>; rateLimitKey: string; platform: string }]];
    expect(call[0].body).toEqual({
      kind: 'image',
      modelId: 'img-1',
      schemaVersion: 3,
      settings: { aspectRatio: '1:1' },
      inputCounts: { images: 2, videos: undefined, audios: undefined, preparedAudios: 1, characters: undefined },
      inputMetadata: { referenceVideoDurationsSeconds: [4.5] },
      catalogRevision: 'rev-1',
    });
    expect(call[0].rateLimitKey).toBe(USER_ID);
    expect(call[0].platform).toBe('web');
  });

  it('says not affordable, with the shortfall, when the balance is short', async () => {
    const { context } = harness({ readCreditBalance: vi.fn(async () => 7) });
    const result = await tool('quote_generation').handle({ kind: 'image', model_id: 'img-1' }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({ affordable: false, balance_credits: 7, cost_credits: 19 });
    expect(text(result)).toContain('12 credits short');
  });

  it('passes the quote service\'s refusals on with stable codes', async () => {
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ status: 429, code: 'RATE_LIMITED', error: 'Too many', fieldErrors: {}, retryAfterSeconds: 33 }, 'RATE_LIMITED'],
      [{ status: 409, code: 'CATALOG_CHANGED', error: 'The catalog changed.', fieldErrors: {} }, 'CATALOG_CHANGED'],
      [{ status: 404, code: 'MODEL_UNAVAILABLE', error: 'Gone.', fieldErrors: {} }, 'NOT_FOUND'],
      [{ status: 422, code: 'INVALID_MODEL_SETTINGS', error: 'Bad settings.', fieldErrors: { aspectRatio: 'Choose one of the options.' } }, 'INVALID_REQUEST'],
      [{ status: 503, code: 'CATALOG_UNAVAILABLE', error: 'Later.', fieldErrors: {} }, 'UNAVAILABLE'],
    ];
    for (const [refusal, code] of refusals) {
      const { context } = harness({ createGenerationModelQuote: vi.fn(async () => ({ ok: false, ...refusal })) as never });
      const result = await tool('quote_generation').handle({ kind: 'image', model_id: 'img-1' }, context);
      expect(toolFailureCode(result), refusal.code as string).toBe(code);
      if (code === 'RATE_LIMITED') expect(structured(result).error).toMatchObject({ retry_after_seconds: 33 });
      if (code === 'INVALID_REQUEST') expect(structured(result).error).toMatchObject({ field_errors: refusal.fieldErrors });
    }
  });
});

describe('create_media', () => {
  const run = {
    kind: 'image' as const,
    model_id: 'img-1',
    catalog_revision: 'rev-1',
    prompt: 'a red bicycle at dawn',
    settings: { aspectRatio: '1:1' },
    inputs: [{ slot: 'references', kind: 'image' as const, url: 'https://pics.example/ref.jpg', label: 'the bike' }],
    expected_cost_credits: 19,
    idempotency_key: 'run-1',
  };

  async function startBody(services: McpToolServices): Promise<Record<string, unknown>> {
    const [input] = vi.mocked(services.postUnifiedGenerationForRoute).mock.calls[0] as unknown as [{ readRequestBody: () => Promise<unknown>; request: Request; kieApiKey?: string }];
    return await input.readRequestBody() as Record<string, unknown>;
  }

  it('refuses a run without an idempotency key, in the schema and in the handler, before anything starts', async () => {
    // Without a key every retry would be a new run and a new charge: a timed-out call may have
    // started the run, and only the same key returns it instead of starting another.
    const { idempotency_key: _omitted, ...withoutKey } = run;
    void _omitted;
    const parsed = tool('create_media').inputSchema.safeParse(withoutKey);
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('idempotency_key');
    expect(tool('create_media').inputSchema.safeParse({ ...run, idempotency_key: '' }).success).toBe(false);
    expect(tool('create_media').description).toContain('reuse the same key');

    const { context, services } = harness();
    const result = await tool('create_media').handle(withoutKey as never, context);
    expect(toolFailureCode(result)).toBe('INVALID_REQUEST');
    expect(structured(result).error).toMatchObject({ field_errors: { idempotency_key: 'Required.' } });
    expect(services.postUnifiedGenerationForRoute).not.toHaveBeenCalled();
  });

  it('starts the run through the unified start with the body the web sends, the agent\'s idempotency key, and answers the run', async () => {
    const { context, services, user, admin } = harness();
    const result = await tool('create_media').handle(run, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      generation_id: GENERATION_ID,
      prediction_id: 'pred-1',
      status: 'processing',
      cost_credits: 19,
      balance_credits: 81,
      catalog_revision: 'rev-1',
      model_id: 'img-1',
      idempotent_replay: false,
      creation_url: `${SITE}/creations?generation=${GENERATION_ID}`,
    });
    expect(text(result)).toContain(`get_generation with generation_id ${GENERATION_ID}`);

    const [input] = vi.mocked(services.postUnifiedGenerationForRoute).mock.calls[0] as unknown as [{
      request: Request; kieApiKey?: string; createUserSupabase: () => unknown; createAdminSupabase: () => unknown;
    }];
    expect(input.request).toBe(context.request);
    expect(input.kieApiKey).toBe('kie-test-key');
    expect(input.createUserSupabase()).toBe(user);
    expect(input.createAdminSupabase()).toBe(admin);
    const body = await startBody(services);
    expect(body).toMatchObject({
      kind: 'image',
      modelId: 'img-1',
      catalogRevision: 'rev-1',
      prompt: 'a red bicycle at dawn',
      settings: { aspectRatio: '1:1' },
      shots: [],
      inputs: [{ slot: 'references', kind: 'image', url: 'https://pics.example/ref.jpg', label: 'the bike', durationSeconds: null }],
      expectedCostCredits: 19,
      idempotencyKey: 'run-1',
    });
  });

  it('passes the agent\'s idempotency key through and reports a replay as one', async () => {
    const { context, services } = harness({
      postUnifiedGenerationForRoute: vi.fn(async () => ({
        ok: true,
        body: { success: true, predictionId: 'pred-1', generationId: GENERATION_ID, status: 'processing', remainingCredits: 81, cost: 19, catalogRevision: 'rev-1', modelId: 'img-1', idempotentReplay: true },
      })) as never,
    });
    const result = await tool('create_media').handle({ ...run, idempotency_key: 'agent-run-42' }, context);
    expect((await startBody(services)).idempotencyKey).toBe('agent-run-42');
    expect(structured(result).idempotent_replay).toBe(true);
    expect(text(result)).toContain('nothing new was charged');
  });

  it('answers a drifted price COST_CHANGED with the fresh quote, and starts once the agent confirms it', async () => {
    const postUnifiedGenerationForRoute = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, body: { code: 'cost_changed', error: 'The price of this run changed.' } })
      .mockResolvedValueOnce({ ok: true, body: { success: true, predictionId: 'pred-2', generationId: GENERATION_ID, status: 'processing', remainingCredits: 75, cost: 25, catalogRevision: 'rev-1', modelId: 'img-1' } });
    const createGenerationModelQuote = vi.fn(async () => ({
      ok: true,
      quote: { modelId: 'img-1', catalogRevision: 'rev-1', normalizedSettings: {}, costCredits: 25 },
    }));
    const { context } = harness({
      postUnifiedGenerationForRoute: postUnifiedGenerationForRoute as never,
      createGenerationModelQuote: createGenerationModelQuote as never,
    });

    const refused = await tool('create_media').handle(run, context);
    expect(toolFailureCode(refused)).toBe('COST_CHANGED');
    expect(structured(refused).error).toMatchObject({ expected_cost_credits: 19, cost_credits: 25 });
    expect(text(refused)).toContain('25 credits');
    expect(text(refused)).toContain('Nothing was charged');
    expect(text(refused)).toContain('expected_cost_credits 25');
    // The fresh price is quoted for the run as the agent described it.
    expect(createGenerationModelQuote).toHaveBeenCalledTimes(1);
    const [{ body }] = createGenerationModelQuote.mock.calls[0] as unknown as [{ body: Record<string, unknown> }];
    expect(body).toMatchObject({ kind: 'image', modelId: 'img-1', catalogRevision: 'rev-1', inputCounts: { images: 1 } });

    const started = await tool('create_media').handle({ ...run, expected_cost_credits: 25 }, context);
    expect(started.isError).toBeUndefined();
    expect(structured(started)).toMatchObject({ generation_id: GENERATION_ID, cost_credits: 25, balance_credits: 75 });
    const [, second] = postUnifiedGenerationForRoute.mock.calls as unknown as [unknown, [{ readRequestBody: () => Promise<Record<string, unknown>> }]];
    expect((await second[0].readRequestBody()).expectedCostCredits).toBe(25);
  });

  it('answers a reference that measured longer as COST_CHANGED with the measured lengths', async () => {
    const { context } = harness({
      postUnifiedGenerationForRoute: vi.fn(async () => ({
        ok: false,
        status: 409,
        body: {
          code: 'REFERENCE_DURATION_CHANGED',
          error: 'Your reference media runs longer than the length this price was based on.',
          costCredits: 31,
          quotedCostCredits: 19,
          inputs: [{ index: 0, slot: 'references', durationSeconds: 9.8 }],
        },
      })) as never,
    });
    const result = await tool('create_media').handle(run, context);
    expect(toolFailureCode(result)).toBe('COST_CHANGED');
    expect(structured(result).error).toMatchObject({
      expected_cost_credits: 19,
      cost_credits: 31,
      quoted_cost_credits: 19,
      measured_inputs: [{ index: 0, slot: 'references', durationSeconds: 9.8 }],
    });
  });

  it('answers a short balance with the balance and the shortfall, and never a purchase link', async () => {
    const { context } = harness({
      postUnifiedGenerationForRoute: vi.fn(async () => ({
        ok: false, status: 402, body: { code: 'insufficient_credits', error: 'Insufficient credits. This action costs 19 credits.' },
      })) as never,
      readCreditBalance: vi.fn(async () => 4),
    });
    const result = await tool('create_media').handle(run, context);
    expect(toolFailureCode(result)).toBe('INSUFFICIENT_CREDITS');
    expect(structured(result).error).toMatchObject({ balance_credits: 4, cost_credits: 19, shortfall_credits: 15 });
    const words = text(result);
    expect(words).toContain('4 credits');
    expect(words).toContain('15 credits short');
    expect(words).not.toMatch(/https?:\/\//);
    expect(words).not.toMatch(/pricing|buy|purchase|top[- ]?up|checkout/i);
  });

  it('maps the start\'s other refusals to stable codes', async () => {
    const cases: Array<[Record<string, unknown>, string, Record<string, unknown>?]> = [
      [{ ok: false, status: 429, body: { code: 'RATE_LIMITED', error: 'Too many requests.' }, rateLimitError: rateLimit(90) }, 'RATE_LIMITED', { retry_after_seconds: 90 }],
      [{ ok: false, status: 422, body: { code: 'INVALID_GENERATION_REQUEST', error: 'Invalid generation request.', fieldErrors: { 'settings.duration': 'Too long.' } } }, 'INVALID_REQUEST', { field_errors: { 'settings.duration': 'Too long.' } }],
      [{ ok: false, status: 409, body: { code: 'CATALOG_CHANGED', error: 'The catalog changed.' } }, 'CATALOG_CHANGED'],
      [{ ok: false, status: 404, body: { code: 'MODEL_UNAVAILABLE', error: 'This model is unavailable.' } }, 'NOT_FOUND'],
      [{ ok: false, status: 401, body: { code: 'UNAUTHORIZED', error: 'Unauthorized' } }, 'UNAUTHORIZED'],
      [{ ok: false, status: 503, body: { code: 'provider_unavailable', error: 'The provider is unavailable.' } }, 'UNAVAILABLE'],
      [{ ok: false, status: 500, body: { code: 'GENERATION_START_FAILED', error: 'Failed to start generation.' } }, 'UNAVAILABLE'],
      [{ ok: false, status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED', error: 'This key was used for another request.' } }, 'IDEMPOTENCY_KEY_REUSED'],
      [{ ok: false, status: 422, body: { code: 'provider_rejected', error: 'The provider could not accept this request.' } }, 'PROVIDER_REJECTED'],
    ];
    for (const [answer, code, details] of cases) {
      const { context } = harness({ postUnifiedGenerationForRoute: vi.fn(async () => answer) as never });
      const result = await tool('create_media').handle(run, context);
      expect(toolFailureCode(result), String(answer.status)).toBe(code);
      if (details) expect(structured(result).error).toMatchObject(details);
    }
  });
});

describe('get_generation', () => {
  function pollingList(statuses: string[]) {
    let statusReads = 0;
    return vi.fn(async ({ searchParams }: { searchParams: URLSearchParams }) => {
      if (searchParams.get('detail') === 'status') {
        const status = statuses[Math.min(statusReads, statuses.length - 1)];
        statusReads += 1;
        return { generations: [{ id: GENERATION_ID, status }], pagination: { limit: 80, hasMore: false, nextCursor: null } };
      }
      return { generations: [generation({ status: statuses[statuses.length - 1] })], pagination: { limit: 80, hasMore: false, nextCursor: null } };
    });
  }

  it('polls every three seconds until the run settles, then answers the outputs with both links', async () => {
    const listOwnerGenerationsForRoute = pollingList(['processing', 'processing', 'succeeded']);
    const { context, time, services } = harness({ listOwnerGenerationsForRoute: listOwnerGenerationsForRoute as never });
    const result = await tool('get_generation').handle({ generation_id: GENERATION_ID, wait_seconds: 45 }, context);
    expect(result.isError).toBeUndefined();
    expect(time.sleeps).toEqual([MCP_GENERATION_POLL_INTERVAL_MS, MCP_GENERATION_POLL_INTERVAL_MS]);
    expect(structured(result)).toMatchObject({
      generation_id: GENERATION_ID,
      status: 'succeeded',
      settled: true,
      kind: 'image',
      model_id: 'img-1',
      cost_credits: 19,
      refunded: false,
      posted: false,
      failure_reason: null,
      creation_url: `${SITE}/creations?generation=${GENERATION_ID}`,
      prompt: 'a red bicycle at dawn, film grain',
      outputs: [{
        url: 'https://cdn.magicbooklet.test/signed/output.jpg?token=abc',
        preview_url: 'https://cdn.magicbooklet.test/signed/preview.jpg?token=abc',
        kind: 'image',
        width: 1024,
        height: 1024,
        expires_at: '2026-11-09T11:00:00Z',
      }],
    });
    expect(text(result)).toContain('permanent link');
    expect(text(result)).toContain('publish_post');
    // Four reads, one rate-limit check: polls count once per call.
    expect(listOwnerGenerationsForRoute).toHaveBeenCalledTimes(4);
    expect(services.enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    const reads = listOwnerGenerationsForRoute.mock.calls.map(([input]) => Object.fromEntries(input.searchParams));
    expect(reads[0]).toEqual({ id: GENERATION_ID, detail: 'status', includeArchived: 'true' });
    expect(reads[3]).toEqual({ id: GENERATION_ID, includeArchived: 'true' });
    // A poll never fetches the preview: the picture comes only when the caller asks for it.
    expect(services.fetchImageContentBlock).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  it('carries a finished picture inline as an image block from its preview when asked, and never for a clip', async () => {
    const block = { type: 'image' as const, data: 'AAAA', mimeType: 'image/webp' };
    const picture = harness({ fetchImageContentBlock: vi.fn(async () => block) as never });
    const result = await tool('get_generation').handle({ generation_id: GENERATION_ID, include_preview: true }, picture.context);
    expect(picture.services.fetchImageContentBlock).toHaveBeenCalledWith('https://cdn.magicbooklet.test/signed/preview.jpg?token=abc');
    expect(result.content).toEqual([expect.objectContaining({ type: 'text' }), block]);
    expect(structured(result)).toMatchObject({ status: 'succeeded', outputs: [expect.objectContaining({ kind: 'image' })] });

    // Not asked for: the same finished picture answers text alone, with no fetch.
    const quiet = harness({ fetchImageContentBlock: vi.fn(async () => block) as never });
    const plain = await tool('get_generation').handle({ generation_id: GENERATION_ID }, quiet.context);
    expect(quiet.services.fetchImageContentBlock).not.toHaveBeenCalled();
    expect(plain.content).toHaveLength(1);

    const clip = harness({
      fetchImageContentBlock: vi.fn(async () => block) as never,
      listOwnerGenerationsForRoute: vi.fn(async () => ({
        generations: [generation({ category: 'video', media: { ...generation().media, kind: 'video' } })],
        pagination: { limit: 80, hasMore: false, nextCursor: null },
      })) as never,
    });
    const video = await tool('get_generation').handle({ generation_id: GENERATION_ID, include_preview: true }, clip.context);
    expect(clip.services.fetchImageContentBlock).not.toHaveBeenCalled();
    expect(video.content).toHaveLength(1);
  });

  it('stops at the wait and says the run is still going, with no outputs', async () => {
    const { context, time } = harness({ listOwnerGenerationsForRoute: pollingList(['processing']) as never });
    const result = await tool('get_generation').handle({ generation_id: GENERATION_ID, wait_seconds: 7 }, context);
    expect(result.isError).toBeUndefined();
    expect(time.sleeps).toEqual([3000, 3000, 1000]);
    expect(structured(result)).toMatchObject({ status: 'processing', settled: false, outputs: [] });
    // The suggested wait, not the cap: the cap leaves little room under the route's 60 seconds.
    expect(text(result)).toContain('wait_seconds 30');
    expect(tool('get_generation').description).toContain('30 is the suggested wait');
  });

  it('answers at once without a wait, and a failed run with its reason and refund', async () => {
    const list = vi.fn(async () => ({
      generations: [generation({ status: 'failed', error_message: 'The provider rejected the prompt.', refunded: true, media: null, output_url: null })],
      pagination: { limit: 80, hasMore: false, nextCursor: null },
    }));
    const { context, time } = harness({ listOwnerGenerationsForRoute: list as never });
    const result = await tool('get_generation').handle({ generation_id: GENERATION_ID }, context);
    expect(time.sleeps).toEqual([]);
    expect(structured(result)).toMatchObject({ status: 'failed', settled: true, refunded: true, failure_reason: 'The provider rejected the prompt.', outputs: [] });
    expect(text(result)).toContain('refunded');
  });

  it('answers NOT_FOUND for a creation that is not this creator\'s, and RATE_LIMITED when the read limit is spent', async () => {
    const missing = harness({ listOwnerGenerationsForRoute: vi.fn(async () => ({ generations: [], pagination: { limit: 80, hasMore: false, nextCursor: null } })) as never });
    expect(toolFailureCode(await tool('get_generation').handle({ generation_id: GENERATION_ID }, missing.context))).toBe('NOT_FOUND');

    const limited = harness({ enforceBackendRateLimit: vi.fn(async () => { throw rateLimit(12); }) as never });
    const result = await tool('get_generation').handle({ generation_id: GENERATION_ID }, limited.context);
    expect(toolFailureCode(result)).toBe('RATE_LIMITED');
    expect(structured(result).error).toMatchObject({ retry_after_seconds: 12 });
    expect(limited.services.listOwnerGenerationsForRoute).not.toHaveBeenCalled();
  });
});

describe('list_creations', () => {
  it('lists summaries newest first with the posted flag and a cursor', async () => {
    const list = vi.fn(async () => ({
      generations: [
        generation({ linked_post_id: POST_ID, prompt: 'x'.repeat(400) }),
        generation({ id: '44444444-4444-4444-8444-444444444444', status: 'processing', completed_at: null, cost: null }),
      ],
      pagination: { limit: 2, hasMore: true, nextCursor: '2' },
    }));
    const { context } = harness({ listOwnerGenerationsForRoute: list as never });
    const result = await tool('list_creations').handle({ limit: 2, include_archived: true }, context);
    expect(result.isError).toBeUndefined();
    const data = structured(result);
    expect(data.next_cursor).toBe('2');
    const [posted, running] = data.creations as Array<Record<string, unknown>>;
    expect(posted).toMatchObject({
      generation_id: GENERATION_ID,
      posted: true,
      post_id: POST_ID,
      // The post page is /showcase/<id>; /post/<id> is only the editor's folder.
      post_url: `${SITE}/showcase/${POST_ID}`,
      creation_url: `${SITE}/creations?generation=${GENERATION_ID}`,
      preview_url: 'https://cdn.magicbooklet.test/signed/preview.jpg?token=abc',
      cost_credits: 19,
    });
    expect((posted.prompt_excerpt as string).length).toBe(160);
    expect(running).toMatchObject({ status: 'processing', settled: false, posted: false, cost_credits: null });
    expect(Object.fromEntries((list.mock.calls[0] as unknown as [{ searchParams: URLSearchParams }])[0].searchParams))
      .toEqual({ detail: 'summary', limit: '2', includeArchived: 'true' });
    expect(text(result)).toContain('posted');
  });
});

describe('enhance_prompt', () => {
  it('rewrites through the enhancement service with the creator\'s id and a key of its own', async () => {
    const { context, services } = harness();
    const result = await tool('enhance_prompt').handle({ prompt: 'red bike', medium: 'image', model_id: 'img-1', context: { aspectRatio: '1:1' } }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({
      enhanced_prompt: 'A red bicycle leaning on a stone wall at dawn, soft film grain, 35mm.',
      original_prompt: 'red bike',
      model_id: 'img-1',
      cost_credits: 1,
      balance_credits: 99,
      quality_score: 0.9,
    });
    const [input] = vi.mocked(services.enhancePromptForUser).mock.calls[0] as unknown as [{ body: Record<string, unknown>; userId: string; request: Request }];
    expect(input.userId).toBe(USER_ID);
    expect(input.request).toBe(context.request);
    expect(input.body).toMatchObject({ prompt: 'red bike', medium: 'image', selectedModel: 'img-1', context: { aspectRatio: '1:1' } });
    expect(typeof input.body.idempotencyKey).toBe('string');
  });

  it('answers a short balance with the shortfall and an unsupported model as an invalid request', async () => {
    const short = harness({
      enhancePromptForUser: vi.fn(async () => ({ ok: false, status: 402, error: 'Insufficient credits', required: 1 })) as never,
      readCreditBalance: vi.fn(async () => 0),
    });
    const refused = await tool('enhance_prompt').handle({ prompt: 'red bike', medium: 'image', model_id: 'img-1' }, short.context);
    expect(toolFailureCode(refused)).toBe('INSUFFICIENT_CREDITS');
    expect(structured(refused).error).toMatchObject({ balance_credits: 0, cost_credits: 1, shortfall_credits: 1 });
    expect(text(refused)).not.toMatch(/https?:\/\//);

    const invalid = harness({
      enhancePromptForUser: vi.fn(async () => ({ ok: false, status: 400, error: 'Unsupported model: nope' })) as never,
    });
    expect(toolFailureCode(await tool('enhance_prompt').handle({ prompt: 'red bike', medium: 'image', model_id: 'nope' }, invalid.context))).toBe('INVALID_REQUEST');
  });
});

describe('upload_input', () => {
  it('stages a file by URL through the staging service and answers the input create_media takes', async () => {
    const { context, services, admin } = harness();
    const result = await tool('upload_input').handle({ url: 'https://cdn.example.com/a.jpg' }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      input: { url: 'https://project.supabase.test/storage/v1/object/sign/uploads/x?token=read', storage_path: `uploads/${USER_ID}/staged-agent-image.jpg` },
      kind: 'image',
      bytes: 4096,
      mime_type: 'image/jpeg',
      expires_in_seconds: 3600,
      source_url: 'https://cdn.example.com/a.jpg',
    });
    expect(text(result)).toContain('create_media.inputs[]');
    // "an image", not "a image": the answer names the staged kind with its article.
    expect(text(result)).toContain('Staged an image of 4096 bytes (image/jpeg).');
    expect(services.stageAgentInput).toHaveBeenCalledWith({ admin, userId: USER_ID, source: { url: 'https://cdn.example.com/a.jpg' } });

    await tool('upload_input').handle({ base64: 'AAAA', mime_type: 'image/png' }, context);
    expect(services.stageAgentInput).toHaveBeenLastCalledWith({ admin, userId: USER_ID, source: { base64: 'AAAA', mimeType: 'image/png' } });
    // Each call is counted against the account before any byte is fetched.
    expect(vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options)).toEqual([
      { ...AGENT_UPLOAD_INPUT_RATE_LIMIT, key: USER_ID },
      { ...AGENT_UPLOAD_INPUT_RATE_LIMIT, key: USER_ID },
    ]);
    expect(AGENT_UPLOAD_INPUT_RATE_LIMIT).toEqual({ scope: 'agent:upload-input', limit: 30, windowSeconds: 10 * 60 });
  });

  it('refuses a call over the upload limit before fetching anything', async () => {
    const { context, services } = harness({ enforceBackendRateLimit: vi.fn(async () => { throw rateLimit(12); }) as never });
    const result = await tool('upload_input').handle({ url: 'https://big.example/clip.mp4' }, context);
    expect(toolFailureCode(result)).toBe('RATE_LIMITED');
    expect(structured(result).error).toMatchObject({ retry_after_seconds: 12 });
    expect(services.stageAgentInput).not.toHaveBeenCalled();
  });

  it('refuses neither or both sources, base64 without its type, and passes the staging codes on with the next step', async () => {
    const { context, services } = harness();
    expect(toolFailureCode(await tool('upload_input').handle({}, context))).toBe('INVALID_REQUEST');
    expect(toolFailureCode(await tool('upload_input').handle({ url: 'https://x/a.jpg', base64: 'AAAA', mime_type: 'image/png' }, context))).toBe('INVALID_REQUEST');
    expect(toolFailureCode(await tool('upload_input').handle({ base64: 'AAAA' }, context))).toBe('INVALID_REQUEST');
    expect(services.stageAgentInput).not.toHaveBeenCalled();
    expect(services.enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(tool('upload_input').inputSchema.safeParse({ url: 'not a url' }).success).toBe(false);

    const refusals: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ code: 'PRIVATE_ADDRESS', message: 'Not public.', details: { host: 'db.internal' } }, 'PRIVATE_ADDRESS', /public host|base64/u],
      [{ code: 'TOO_LARGE', message: 'Too big.', details: { max_bytes: 8 } }, 'TOO_LARGE', /by url/u],
      [{ code: 'UNSUPPORTED_MEDIA', message: 'A page.' }, 'UNSUPPORTED_MEDIA', /A page/u],
      [{ code: 'RATE_LIMITED', message: 'Wait.', retryAfterSeconds: 42 }, 'RATE_LIMITED', /42 seconds/u],
      [{ code: 'UPLOAD_FAILED', message: 'Storage down.' }, 'UNAVAILABLE', /Try again/u],
      [{ code: 'ACCOUNT_DELETION_IN_PROGRESS', message: 'Deleting.' }, 'ACCOUNT_DELETION_IN_PROGRESS', /Deleting/u],
    ];
    for (const [refusal, code, words] of refusals) {
      const { context: other } = harness({ stageAgentInput: vi.fn(async () => ({ ok: false, ...refusal })) as never });
      const source = code === 'TOO_LARGE' ? { base64: 'AAAA', mime_type: 'image/png' } : { url: 'https://cdn.example.com/a.jpg' };
      const result = await tool('upload_input').handle(source, other);
      expect(toolFailureCode(result), code).toBe(code);
      expect(text(result), code).toMatch(words);
    }
  });
});

describe('publish_post', () => {
  const args = { generation_id: GENERATION_ID, title: 'Red bicycle at dawn', body: 'Made on a Sunday.' };

  async function publishBody(services: McpToolServices, call = 0): Promise<Record<string, unknown>> {
    const [input] = vi.mocked(services.publishGenerationToShowcaseForRoute).mock.calls[call] as unknown as [{ body: Record<string, unknown> }];
    return input.body;
  }

  it('publishes the creator\'s succeeded creation live, through the publish service, with the web\'s free recipe, under both limits', async () => {
    const { context, services, admin } = harness();
    const result = await tool('publish_post').handle(args, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      post_id: POST_ID,
      post_url: `${SITE}/showcase/${POST_ID}`,
      visibility: 'public',
      state: 'live',
      already_published: false,
      visibility_changed: false,
      recipe_included: true,
      recipe_status: 'published',
    });
    expect(text(result)).toMatch(/public now/u);
    expect(text(result)).toContain(`${SITE}/showcase/${POST_ID}`);

    expect(services.readCreationForPublish).toHaveBeenCalledWith(admin, { generationId: GENERATION_ID, userId: USER_ID });
    const [input] = vi.mocked(services.publishGenerationToShowcaseForRoute).mock.calls[0] as unknown as [{ adminSupabase: unknown; userId: string; dependencies: { runAfterResponse?: unknown } }];
    expect(input.adminSupabase).toBe(admin);
    expect(input.userId).toBe(USER_ID);
    expect(input.dependencies.runAfterResponse).toBe(context.runAfterResponse);
    expect(await publishBody(services)).toEqual({
      generationId: GENERATION_ID,
      visibility: 'public',
      shareInputMediaForRemix: false,
      title: 'Red bicycle at dawn',
      body: 'Made on a Sunday.',
      allowRemixes: true,
      includeGenerationReferences: true,
      resourceBundle: expect.objectContaining({ accessMode: 'free', resources: expect.objectContaining({ promptText: 'a red bicycle at dawn, film grain' }) }),
    });
    // The web's publish limit, keyed on the creator; then the agent's daily cap, read from the
    // ledger as the day's public publications rather than spent on the attempt.
    const limits = vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options);
    expect(limits).toEqual([{ ...SHOWCASE_PUBLISH_RATE_LIMIT, key: USER_ID }]);
    expect(services.countAgentPublicPublishesSince).toHaveBeenCalledWith(admin, { userId: USER_ID, since: new Date('1970-01-01T00:00:00.000Z') });
    expect(AGENT_PUBLISH_RATE_LIMIT).toEqual({ scope: 'agent:publish-public', limit: 10, windowSeconds: 24 * 60 * 60 });
  });

  it('sends the title the web\'s Publish starts from when none is given: the creation\'s own, else one from its prompt', async () => {
    const { context, services } = harness();
    const { title: _omitted, ...withoutTitle } = args;
    void _omitted;
    const result = await tool('publish_post').handle(withoutTitle, context);
    expect(result.isError).toBeUndefined();
    const suggested = getCreationPostTitleSuggestion(null, { prompt: 'a red bicycle at dawn, film grain', model: 'img-1', category: 'image', creationMode: null }, false)?.title;
    expect(typeof suggested).toBe('string');
    expect((await publishBody(services)).title).toBe(suggested);

    const own = harness({ readCreationForPublish: vi.fn(async () => creation({ title: 'The creation\'s own title' })) });
    await tool('publish_post').handle(withoutTitle, own.context);
    expect((await publishBody(own.services)).title).toBe('The creation\'s own title');
  });

  it('saves a private post without counting the daily cap, and posts the media alone with remixes off', async () => {
    const { context, services } = harness({
      publishGenerationToShowcaseForRoute: vi.fn(async () => published({ visibility: 'private', isPublic: false, resourceBundleStatus: null, message: 'Saved as a private post' })) as never,
    });
    const result = await tool('publish_post').handle({ ...args, visibility: 'private', allow_remixes: false, is_nsfw: true }, context);
    expect(structured(result)).toMatchObject({ visibility: 'private', state: 'private', already_published: false, recipe_included: false });
    expect(text(result)).toMatch(/Only the creator sees it/u);
    expect(vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options.scope)).toEqual([SHOWCASE_PUBLISH_RATE_LIMIT.scope]);
    expect(services.countAgentPublicPublishesSince).not.toHaveBeenCalled();
    expect(await publishBody(services)).toEqual({
      generationId: GENERATION_ID,
      visibility: 'private',
      shareInputMediaForRemix: false,
      title: 'Red bicycle at dawn',
      body: 'Made on a Sunday.',
      isNsfw: true,
      resourceBundle: { accessMode: 'none' },
    });
  });

  it('refuses another creator\'s, a removed and a missing creation alike (NOT_FOUND), and an unfinished or archived one (NOT_READY), before any limit is spent', async () => {
    // Another creator's creation: nothing about what exists under an id that is not the caller's.
    const other = harness({ readCreationForPublish: vi.fn(async () => creation({ userId: '99999999-9999-4999-8999-999999999999' })) });
    const notOwner = await tool('publish_post').handle(args, other.context);
    expect(toolFailureCode(notOwner)).toBe('NOT_FOUND');
    expect(other.services.publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
    expect(other.services.enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(other.services.countAgentPublicPublishesSince).not.toHaveBeenCalled();

    // An operator's removal is never republished, and not described either.
    const removed = harness({ readCreationForPublish: vi.fn(async () => creation({ moderationRemovedAt: '2026-11-09T00:00:00Z' })) });
    expect(toolFailureCode(await tool('publish_post').handle(args, removed.context))).toBe('NOT_FOUND');
    expect(removed.services.publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
    expect(removed.services.isOwnOrLinkedAccountId).not.toHaveBeenCalled();

    const archived = harness({ readCreationForPublish: vi.fn(async () => creation({ archivedAt: '2026-11-09T00:00:00Z' })) });
    const shelved = await tool('publish_post').handle(args, archived.context);
    expect(toolFailureCode(shelved)).toBe('NOT_READY');
    expect(structured(shelved).error).toMatchObject({ status: 'archived' });
    expect(archived.services.publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();

    const running = harness({ readCreationForPublish: vi.fn(async () => creation({ status: 'processing' })) });
    const notReady = await tool('publish_post').handle(args, running.context);
    expect(toolFailureCode(notReady)).toBe('NOT_READY');
    expect(structured(notReady).error).toMatchObject({ status: 'processing' });
    expect(text(notReady)).toContain('get_generation');

    const missing = harness({ readCreationForPublish: vi.fn(async () => null) });
    expect(toolFailureCode(await tool('publish_post').handle(args, missing.context))).toBe('NOT_FOUND');

    // A creation a linked guest identity made is the account's own.
    const linked = harness({
      readCreationForPublish: vi.fn(async () => creation({ userId: '99999999-9999-4999-8999-999999999999' })),
      isOwnOrLinkedAccountId: vi.fn(async () => true) as never,
    });
    expect((await tool('publish_post').handle(args, linked.context)).isError).toBeUndefined();
  });

  it('answers the daily cap RATE_LIMITED with the next UTC midnight once the day holds ten public publications, and the web limit with its wait', async () => {
    const capped = harness({ countAgentPublicPublishesSince: vi.fn(async () => 10) as never });
    const result = await tool('publish_post').handle(args, capped.context);
    expect(toolFailureCode(result)).toBe('RATE_LIMITED');
    // The clock stands at 1,000 seconds into 1970-01-01 UTC: the window ends at the next midnight.
    expect(structured(result).error).toMatchObject({ retry_after_seconds: 86_400 - 1_000, reset_at: '1970-01-02T00:00:00.000Z', limit: 10, published_today: 10 });
    expect(text(result)).toContain('10 public posts per UTC day');
    expect(text(result)).toContain('1970-01-02T00:00:00.000Z');
    expect(text(result)).toContain('visibility private');
    expect(capped.services.publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
    // Nine published today: the tenth goes through.
    const room = harness({ countAgentPublicPublishesSince: vi.fn(async () => 9) as never });
    expect((await tool('publish_post').handle(args, room.context)).isError).toBeUndefined();

    const busy = harness({ enforceBackendRateLimit: vi.fn(async () => { throw rateLimit(90); }) as never });
    const limited = await tool('publish_post').handle(args, busy.context);
    expect(toolFailureCode(limited)).toBe('RATE_LIMITED');
    expect(text(limited)).toContain('90 seconds');
    expect(busy.services.countAgentPublicPublishesSince).not.toHaveBeenCalled();
  });

  it('spends nothing of the daily cap on a publish the service refuses: the cap counts publications, from the ledger', async () => {
    const { context, services, records } = harness({
      publishGenerationToShowcaseForRoute: vi.fn(async () => ({ ok: false, status: 400, body: { error: 'Add your name and handle to publish publicly.', field: 'profile' } })) as never,
    });
    const result = await runMcpTool(tool('publish_post'), args, context);
    expect(toolFailureCode(result)).toBe('INVALID_REQUEST');
    // The cap was read, never spent: the only limiter call is the web's own, and the ledger row
    // of this call carries the refusal's code, which the count ignores.
    expect(vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options.scope)).toEqual([SHOWCASE_PUBLISH_RATE_LIMIT.scope]);
    expect(services.countAgentPublicPublishesSince).toHaveBeenCalledTimes(1);
    expect(records).toEqual([expect.objectContaining({ tool: 'publish_post', outcome: 'error', code: 'INVALID_REQUEST', generationId: GENERATION_ID, postId: null })]);
  });

  it('returns the existing post for a creation published before, with its real state, changing nothing, and changes only an explicit visibility', async () => {
    const existing = creation({ post: { id: POST_ID, visibility: 'public', state: 'live' } });
    const same = harness({ readCreationForPublish: vi.fn(async () => existing) });
    const again = await tool('publish_post').handle(args, same.context);
    expect(again.isError).toBeUndefined();
    expect(structured(again)).toEqual({ post_id: POST_ID, post_url: `${SITE}/showcase/${POST_ID}`, visibility: 'public', state: 'live', already_published: true, visibility_changed: false });
    expect(text(again)).toContain('already published');
    expect(same.services.publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
    expect(same.services.enforceBackendRateLimit).not.toHaveBeenCalled();
    expect(same.services.countAgentPublicPublishesSince).not.toHaveBeenCalled();
    // The same visibility named explicitly changes nothing either.
    expect(structured(await tool('publish_post').handle({ ...args, visibility: 'public' }, same.context))).toMatchObject({ already_published: true, visibility_changed: false });

    // A post moderation hid, or the creator archived, is not described as live.
    const hidden = harness({ readCreationForPublish: vi.fn(async () => creation({ post: { id: POST_ID, visibility: 'public', state: 'hidden' } })) });
    const described = await tool('publish_post').handle(args, hidden.context);
    expect(structured(described)).toMatchObject({ already_published: true, visibility: 'public', state: 'hidden' });
    expect(text(described)).toContain('public, but hidden');

    const flip = harness({
      readCreationForPublish: vi.fn(async () => existing),
      publishGenerationToShowcaseForRoute: vi.fn(async () => published({ visibility: 'private', isPublic: false })) as never,
    });
    const madePrivate = await tool('publish_post').handle({ ...args, visibility: 'private' }, flip.context);
    expect(structured(madePrivate)).toEqual({ post_id: POST_ID, post_url: `${SITE}/showcase/${POST_ID}`, visibility: 'private', state: 'private', already_published: true, visibility_changed: true });
    // A visibility change alone: no text, no recipe, so the stored post is carried forward as it is.
    expect(await publishBody(flip.services)).toEqual({ generationId: GENERATION_ID, visibility: 'private' });
    // Going private counts no public post.
    expect(vi.mocked(flip.services.enforceBackendRateLimit).mock.calls.map(([, options]) => options.scope)).toEqual([SHOWCASE_PUBLISH_RATE_LIMIT.scope]);
    expect(flip.services.countAgentPublicPublishesSince).not.toHaveBeenCalled();

    const open = harness({ readCreationForPublish: vi.fn(async () => creation({ post: { id: POST_ID, visibility: 'private', state: 'private' } })) });
    const madePublic = await tool('publish_post').handle({ ...args, visibility: 'public' }, open.context);
    expect(structured(madePublic)).toMatchObject({ visibility: 'public', state: 'live', already_published: true, visibility_changed: true });
    // Going public is a public publication: the day's count is read.
    expect(vi.mocked(open.services.enforceBackendRateLimit).mock.calls.map(([, options]) => options.scope)).toEqual([SHOWCASE_PUBLISH_RATE_LIMIT.scope]);
    expect(open.services.countAgentPublicPublishesSince).toHaveBeenCalledTimes(1);
  });

  it('maps the publish service\'s refusals to stable codes with the next step', async () => {
    const cases: Array<[Record<string, unknown>, string, RegExp?]> = [
      // The service's own refusals of another's or a missing creation answer alike, disclosing nothing.
      [{ status: 403, body: { error: 'Unauthorized: You do not own this creation' } }, 'NOT_FOUND'],
      [{ status: 404, body: { error: 'Generation not found' } }, 'NOT_FOUND'],
      [{ status: 400, body: { error: 'Cannot publish a generation that has not succeeded' } }, 'NOT_READY'],
      [{ status: 400, body: { error: 'This creation has no media to publish yet' } }, 'NOT_READY'],
      [{ status: 400, body: { error: 'Add a title for your post.', field: 'title' } }, 'INVALID_REQUEST'],
      [{ status: 400, body: { error: 'A recipe needs a title of at least 6 characters.', field: 'title', code: 'RECIPE_TITLE_TOO_SHORT' } }, 'INVALID_REQUEST'],
      [{ status: 400, body: { error: 'Share the recipe or post without one.', code: 'CREATION_RECIPE_REQUIRED', field: 'resourceBundle' } }, 'INVALID_REQUEST', /allow_remixes false/u],
      [{ status: 409, body: { error: 'People have already unlocked this recipe.', code: 'RESOURCE_BUNDLE_LOCKED' } }, 'CONFLICT'],
      [{ status: 500, body: { error: 'Failed to sync showcase post' } }, 'UNAVAILABLE'],
    ];
    for (const [answer, code, words] of cases) {
      const { context } = harness({ publishGenerationToShowcaseForRoute: vi.fn(async () => ({ ok: false, ...answer })) as never });
      const result = await tool('publish_post').handle(args, context);
      expect(toolFailureCode(result), JSON.stringify(answer)).toBe(code);
      if (words) expect(text(result)).toMatch(words);
      if (code === 'INVALID_REQUEST' && (answer.body as { field?: string }).field === 'title') {
        expect(structured(result).error).toMatchObject({ field_errors: { title: expect.any(String) } });
      }
    }
  });
});

describe('get_post', () => {
  it('reads a post through the agent read, with its state, link and the page\'s counts', async () => {
    const { context, services, admin } = harness();
    const result = await tool('get_post').handle({ post_id: POST_ID }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      post_id: POST_ID,
      post_url: `${SITE}/showcase/${POST_ID}`,
      generation_id: GENERATION_ID,
      title: 'Red bicycle',
      description: null,
      body: null,
      category: 'image',
      visibility: 'public',
      state: 'live',
      is_nsfw: false,
      allow_remixes: true,
      counts: { saves: 3, comments: 1, remixes: 0, shares: 2 },
      created_at: '2026-11-09T10:00:00Z',
      is_own: true,
    });
    expect(text(result)).toContain('3 saves, 1 comment, 0 remixes, 2 shares');
    expect(services.readPostForAgent).toHaveBeenCalledWith(admin, { postId: POST_ID, viewerUserId: USER_ID });

    const hidden = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ state: 'hidden', visibility: 'public' }) })) as never });
    expect(text(await tool('get_post').handle({ post_id: POST_ID }, hidden.context))).toContain('hidden by moderation');
  });

  it('answers NOT_FOUND for a post the agent may not see, and UNAVAILABLE for a failed read', async () => {
    const missing = harness({ readPostForAgent: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })) as never });
    expect(toolFailureCode(await tool('get_post').handle({ post_id: POST_ID }, missing.context))).toBe('NOT_FOUND');
    const down = harness({ readPostForAgent: vi.fn(async () => ({ ok: false, code: 'UNAVAILABLE' })) as never });
    expect(toolFailureCode(await tool('get_post').handle({ post_id: POST_ID }, down.context))).toBe('UNAVAILABLE');
  });

  it('reads under the library limit, as every read does', async () => {
    const { context, services } = harness();
    await tool('get_post').handle({ post_id: POST_ID }, context);
    expect(vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options.scope)).toEqual(['owner-generations:read']);

    const limited = harness({ enforceBackendRateLimit: vi.fn(async () => { throw rateLimit(12); }) as never });
    const result = await tool('get_post').handle({ post_id: POST_ID }, limited.context);
    expect(toolFailureCode(result)).toBe('RATE_LIMITED');
    expect(limited.services.readPostForAgent).not.toHaveBeenCalled();
  });
});

describe('delete_post', () => {
  it('deletes the creator\'s own post through the delete service, without force unless asked', async () => {
    const { context, services, admin } = harness();
    const result = await tool('delete_post').handle({ post_id: POST_ID }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({ post_id: POST_ID, deleted: true, tombstoned: false });
    expect(services.deleteOwnerPostForRoute).toHaveBeenCalledWith({ adminSupabase: admin, ownerUserId: USER_ID, postId: POST_ID, forceDelete: false });

    await tool('delete_post').handle({ post_id: POST_ID, force: true }, context);
    expect(services.deleteOwnerPostForRoute).toHaveBeenLastCalledWith(expect.objectContaining({ forceDelete: true }));
  });

  it('refuses another creator\'s post (NOT_OWNER), one the agent may not see (NOT_FOUND), and asks before taking a post with buyers down', async () => {
    const other = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ isOwn: false, ownerUserId: '99999999-9999-4999-8999-999999999999' }) })) as never });
    expect(toolFailureCode(await tool('delete_post').handle({ post_id: POST_ID }, other.context))).toBe('NOT_OWNER');
    expect(other.services.deleteOwnerPostForRoute).not.toHaveBeenCalled();

    const missing = harness({ readPostForAgent: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })) as never });
    expect(toolFailureCode(await tool('delete_post').handle({ post_id: POST_ID }, missing.context))).toBe('NOT_FOUND');

    const buyers = harness({
      deleteOwnerPostForRoute: vi.fn(async () => ({ ok: false, status: 409, body: { error: 'People have already unlocked this post.', requiresForceDelete: true } })) as never,
    });
    const refused = await tool('delete_post').handle({ post_id: POST_ID }, buyers.context);
    expect(toolFailureCode(refused)).toBe('POST_HAS_BUYERS');
    expect(text(refused)).toContain('force true');

    const tombstoned = harness({ deleteOwnerPostForRoute: vi.fn(async () => ({ ok: true, body: { success: true, deleted: true, tombstoned: true } })) as never });
    const result = await tool('delete_post').handle({ post_id: POST_ID, force: true }, tombstoned.context);
    expect(structured(result)).toMatchObject({ deleted: true, tombstoned: true });
    expect(text(result)).toContain('keep their copy');

    const limited = harness({
      deleteOwnerPostForRoute: vi.fn(async () => ({ ok: false, status: 429, rateLimitError: rateLimit(30), body: { error: 'Too many', code: 'RATE_LIMITED', retryAfterSeconds: 30, limit: 60, resetAt: 'x' } })) as never,
    });
    expect(structured(await tool('delete_post').handle({ post_id: POST_ID }, limited.context)).error).toMatchObject({ code: 'RATE_LIMITED', retry_after_seconds: 30 });
  });
});

describe('running a tool', () => {
  it('records the creation and the post a call was about, from its answer or its arguments', async () => {
    const { context, records } = harness();
    await runMcpTool(tool('publish_post'), { generation_id: GENERATION_ID, title: 'Red bicycle at dawn' }, context);
    expect(records[0]).toEqual(expect.objectContaining({ tool: 'publish_post', outcome: 'ok', code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PUBLIC, generationId: GENERATION_ID, postId: POST_ID, costCredits: null }));
    await runMcpTool(tool('get_post'), { post_id: POST_ID }, context);
    expect(records[1]).toEqual(expect.objectContaining({ tool: 'get_post', outcome: 'ok', code: null, generationId: GENERATION_ID, postId: POST_ID }));

    const missing = harness({ readPostForAgent: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })) as never });
    await runMcpTool(tool('delete_post'), { post_id: POST_ID }, missing.context);
    // A refusal names the post it was asked about, from the arguments.
    expect(missing.records[0]).toEqual(expect.objectContaining({ tool: 'delete_post', outcome: 'error', code: 'NOT_FOUND', postId: POST_ID, generationId: null }));
    // An argument that is not a UUID is no id.
    await runMcpTool(tool('get_post'), { post_id: 'not-a-uuid' }, missing.context);
    expect(missing.records[1]).toEqual(expect.objectContaining({ postId: null }));
  });

  it('records which answer a publish gave, and names a post only where the agent made or changed one', async () => {
    const publish = { generation_id: GENERATION_ID, title: 'Red bicycle at dawn' };
    // A republish that changed nothing: the post was the creator's doing, not the agent's.
    const unchanged = harness({ readCreationForPublish: vi.fn(async () => creation({ post: { id: POST_ID, visibility: 'public', state: 'live' } })) });
    await runMcpTool(tool('publish_post'), publish, unchanged.context);
    expect(unchanged.records[0]).toEqual(expect.objectContaining({ outcome: 'ok', code: AGENT_PUBLISH_RECORD_CODES.ALREADY_PUBLISHED, postId: null, generationId: GENERATION_ID }));

    const madePrivate = harness({
      readCreationForPublish: vi.fn(async () => creation({ post: { id: POST_ID, visibility: 'public', state: 'live' } })),
      publishGenerationToShowcaseForRoute: vi.fn(async () => published({ visibility: 'private', isPublic: false })) as never,
    });
    await runMcpTool(tool('publish_post'), { ...publish, visibility: 'private' }, madePrivate.context);
    expect(madePrivate.records[0]).toEqual(expect.objectContaining({ code: AGENT_PUBLISH_RECORD_CODES.MADE_PRIVATE, postId: POST_ID }));

    const madePublic = harness({ readCreationForPublish: vi.fn(async () => creation({ post: { id: POST_ID, visibility: 'private', state: 'private' } })) });
    await runMcpTool(tool('publish_post'), { ...publish, visibility: 'public' }, madePublic.context);
    expect(madePublic.records[0]).toEqual(expect.objectContaining({ code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PUBLIC, postId: POST_ID }));

    const privately = harness({
      publishGenerationToShowcaseForRoute: vi.fn(async () => published({ visibility: 'private', isPublic: false, resourceBundleStatus: null })) as never,
    });
    await runMcpTool(tool('publish_post'), { ...publish, visibility: 'private' }, privately.context);
    expect(privately.records[0]).toEqual(expect.objectContaining({ code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PRIVATE, postId: POST_ID }));
  });

  it('records one call with its outcome and code, a cost only where the creator was charged, and turns a thrown error into an INTERNAL_ERROR result', async () => {
    const { context, records } = harness();
    // A quote's cost_credits is a price, not a charge: the log must not count it as spend.
    await runMcpTool(tool('quote_generation'), { kind: 'image', model_id: 'img-1' }, context);
    expect(records).toEqual([expect.objectContaining({ tool: 'quote_generation', outcome: 'ok', code: null, costCredits: null, generationId: null, postId: null })]);
    await runMcpTool(tool('create_media'), {
      kind: 'image', model_id: 'img-1', catalog_revision: 'rev-1', prompt: 'a red bicycle', expected_cost_credits: 19, idempotency_key: 'run-7',
    }, context);
    expect(records[1]).toEqual(expect.objectContaining({ tool: 'create_media', outcome: 'ok', costCredits: 19, generationId: GENERATION_ID }));
    await runMcpTool(tool('enhance_prompt'), { prompt: 'red bike', medium: 'image', model_id: 'img-1' }, context);
    expect(records[2]).toEqual(expect.objectContaining({ tool: 'enhance_prompt', outcome: 'ok', costCredits: 1 }));

    // A replay answers the run started under the same key; its cost was logged by the first call.
    const replayed = harness({
      postUnifiedGenerationForRoute: vi.fn(async () => ({
        ok: true,
        body: { success: true, predictionId: 'pred-1', generationId: GENERATION_ID, status: 'processing', remainingCredits: 81, cost: 19, catalogRevision: 'rev-1', modelId: 'img-1', idempotentReplay: true },
      })) as never,
    });
    await runMcpTool(tool('create_media'), {
      kind: 'image', model_id: 'img-1', catalog_revision: 'rev-1', prompt: 'a red bicycle', expected_cost_credits: 19, idempotency_key: 'run-7',
    }, replayed.context);
    expect(replayed.records).toEqual([expect.objectContaining({ tool: 'create_media', outcome: 'ok', costCredits: null })]);

    const broken = harness({ readModelCatalogCurrent: vi.fn(async () => { throw new Error('rpc down'); }) });
    await runMcpTool(tool('list_models'), {}, broken.context);
    expect(broken.records).toEqual([expect.objectContaining({ tool: 'list_models', outcome: 'error', code: 'UNAVAILABLE', costCredits: null })]);

    const throwing: McpToolDefinition = { ...tool('list_models'), handle: async () => { throw new Error('boom'); } };
    const { context: other, records: thrown } = harness();
    const result = await runMcpTool(throwing, {}, other);
    expect(result.isError).toBe(true);
    expect(toolFailureCode(result)).toBe('INTERNAL_ERROR');
    expect(thrown).toEqual([expect.objectContaining({ tool: 'list_models', outcome: 'threw', code: 'INTERNAL_ERROR', error: expect.any(Error) })]);
  });
});

describe('tool results', () => {
  it('carries structured content beside a text block, and a failure its code', () => {
    const ok = toolSuccess('Done.', { a: 1 });
    expect(ok).toEqual({ content: [{ type: 'text', text: 'Done.' }], structuredContent: { a: 1 } });
    const failed = toolFailure('RATE_LIMITED', 'Wait.', { retry_after_seconds: 5 });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([{ type: 'text', text: 'RATE_LIMITED: Wait.' }]);
    expect(failed.structuredContent).toEqual({ error: { code: 'RATE_LIMITED', message: 'Wait.', retry_after_seconds: 5 } });
    expect(toolFailureCode(failed)).toBe('RATE_LIMITED');
    expect(toolFailureCode(ok)).toBeNull();
  });

  it('holds every result under the character cap', () => {
    const huge = 'x'.repeat(MCP_RESULT_CHARACTER_CAP + 5_000);
    const result = toolSuccess(huge, { rows: Array.from({ length: 2_000 }, (_, index) => ({ index, text: 'y'.repeat(80) })) });
    const [block] = result.content;
    expect(block.type === 'text' && block.text.length).toBeLessThanOrEqual(MCP_RESULT_CHARACTER_CAP);
    expect(block.type === 'text' && block.text.endsWith('ask for a smaller page]')).toBe(true);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(MCP_RESULT_CHARACTER_CAP);
    expect(result.structuredContent).toMatchObject({ truncated: true });

    const small = capToolResult(toolSuccess('ok', { rows: [1, 2, 3] }));
    expect(small.structuredContent).toEqual({ rows: [1, 2, 3] });
  });
});
