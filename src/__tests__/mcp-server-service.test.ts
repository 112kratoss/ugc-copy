import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  MCP_GENERATION_POLL_INTERVAL_MS,
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOLS,
  createMcpServer,
  registerMcpTools,
  runMcpTool,
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
    enforceBackendRateLimit: vi.fn(async () => undefined) as unknown as McpToolServices['enforceBackendRateLimit'],
    readCreditBalance: vi.fn(async () => 100),
    promptEnhancementCost: () => 1,
    sleep: time.sleep,
    now: time.now,
    ...overrides,
  };
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
  };
  return { context, services, records, time, admin, user };
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
      'list_models', 'get_model', 'quote_generation', 'create_media', 'get_generation', 'list_creations', 'enhance_prompt',
    ]);
    for (const entry of MCP_TOOLS) {
      expect(entry.title.length, entry.name).toBeGreaterThan(3);
      // A description says when to call the tool and what to do with the answer, so it names
      // at least one other tool or the person the agent works for.
      expect(entry.description.length, entry.name).toBeGreaterThan(120);
      expect(entry.description, entry.name).toMatch(/list_models|get_model|quote_generation|create_media|get_generation|list_creations|the person/);
      expect(entry.inputSchema, entry.name).toBeInstanceOf(z.ZodObject);
      expect(typeof entry.annotations.readOnlyHint, entry.name).toBe('boolean');
      expect(entry.annotations.openWorldHint, entry.name).toBe(false);
    }
    const readOnly = MCP_TOOLS.filter((entry) => entry.annotations.readOnlyHint).map((entry) => entry.name);
    expect(readOnly).toEqual(['list_models', 'get_model', 'quote_generation', 'get_generation', 'list_creations']);
    // Spends credits: asked about by clients that prompt on destructive tools.
    expect(tool('create_media').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    // Spends a credit too, so not read-only, but creates nothing lasting.
    expect(tool('enhance_prompt').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
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
  };

  async function startBody(services: McpToolServices): Promise<Record<string, unknown>> {
    const [input] = vi.mocked(services.postUnifiedGenerationForRoute).mock.calls[0] as unknown as [{ readRequestBody: () => Promise<unknown>; request: Request; kieApiKey?: string }];
    return await input.readRequestBody() as Record<string, unknown>;
  }

  it('starts the run through the unified start with the body the web sends, a minted idempotency key, and answers the run', async () => {
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
    });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
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
    // Four reads, one rate-limit check: polls count once per call.
    expect(listOwnerGenerationsForRoute).toHaveBeenCalledTimes(4);
    expect(services.enforceBackendRateLimit).toHaveBeenCalledTimes(1);
    const reads = listOwnerGenerationsForRoute.mock.calls.map(([input]) => Object.fromEntries(input.searchParams));
    expect(reads[0]).toEqual({ id: GENERATION_ID, detail: 'status', includeArchived: 'true' });
    expect(reads[3]).toEqual({ id: GENERATION_ID, includeArchived: 'true' });
  });

  it('stops at the wait and says the run is still going, with no outputs', async () => {
    const { context, time } = harness({ listOwnerGenerationsForRoute: pollingList(['processing']) as never });
    const result = await tool('get_generation').handle({ generation_id: GENERATION_ID, wait_seconds: 7 }, context);
    expect(result.isError).toBeUndefined();
    expect(time.sleeps).toEqual([3000, 3000, 1000]);
    expect(structured(result)).toMatchObject({ status: 'processing', settled: false, outputs: [] });
    expect(text(result)).toContain('wait_seconds 45');
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
      post_url: `${SITE}/post/${POST_ID}`,
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

describe('running a tool', () => {
  it('records one call with its outcome, code and cost, and turns a thrown error into an INTERNAL_ERROR result', async () => {
    const { context, records } = harness();
    await runMcpTool(tool('quote_generation'), { kind: 'image', model_id: 'img-1' }, context);
    expect(records).toEqual([expect.objectContaining({ tool: 'quote_generation', outcome: 'ok', code: null, costCredits: 19 })]);

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
