import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { AgentStagedUpload } from '@/lib/agent-input-upload';
import { AGENT_POST_NO_RESOURCE, type AgentPostResource, type AgentPostView } from '@/lib/agent-post-read';
import { AGENT_RECIPE_PREVIEW, AGENT_RECIPE_SUMMARY, agentRecipeBundle } from '@/lib/agent-publish-request';
import { AGENT_PUBLISH_RECORD_CODES } from '@/lib/agent-tool-calls';
import {
  AGENT_MADE_WITH_APP_REFUSAL,
  AGENT_RESOURCE_CARDS_MAX,
  agentTextPostId,
  agentUploadPostId,
  buildAgentResourceBundle,
} from '@/lib/agent-upload-publish-request';
import {
  AGENT_PUBLISH_RATE_LIMIT,
  AGENT_UPLOAD_INPUT_RATE_LIMIT,
  BackendRateLimitError,
  SHOWCASE_PUBLISH_RATE_LIMIT,
} from '@/lib/backend-rate-limit';
import { getCreationPostTitleSuggestion } from '@/lib/creation-post-title';
import {
  MCP_GENERATION_POLL_INTERVAL_MS,
  MCP_ROUTE_MAX_DURATION_SECONDS,
  MCP_SERVER_INSTRUCTIONS,
  MCP_SERVER_VERSION,
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
import { preparePostCreationSubmission } from '@/lib/post-creation-submission-service';
import { MAX_POST_MEDIA_ITEMS } from '@/lib/post-media';

const SITE = 'https://magicbooklet.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const GENERATION_ID = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';
const UPLOAD_ID = '55555555-5555-4555-8555-555555555555';
/** Two files an agent staged with upload_input: the paths its answers named. */
const STAGED_PICTURE = `uploads/${USER_ID}/${UPLOAD_ID}-paper-fox.png`;
const STAGED_CLIP = `uploads/${USER_ID}/66666666-6666-4666-8666-666666666666-fox-run.mp4`;
const UPLOAD_URL = `https://project.supabase.test/storage/v1/object/upload/sign/${STAGED_PICTURE}?token=signed`;

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
    source: 'creation',
    format: 'media',
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
    resource: AGENT_POST_NO_RESOURCE,
    ...overrides,
  };
}

/** The three fields every post answer carries for a post with no resource. */
const NO_RESOURCE_FIELDS = { resource_access: 'none', resource_price_tokens: 0, resource_status: null };
const FREE_RECIPE: AgentPostResource = { access: 'free', priceTokens: 0, status: 'published' };
/** Nothing an answer says may be what a resource holds, or a way to the website's own pages for it. */
const RESOURCE_CONTENT_KEYS = /"(?:items|sections|cards|resources|text|textContent|text_content|promptText|prompt_text|externalUrl|external_url|url|summary|previewText|preview_text|resource_summary|resource_preview)"\s*:/u;

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
    // The composer's create, as it answers: the post under the id it was given, at the visibility the form asked for.
    createOwnerPostForRoute: vi.fn(async ({ readFormData, createPostId }: { readFormData: () => Promise<FormData>; createPostId?: () => string }) => {
      const form = await readFormData();
      const postId = createPostId ? createPostId() : POST_ID;
      const visibility = form.get('visibility') === 'private' ? 'private' as const : 'public' as const;
      return {
        ok: true as const,
        body: {
          success: true as const,
          postId,
          visibility,
          showcasePath: visibility === 'private' ? null : `/showcase/${postId}`,
          ownerPath: `/post/${postId}/edit`,
          resourceBundlePath: `/post/${postId}/edit#recipe`,
          resourceBundleStatus: null,
        },
      };
    }) as unknown as McpToolServices['createOwnerPostForRoute'],
    updateOwnerPostForRoute: vi.fn(async ({ postId, body }: { postId: string; body: { visibility?: unknown } }) => ({
      ok: true as const,
      body: {
        success: true as const,
        postId,
        visibility: body.visibility === 'private' ? 'private' as const : 'public' as const,
        showcasePath: body.visibility === 'private' ? null : `/showcase/${postId}`,
        ownerPath: `/post/${postId}/edit`,
        resourceBundlePath: `/post/${postId}/edit#recipe`,
        resourceBundleStatus: null,
      },
    })) as unknown as McpToolServices['updateOwnerPostForRoute'],
    deleteOwnerPostForRoute: vi.fn(async () => ({ ok: true as const, body: { success: true as const, deleted: true as const } })) as unknown as McpToolServices['deleteOwnerPostForRoute'],
    readPostForAgent: vi.fn(async () => ({ ok: true as const, post: post() })) as unknown as McpToolServices['readPostForAgent'],
    // A post holds every file it was published with unless a test says otherwise.
    countPostMediaForAgent: vi.fn(async () => MAX_POST_MEDIA_ITEMS) as unknown as McpToolServices['countPostMediaForAgent'],
    stageAgentInput: vi.fn(async () => ({
      ok: true as const,
      input: { url: 'https://project.supabase.test/storage/v1/object/sign/uploads/x?token=read', storagePath: `uploads/${USER_ID}/staged-agent-image.jpg` },
      kind: 'image' as const,
      bytes: 4096,
      mimeType: 'image/jpeg',
      expiresInSeconds: 3600,
      sourceUrl: 'https://cdn.example.com/a.jpg',
    })) as unknown as McpToolServices['stageAgentInput'],
    requestAgentUpload: vi.fn(async () => ({
      ok: true as const,
      uploadId: UPLOAD_ID,
      uploadUrl: UPLOAD_URL,
      headers: { 'content-type': 'image/png', 'x-upsert': 'false' as const, 'cache-control': 'max-age=86400' },
      storagePath: STAGED_PICTURE,
      kind: 'image' as const,
      mimeType: 'image/png',
      sizeBytes: 204_800,
      expiresInSeconds: 7200,
      maxBytes: 25 * 1024 * 1024,
    })) as unknown as McpToolServices['requestAgentUpload'],
    // Every path named is a file the caller staged through upload_input and has not used.
    readAgentStagedUploads: vi.fn(async (_admin: unknown, { storagePaths }: { storagePaths: readonly string[] }) => ({
      ok: true as const,
      uploads: new Map<string, AgentStagedUpload>(storagePaths.map((storagePath) => [
        storagePath,
        { kind: 'staged', status: 'finalized', contentType: storagePath.endsWith('.mp4') ? 'video/mp4' : 'image/png' },
      ])),
    })) as unknown as McpToolServices['readAgentStagedUploads'],
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
    // Twelve tools since phase 4 added request_upload, and the registry entry versions with them.
    expect(MCP_TOOLS.map((entry) => entry.name)).toEqual([
      'list_models', 'get_model', 'quote_generation', 'upload_input', 'request_upload', 'create_media', 'get_generation', 'list_creations',
      'publish_post', 'get_post', 'delete_post', 'enhance_prompt',
    ]);
    expect(MCP_TOOLS).toHaveLength(12);
    expect(MCP_SERVER_VERSION).toBe('1.2.0');
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

    // A local file's upload is reserved here and sent by the agent itself: not read-only, nothing
    // destroyed, and this server reaches nothing outside Magicbooklet for it.
    expect(tool('request_upload').annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(tool('request_upload').description).toContain('25 MB for a picture, 50 MB for a clip, 50 MB for a track');
    expect(tool('request_upload').description).toContain('upload_input with the upload_id');
    // It does not overclaim for a client with no shell: that one stages by link.
    expect(tool('request_upload').description).toMatch(/no shell stages by link instead: upload_input with url/u);
    // A staged file feeds a run or becomes a post: said where an agent stages it and where it creates.
    expect(tool('upload_input').description).toContain('create_media.inputs[]');
    expect(tool('upload_input').description).toContain('publish_post.uploads[]');
    expect(tool('upload_input').description).toContain('upload_id');
    expect(tool('create_media').description).toContain('publish_post.uploads[]');
    // A post has three sources, and one made from uploads says what made its media.
    const publishDescription = tool('publish_post').description;
    expect(publishDescription).toMatch(/from one of three sources/u);
    expect(publishDescription).toMatch(/generation_id: one of the creator's finished creations made here/u);
    expect(publishDescription).toMatch(/uploads: media made elsewhere/u);
    expect(publishDescription).toMatch(/Neither of them: a text post, of a title and a body/u);
    expect(publishDescription).toMatch(/made_with, which names what made the media/u);
    expect(publishDescription).toMatch(/never Magic Booklet/u);
    // A text post's limits are the composer's, said where the agent reads them.
    expect(publishDescription).toContain('A text post needs title (at most 100 characters) and body (at most 2000); description takes 1000');
    // A resource: what it is, its bounds, what people see before they unlock it, and no files.
    expect(publishDescription).toContain(`resources, on a text post or an upload post, is how a prompt, a guide or a skill is shared: 1 to ${AGENT_RESOURCE_CARDS_MAX} cards`);
    expect(publishDescription).toContain('Text and links only: no files.');
    expect(publishDescription).toContain('a title (at most 80) and an optional description (120)');
    expect(publishDescription).toContain('resource_summary and resource_preview (180 characters each)');
    // A card's title is public; its description is not (the locked preview carries titles only),
    // so the description is no selling line (PR #751's review, finding 13).
    expect(publishDescription).toMatch(/Everyone sees each card's title and the resource's resource_summary and resource_preview .* before they unlock it or pay; a card's description, text and link only after, so what sells the resource goes in the preview\./u);
    expect(publishDescription).not.toMatch(/title and description/u);
    const cardShape = (tool('publish_post').inputSchema.shape as unknown as { resources: { unwrap: () => { element: { shape: Record<string, { description?: string }> } } } }).resources.unwrap().element.shape;
    expect(cardShape.title.description).toContain('Shown to everyone.');
    expect(cardShape.description.description).toContain('Shown once unlocked');
    expect(cardShape.description.description).not.toContain('Shown to everyone');
    expect(publishDescription).toMatch(/Refused with generation_id, whose resource is the creation's own recipe\./u);
    // A price: the rate, the rule, whom buyers pay, when it is on sale, and the person's yes.
    expect(publishDescription).toContain('a whole number of tokens, 10 or more in steps of 10, where 100 tokens = $1.00');
    expect(publishDescription).toContain('It prices the cards, or with generation_id the creation\'s recipe.');
    expect(publishDescription).toContain('Buyers pay the creator as they do on the site, and a resource is on sale only once its post is public: on a private post it is a draft.');
    expect(publishDescription).toContain('State the price to the person and get their yes before publishing a paid resource; never choose a price yourself.');
    expect(publishDescription).toContain('A price or a resource is changed on the website after publishing, not by this tool.');
    expect(publishDescription).toContain('its resource and price included');
    expect(publishDescription).toContain('resource_access (none, free or paid), resource_price_tokens and resource_status');
    expect(tool('get_post').description).toContain('null for a post made from uploads and for a text post');
    expect(tool('get_post').description).toContain('What a resource holds is never returned');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('request_upload');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('made_with');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('Flow for a text post, or for sharing a prompt, a guide or a skill');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('get their yes before publishing, and never choose a price yourself');

    // The schema says the composer's own limits up front: one to five files, one to five tools.
    const publish = tool('publish_post').inputSchema;
    const upload = { storage_path: STAGED_PICTURE };
    expect(publish.safeParse({ generation_id: GENERATION_ID }).success).toBe(true);
    expect(publish.safeParse({ uploads: [upload], title: 'A paper fox', made_with: [{ tool: 'Midjourney', model: 'v7' }] }).success).toBe(true);
    expect(publish.safeParse({ uploads: [] }).success).toBe(false);
    expect(MAX_POST_MEDIA_ITEMS).toBe(5);
    expect(publish.safeParse({ uploads: Array.from({ length: MAX_POST_MEDIA_ITEMS }, () => upload) }).success).toBe(true);
    expect(publish.safeParse({ uploads: Array.from({ length: MAX_POST_MEDIA_ITEMS + 1 }, () => upload) }).success).toBe(false);
    expect(publish.safeParse({ uploads: [upload], made_with: Array.from({ length: 6 }, () => ({ tool: 'Midjourney' })) }).success).toBe(false);
    expect(publish.safeParse({ uploads: [upload], made_with: [{ tool: 'x'.repeat(81) }] }).success).toBe(false);
    expect(tool('upload_input').inputSchema.safeParse({ upload_id: 'not-a-uuid' }).success).toBe(false);
    expect(tool('upload_input').inputSchema.safeParse({ upload_id: UPLOAD_ID }).success).toBe(true);

    // The route may run as long as the composer's own, and the tool's sense of "still being saved" is that limit.
    expect(MCP_ROUTE_MAX_DURATION_SECONDS).toBe(300);
    // Next reads the route's limit as a literal: it is held to the constant here, and to the composer route's own.
    expect(readFileSync(path.join(process.cwd(), 'src/app/api/mcp/route.ts'), 'utf8')).toContain(`export const maxDuration = ${MCP_ROUTE_MAX_DURATION_SECONDS};`);
    expect(readFileSync(path.join(process.cwd(), 'src/app/api/posts/route.ts'), 'utf8')).toContain(`export const maxDuration = ${MCP_ROUTE_MAX_DURATION_SECONDS};`);

    // A text post is a title and a body, at the composer's lengths.
    const textPost = { title: 'A prompt for product shots', body: 'Three lines that work.' };
    expect(publish.safeParse(textPost).success).toBe(true);
    expect(publish.safeParse({ ...textPost, body: 'x'.repeat(2000) }).success).toBe(true);
    expect(publish.safeParse({ ...textPost, body: 'x'.repeat(2001) }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, title: 't'.repeat(101) }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, description: 'd'.repeat(1001) }).success).toBe(false);

    // A resource is 1 to 10 cards of a type the tool knows, inside the bounds the description names.
    const card = { type: 'guide', title: 'Studio-shot skill', text: '# Studio shots' };
    expect(publish.safeParse({ ...textPost, resources: [card] }).success).toBe(true);
    expect(publish.safeParse({ ...textPost, resources: [{ type: 'external_link', title: 'Docs', url: 'https://example.com/docs', description: 'The reference.' }] }).success).toBe(true);
    expect(publish.safeParse({ ...textPost, resources: [] }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, resources: Array.from({ length: AGENT_RESOURCE_CARDS_MAX }, () => card) }).success).toBe(true);
    expect(publish.safeParse({ ...textPost, resources: Array.from({ length: AGENT_RESOURCE_CARDS_MAX + 1 }, () => card) }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, resources: [{ ...card, type: 'workflow' }] }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, resources: [{ ...card, title: 't'.repeat(81) }] }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, resources: [{ ...card, description: 'd'.repeat(121) }] }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, resources: [{ ...card, text: 'x'.repeat(50_001) }] }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, resources: [card], resource_summary: 's'.repeat(181) }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, resources: [card], resource_preview: 'p'.repeat(181) }).success).toBe(false);

    // A price is a whole number of tokens, 10 or more, in steps of 10; 0 and nothing are free.
    for (const price of [0, 10, 20, 250, 99_990]) {
      expect(publish.safeParse({ ...textPost, resources: [card], resource_price_tokens: price }).success, String(price)).toBe(true);
    }
    for (const price of [1, 5, 9, 15, 255, 10.5, -10, -250, '250', null, Number.NaN, 2_147_483_650]) {
      expect(publish.safeParse({ ...textPost, resources: [card], resource_price_tokens: price }).success, String(price)).toBe(false);
    }
    expect(publish.safeParse({ generation_id: GENERATION_ID, resource_price_tokens: 250 }).success).toBe(true);

    // An argument the tool does not have is refused, never dropped: with the source keys optional,
    // a misspelled one would otherwise leave a title and a body to publish as a public text post
    // (PR #751's review, finding 4).
    expect(publish.safeParse({ generationId: GENERATION_ID, ...textPost }).success).toBe(false);
    expect(publish.safeParse({ upload: [upload], ...textPost }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, price: 250 }).success).toBe(false);
    expect(publish.safeParse({ ...textPost, resources: [{ ...card, content: 'x' }] }).success).toBe(false);
    expect(publish.safeParse({ uploads: [{ storage_path: STAGED_PICTURE, storagePath: STAGED_PICTURE }], title: 'A paper fox', made_with: [{ tool: 'Midjourney' }] }).success).toBe(false);
    expect(publish.safeParse({ uploads: [upload], title: 'A paper fox', made_with: [{ tool: 'Midjourney', version: 'v7' }] }).success).toBe(false);
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

  it('stages a file the agent sent itself, by its upload_id, and says both things a staged file can become', async () => {
    const sent = {
      ok: true as const,
      input: { url: 'https://project.supabase.test/storage/v1/object/sign/uploads/x?token=read', storagePath: STAGED_PICTURE },
      kind: 'image' as const,
      bytes: 204_800,
      mimeType: 'image/png',
      expiresInSeconds: 3600,
      sourceUrl: null,
    };
    const { context, services, admin } = harness({ stageAgentInput: vi.fn(async () => sent) as never });
    const result = await tool('upload_input').handle({ upload_id: UPLOAD_ID }, context);
    expect(result.isError).toBeUndefined();
    expect(services.stageAgentInput).toHaveBeenCalledWith({ admin, userId: USER_ID, source: { uploadId: UPLOAD_ID } });
    expect(structured(result)).toEqual({
      input: { url: sent.input.url, storage_path: STAGED_PICTURE },
      kind: 'image',
      bytes: 204_800,
      mime_type: 'image/png',
      expires_in_seconds: 3600,
      source_url: null,
    });
    // The same answer feeds a run or becomes a post.
    expect(text(result)).toContain('create_media.inputs[]');
    expect(text(result)).toContain('publish_post.uploads[]');
    // Counted like the other sources, before anything is finalized.
    expect(vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options)).toEqual([
      { ...AGENT_UPLOAD_INPUT_RATE_LIMIT, key: USER_ID },
    ]);

    // A track feeds a run only: the answer does not offer a post.
    const track = harness({ stageAgentInput: vi.fn(async () => ({ ...sent, kind: 'audio' as const, mimeType: 'audio/mpeg' })) as never });
    const staged = text(await tool('upload_input').handle({ upload_id: UPLOAD_ID }, track.context));
    expect(staged).toContain('A track feeds a run only');
    expect(staged).not.toContain('publish_post.uploads[]');

    // What the upload_id source refuses arrives under its own code, with its own next step.
    const refusals: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ code: 'NOT_FOUND', message: 'No upload exists for this creator. request_upload gives an upload_id.' }, 'NOT_FOUND', /request_upload/u],
      // Nothing stored yet: the upload stays open, and the same call passes once the file is sent.
      [{ code: 'NOT_READY', message: 'Nothing is stored for upload yet. Run the command request_upload gave.' }, 'NOT_READY', /Nothing is stored/u],
      [{ code: 'UPLOAD_BYTES_LIMIT', message: 'Too many of this creator\'s uploads are open: 4 at most at once.', details: { open_uploads_max: 4 } }, 'UPLOAD_BYTES_LIMIT', /4 at most at once/u],
      [{ code: 'CONFLICT', message: 'Upload is already used or being collected.' }, 'CONFLICT', /already used/u],
      [{ code: 'UNSUPPORTED_MEDIA', message: 'The bytes are a track. It was removed.', details: { sniffed_kind: 'audio' } }, 'UNSUPPORTED_MEDIA', /removed/u],
      [{ code: 'UPLOAD_FAILED', message: 'The uploaded file could not be read to check it.' }, 'UNAVAILABLE', /Try again/u],
    ];
    for (const [refusal, code, words] of refusals) {
      const { context: other } = harness({ stageAgentInput: vi.fn(async () => ({ ok: false, ...refusal })) as never });
      const refused = await tool('upload_input').handle({ upload_id: UPLOAD_ID }, other);
      expect(toolFailureCode(refused), code).toBe(code);
      expect(text(refused), code).toMatch(words);
    }
  });

  it('refuses neither or both sources, base64 without its type, and passes the staging codes on with the next step', async () => {
    const { context, services } = harness();
    expect(toolFailureCode(await tool('upload_input').handle({}, context))).toBe('INVALID_REQUEST');
    expect(toolFailureCode(await tool('upload_input').handle({ url: 'https://x/a.jpg', base64: 'AAAA', mime_type: 'image/png' }, context))).toBe('INVALID_REQUEST');
    expect(toolFailureCode(await tool('upload_input').handle({ base64: 'AAAA' }, context))).toBe('INVALID_REQUEST');
    // Exactly one of the three: an upload_id beside either of the others is refused too.
    const two = await tool('upload_input').handle({ url: 'https://x/a.jpg', upload_id: UPLOAD_ID }, context);
    expect(toolFailureCode(two)).toBe('INVALID_REQUEST');
    expect(text(two)).toContain('exactly one of url, base64 or upload_id');
    expect(toolFailureCode(await tool('upload_input').handle({ base64: 'AAAA', mime_type: 'image/png', upload_id: UPLOAD_ID }, context))).toBe('INVALID_REQUEST');
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

describe('request_upload', () => {
  const args = { file_name: 'paper-fox.png', mime_type: 'image/png', size_bytes: 204_800 };
  const CURL = `curl -sS -X PUT -H 'content-type: image/png' -H 'x-upsert: false' -H 'cache-control: max-age=86400' --data-binary @FILE '${UPLOAD_URL}'`;

  it('signs an upload for a local file and answers the URL, the headers and the one command that sends it', async () => {
    const { context, services, admin } = harness();
    const result = await tool('request_upload').handle(args, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      upload_id: UPLOAD_ID,
      upload_url: UPLOAD_URL,
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'x-upsert': 'false', 'cache-control': 'max-age=86400' },
      curl: CURL,
      storage_path: STAGED_PICTURE,
      kind: 'image',
      mime_type: 'image/png',
      size_bytes: 204_800,
      expires_in_seconds: 7200,
      max_bytes: 25 * 1024 * 1024,
    });
    // The text is the exact command on a line of its own, then the call that follows it.
    const lines = text(result).split('\n');
    expect(lines).toHaveLength(3);
    // Single quotes: inside double ones the shell expands $ and backticks, and a file's name can
    // hold either (PR #751's review, finding 14).
    expect(lines[0]).toContain("FILE replaced by its path in single quotes, as in @'/path/to/the file.png'");
    expect(lines[0]).toContain("a single quote in the path is written '\\''");
    expect(lines[0]).toContain('never double quotes');
    expect(lines[0]).not.toMatch(/in double quotes if/u);
    expect(lines[1]).toBe(CURL);
    // What a stored file looks like in the command's output, so the agent knows before it calls on.
    expect(lines[2]).toBe(`then call upload_input with this upload_id (${UPLOAD_ID}). The command prints {"Key": ...} once the file is stored; any other answer is a refusal, and nothing was stored. The URL lasts 120 minutes and takes the file once.`);
    expect(services.requestAgentUpload).toHaveBeenCalledWith({
      admin,
      userId: USER_ID,
      request: { fileName: 'paper-fox.png', mimeType: 'image/png', sizeBytes: 204_800 },
    });
    // Counted against the account's upload limit, the one upload_input counts against.
    expect(vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options)).toEqual([
      { ...AGENT_UPLOAD_INPUT_RATE_LIMIT, key: USER_ID },
    ]);
  });

  it('counts the call before anything is signed, and refuses one over the limit', async () => {
    const order: string[] = [];
    const counted = harness({
      enforceBackendRateLimit: vi.fn(async () => { order.push('limit'); }) as never,
      requestAgentUpload: vi.fn(async () => { order.push('sign'); return { ok: false as const, code: 'UPLOAD_FAILED' as const, message: 'x' }; }) as never,
    });
    await tool('request_upload').handle(args, counted.context);
    expect(order).toEqual(['limit', 'sign']);

    const { context, services } = harness({ enforceBackendRateLimit: vi.fn(async () => { throw rateLimit(12); }) as never });
    const result = await tool('request_upload').handle(args, context);
    expect(toolFailureCode(result)).toBe('RATE_LIMITED');
    expect(structured(result).error).toMatchObject({ retry_after_seconds: 12 });
    expect(services.requestAgentUpload).not.toHaveBeenCalled();
  });

  it('passes the caps\' and the sign step\'s refusals on under stable codes', async () => {
    const refusals: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ code: 'TOO_LARGE', message: 'The file is 30000000 bytes; a picture sent this way may be at most 26214400.', details: { bytes: 30_000_000, max_bytes: 26_214_400 } }, 'TOO_LARGE', /at most 26214400/u],
      [{ code: 'UNSUPPORTED_MEDIA', message: 'text/html is not a picture, clip or track type Magicbooklet takes.', details: { mime_type: 'text/html' } }, 'UNSUPPORTED_MEDIA', /text\/html/u],
      [{ code: 'RATE_LIMITED', message: 'Wait.', retryAfterSeconds: 42 }, 'RATE_LIMITED', /42 seconds/u],
      [{ code: 'ACCOUNT_DELETION_IN_PROGRESS', message: 'Uploads are disabled because this account is being deleted.' }, 'ACCOUNT_DELETION_IN_PROGRESS', /being deleted/u],
      [{ code: 'UPLOAD_FAILED', message: 'Failed to prepare media upload.' }, 'UNAVAILABLE', /Try again/u],
      // The account's open uploads hold its staging space: named, never "try again in a moment".
      [{ code: 'UPLOAD_BYTES_LIMIT', message: 'Too many of this creator\'s uploads are open: 4 at most at once.', details: { open_uploads_max: 4 } }, 'UPLOAD_BYTES_LIMIT', /4 at most at once/u],
    ];
    expect(tool('request_upload').description).toMatch(/one file at a time .*at most 4 uploads open at once.*UPLOAD_BYTES_LIMIT/u);
    for (const [refusal, code, words] of refusals) {
      const { context } = harness({ requestAgentUpload: vi.fn(async () => ({ ok: false, ...refusal })) as never });
      const result = await tool('request_upload').handle(args, context);
      expect(toolFailureCode(result), code).toBe(code);
      expect(text(result), code).toMatch(words);
      // A refusal answers no URL to send anything to.
      expect(JSON.stringify(result), code).not.toContain('upload_url');
    }
    const tooLarge = harness({ requestAgentUpload: vi.fn(async () => ({ ok: false, ...refusals[0][0] })) as never });
    expect(structured(await tool('request_upload').handle(args, tooLarge.context)).error).toMatchObject({ max_bytes: 26_214_400 });
  });

  it('takes a name, a type and a whole, positive size', () => {
    const schema = tool('request_upload').inputSchema;
    expect(schema.safeParse(args).success).toBe(true);
    expect(schema.safeParse({ ...args, size_bytes: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...args, size_bytes: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...args, file_name: '' }).success).toBe(false);
    expect(schema.safeParse({ ...args, file_name: 'x'.repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ mime_type: 'image/png', size_bytes: 10 }).success).toBe(false);
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
      // Free by default: no price was given.
      resource_access: 'free',
      resource_price_tokens: 0,
      resource_status: 'published',
    });
    expect(text(result)).toMatch(/public now/u);
    expect(text(result)).toContain('Its free recipe (the exact prompt) is on the post');
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
    expect(structured(result)).toMatchObject({ visibility: 'private', state: 'private', already_published: false, recipe_included: false, ...NO_RESOURCE_FIELDS });
    expect(text(result)).toMatch(/Only the creator sees it/u);
    expect(text(result)).toContain('It carries no recipe.');
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
    const withRecipe = () => vi.fn(async () => ({ ok: true, post: post({ resource: FREE_RECIPE }) })) as never;
    const same = harness({ readCreationForPublish: vi.fn(async () => existing), readPostForAgent: withRecipe() });
    const again = await tool('publish_post').handle(args, same.context);
    expect(again.isError).toBeUndefined();
    expect(structured(again)).toEqual({
      post_id: POST_ID,
      post_url: `${SITE}/showcase/${POST_ID}`,
      visibility: 'public',
      state: 'live',
      already_published: true,
      visibility_changed: false,
      // What the post carries, read as its three facts.
      resource_access: 'free',
      resource_price_tokens: 0,
      resource_status: 'published',
    });
    expect(text(again)).toContain('already published');
    expect(same.services.readPostForAgent).toHaveBeenCalledWith(same.admin, { postId: POST_ID, viewerUserId: USER_ID });
    // A price sent with a repeat changes nothing, and the answer says where a price is changed.
    const repriced = await tool('publish_post').handle({ ...args, resource_price_tokens: 250 }, same.context);
    expect(structured(repriced)).toMatchObject({ already_published: true, visibility_changed: false, resource_access: 'free', resource_price_tokens: 0 });
    expect(text(repriced)).toContain('A recipe\'s price is changed on the website, not by publishing again.');
    // The post still answers where its resource could not be read: the three fields are left out.
    const unread = harness({ readCreationForPublish: vi.fn(async () => existing), readPostForAgent: vi.fn(async () => ({ ok: false, code: 'UNAVAILABLE' })) as never });
    expect(structured(await tool('publish_post').handle(args, unread.context))).toEqual({ post_id: POST_ID, post_url: `${SITE}/showcase/${POST_ID}`, visibility: 'public', state: 'live', already_published: true, visibility_changed: false });
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
      readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ resource: { access: 'paid', priceTokens: 250, status: 'published' } }) })) as never,
      publishGenerationToShowcaseForRoute: vi.fn(async () => published({ visibility: 'private', isPublic: false, resourceBundleStatus: 'draft' })) as never,
    });
    const madePrivate = await tool('publish_post').handle({ ...args, visibility: 'private' }, flip.context);
    expect(structured(madePrivate)).toEqual({
      post_id: POST_ID,
      post_url: `${SITE}/showcase/${POST_ID}`,
      visibility: 'private',
      state: 'private',
      already_published: true,
      visibility_changed: true,
      // The recipe and its price are what they were; off sale while the post is private.
      resource_access: 'paid',
      resource_price_tokens: 250,
      resource_status: 'draft',
    });
    expect(text(madePrivate)).toContain('Only the creator sees it. It carries a paid resource at 250 tokens, held as a draft');
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
      // A remix keeps the terms of the recipe it remixed: the service's rule, answered with the argument that meets it.
      [{ status: 400, body: { error: 'This creation remixes a paid recipe, so its recipe has to be paid. You set the price.', code: 'REMIX_RECIPE_MUST_BE_PAID', field: 'resourceBundle' } }, 'INVALID_REQUEST', /Ask the person what to charge, then publish with resource_price_tokens/u],
      [{ status: 400, body: { error: 'This creation remixes a free recipe, so its recipe stays free.', code: 'REMIX_RECIPE_STAYS_FREE', field: 'resourceBundle' } }, 'INVALID_REQUEST', /Publish without resource_price_tokens/u],
      // The listing lines' limits, in the service's words, under the tool's argument names.
      [{ status: 400, body: { error: 'Package previews are limited to 180 characters.', field: 'resourcePreview' } }, 'INVALID_REQUEST', /Package previews are limited to 180 characters/u],
      [{ status: 400, body: { error: 'Public summaries are limited to 180 characters.', field: 'resourceSummary' } }, 'INVALID_REQUEST', /Public summaries are limited to 180 characters/u],
      [{ status: 400, body: { error: 'Paid recipes must cost at least 10 credits and use 10-credit increments.' } }, 'INVALID_REQUEST', /Paid recipes must cost at least 10 credits/u],
      // The web answers a creator with no public profile with a link to it; the agent gets words.
      [{ status: 400, body: { error: 'Complete your profile before publishing: Choose a custom handle and add your display name before publishing a recipe.', field: 'profile', actionHref: '/profile', actionLabel: 'Complete profile and return' } }, 'INVALID_REQUEST', /The person sets their handle and display name on the website, then you publish again\./u],
    ];
    const fieldFor: Record<string, string> = { title: 'title', resourceBundle: 'resource_price_tokens', resourcePreview: 'resource_preview', resourceSummary: 'resource_summary' };
    for (const [answer, code, words] of cases) {
      const { context } = harness({ publishGenerationToShowcaseForRoute: vi.fn(async () => ({ ok: false, ...answer })) as never });
      const result = await tool('publish_post').handle({ ...args, resource_price_tokens: 250 }, context);
      const label = JSON.stringify(answer);
      expect(toolFailureCode(result), label).toBe(code);
      if (words) expect(text(result), label).toMatch(words);
      // The service's own message is the answer's.
      if (code === 'INVALID_REQUEST') expect(text(result), label).toContain((answer.body as { error: string }).error);
      const field = (answer.body as { field?: string; code?: string }).field;
      if (code === 'INVALID_REQUEST' && field && fieldFor[field] && (answer.body as { code?: string }).code !== 'CREATION_RECIPE_REQUIRED') {
        expect(structured(result).error, label).toMatchObject({ field_errors: { [fieldFor[field]]: expect.any(String) } });
      }
      // Never a link, and never the service's own field name where the tool has its own.
      expect(JSON.stringify(result), label).not.toMatch(/actionHref|actionLabel|\/profile|Complete profile and return|resourceBundle|resourcePreview|resourceSummary/u);
    }
  });

  it('prices the creation\'s recipe at the person\'s number, as the web sends a paid recipe, and reports it', async () => {
    const { context, services } = harness();
    const result = await tool('publish_post').handle({ ...args, resource_price_tokens: 250 }, context);
    expect(result.isError).toBeUndefined();
    // The web's paid request: the same recipe with the access mode and the price, nothing computed.
    const body = await publishBody(services);
    expect(body.resourceBundle).toEqual(agentRecipeBundle('a red bicycle at dawn, film grain', { priceTokens: 250 }));
    expect(body.resourceBundle).toEqual({
      accessMode: 'paid',
      summary: AGENT_RECIPE_SUMMARY,
      previewText: AGENT_RECIPE_PREVIEW,
      priceUsdCents: 250,
      resources: { promptText: 'a red bicycle at dawn, film grain', workflowShareUrl: null, attachments: [], allowRemix: false },
    });
    expect(body).toMatchObject({ allowRemixes: true, includeGenerationReferences: true, shareInputMediaForRemix: false });
    expect(structured(result)).toMatchObject({
      recipe_included: true,
      recipe_status: 'published',
      resource_access: 'paid',
      resource_price_tokens: 250,
      resource_status: 'published',
    });
    expect(text(result)).toContain('Its recipe (the exact prompt) is on sale at 250 tokens');
    // A paid recipe's prompt is what is sold: the answer names the post, never the prompt.
    expect(text(result)).not.toContain('a red bicycle at dawn, film grain');

    // The person's own listing lines ride with it.
    const lined = harness();
    await tool('publish_post').handle({ ...args, resource_price_tokens: 100, resource_summary: 'The dawn bicycle prompt', resource_preview: 'The exact prompt and the settings behind this shot.' }, lined.context);
    expect((await publishBody(lined.services)).resourceBundle).toMatchObject({ accessMode: 'paid', priceUsdCents: 100, summary: 'The dawn bicycle prompt', previewText: 'The exact prompt and the settings behind this shot.' });

    // On a private post the service holds the recipe as a draft, and the answer says so.
    const privately = harness({
      publishGenerationToShowcaseForRoute: vi.fn(async () => published({ visibility: 'private', isPublic: false, resourceBundleStatus: 'draft' })) as never,
    });
    const saved = await tool('publish_post').handle({ ...args, visibility: 'private', resource_price_tokens: 250 }, privately.context);
    expect(structured(saved)).toMatchObject({ visibility: 'private', resource_access: 'paid', resource_price_tokens: 250, resource_status: 'draft' });
    expect(text(saved)).toContain('priced at 250 tokens and held as a draft: it goes on sale when the post is public');

    // A price of 0 is free, as no price is.
    const zero = harness();
    const free = await tool('publish_post').handle({ ...args, resource_price_tokens: 0 }, zero.context);
    expect(structured(free)).toMatchObject({ resource_access: 'free', resource_price_tokens: 0 });
    expect((await publishBody(zero.services)).resourceBundle).toMatchObject({ accessMode: 'free', priceUsdCents: 0 });
  });

  it('suggests no title from the prompt of a recipe that is sold: a paid recipe keeps its prompt private', async () => {
    const { title: _omitted, ...withoutTitle } = args;
    void _omitted;
    const source = { prompt: 'a red bicycle at dawn, film grain', model: 'img-1', category: 'image', creationMode: null };
    const fromPrompt = getCreationPostTitleSuggestion(null, source, false)?.title;
    const keptPrivate = getCreationPostTitleSuggestion(null, source, true)?.title;
    expect(keptPrivate).not.toBe(fromPrompt);

    const paid = harness();
    await tool('publish_post').handle({ ...withoutTitle, resource_price_tokens: 250 }, paid.context);
    const sentTitle = (await publishBody(paid.services)).title;
    expect(sentTitle).toBe(keptPrivate ?? undefined);
    expect(String(sentTitle ?? '')).not.toContain('red bicycle');
    // The creation's own title is the creator's words and stands either way.
    const own = harness({ readCreationForPublish: vi.fn(async () => creation({ title: 'The creation\'s own title' })) });
    await tool('publish_post').handle({ ...withoutTitle, resource_price_tokens: 250 }, own.context);
    expect((await publishBody(own.services)).title).toBe('The creation\'s own title');
  });

  it('refuses a price that is not one before the creation is read, and a price or listing lines with no recipe to carry them before any limit is spent', async () => {
    // The handler's own check, for a call that reached it past the schema.
    for (const price of [1, 5, 9, 15, 255, 10.5, -10]) {
      const { context, services } = harness();
      const result = await tool('publish_post').handle({ ...args, resource_price_tokens: price }, context);
      expect(toolFailureCode(result), String(price)).toBe('INVALID_REQUEST');
      expect((structured(result).error as { field_errors: Record<string, string> }).field_errors.resource_price_tokens, String(price))
        .toContain('a whole number of tokens, 10 or more, in steps of 10 (100 tokens = $1.00)');
      for (const service of [services.readCreationForPublish, services.enforceBackendRateLimit, services.countAgentPublicPublishesSince, services.publishGenerationToShowcaseForRoute]) {
        expect(service, String(price)).not.toHaveBeenCalled();
      }
    }

    const cases: Array<[Record<string, unknown>, Partial<CreationForPublish>, string, RegExp]> = [
      // Remixes off posts the media alone: nothing is left to price.
      [{ ...args, allow_remixes: false, resource_price_tokens: 250 }, {}, 'resource_price_tokens', /allow_remixes false publishes no recipe\. Leave the price out\./u],
      [{ ...args, resource_price_tokens: 250 }, { prompt: null }, 'resource_price_tokens', /this creation has no prompt, so it has no recipe\. Leave the price out\./u],
      [{ ...args, allow_remixes: false, resource_summary: 'The dawn bicycle prompt' }, {}, 'resource_summary', /describe the creation's recipe, and allow_remixes false publishes no recipe/u],
      [{ ...args, allow_remixes: false, resource_preview: 'The exact prompt behind this shot.' }, {}, 'resource_preview', /describe the creation's recipe/u],
    ];
    for (const [input, overrides, field, words] of cases) {
      const { context, services } = harness({ readCreationForPublish: vi.fn(async () => creation(overrides)) });
      const result = await tool('publish_post').handle(input as never, context);
      expect(toolFailureCode(result), String(words)).toBe('INVALID_REQUEST');
      expect((structured(result).error as { field_errors: Record<string, string> }).field_errors[field], String(words)).toMatch(words);
      for (const service of [services.enforceBackendRateLimit, services.countAgentPublicPublishesSince, services.publishGenerationToShowcaseForRoute]) {
        expect(service, String(words)).not.toHaveBeenCalled();
      }
    }
  });

  // PR #751's review, finding 2, on the creation path: "make it public at 250" on a post saved
  // private with a free recipe went public with the recipe free.
  it('refuses a visibility change of a creation\'s post that names another price, mature mark or remix switch than the post has, before any limit is spent', async () => {
    const existing = creation({ post: { id: POST_ID, visibility: 'private', state: 'private' } });
    const cases: Array<[string, Partial<AgentPostView>, Record<string, unknown>, string, RegExp]> = [
      ['a price on a free recipe', { resource: { access: 'free', priceTokens: 0, status: 'draft' } }, { resource_price_tokens: 250 }, 'resource_price_tokens', /already exists with a free resource.*a price is changed on the website/u],
      ['another price', { resource: { access: 'paid', priceTokens: 250, status: 'draft' } }, { resource_price_tokens: 990 }, 'resource_price_tokens', /already exists with a paid resource at 250 tokens/u],
      ['a price on a post with no recipe', {}, { resource_price_tokens: 250 }, 'resource_price_tokens', /already exists with no resource/u],
      ['a mature mark the post does not have', {}, { is_nsfw: true }, 'is_nsfw', /is not marked mature/u],
      ['remixes switched off on a post that carries a recipe', { remixesAllowed: true, resource: { access: 'free', priceTokens: 0, status: 'draft' } }, { allow_remixes: false }, 'allow_remixes', /carries a recipe people remix from.*changed on the website/u],
      ['remixes switched on for a post that does not allow them', { remixesAllowed: false }, { allow_remixes: true }, 'allow_remixes', /does not allow remixes.*changed on the website/u],
    ];
    for (const [label, stored, extra, field, words] of cases) {
      const repeat = harness({
        readCreationForPublish: vi.fn(async () => existing),
        readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ visibility: 'private', state: 'private', ...stored }) })) as never,
      });
      const result = await tool('publish_post').handle({ ...args, visibility: 'public', ...extra }, repeat.context);
      expect(toolFailureCode(result), label).toBe('INVALID_REQUEST');
      expect((structured(result).error as { field_errors: Record<string, string> }).field_errors[field], label).toMatch(words);
      for (const service of [repeat.services.publishGenerationToShowcaseForRoute, repeat.services.enforceBackendRateLimit, repeat.services.countAgentPublicPublishesSince]) {
        expect(service, label).not.toHaveBeenCalled();
      }
    }
    // What the post carries could not be read: a price cannot be held against it, so nothing goes public.
    const blind = harness({ readCreationForPublish: vi.fn(async () => existing), readPostForAgent: vi.fn(async () => ({ ok: false, code: 'UNAVAILABLE' })) as never });
    const unread = await tool('publish_post').handle({ ...args, visibility: 'public', resource_price_tokens: 250 }, blind.context);
    expect(toolFailureCode(unread)).toBe('UNAVAILABLE');
    expect(blind.services.publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
    // The same price the recipe has changes the visibility alone.
    const same = harness({
      readCreationForPublish: vi.fn(async () => existing),
      readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ visibility: 'private', state: 'private', resource: { access: 'paid', priceTokens: 250, status: 'draft' } }) })) as never,
    });
    const opened = await tool('publish_post').handle({ ...args, visibility: 'public', resource_price_tokens: 250 }, same.context);
    expect(structured(opened)).toMatchObject({ visibility_changed: true, visibility: 'public', resource_access: 'paid', resource_price_tokens: 250 });
    expect(await publishBody(same.services)).toEqual({ generationId: GENERATION_ID, visibility: 'public' });

    // Finding 12, on this path: an archived or hidden post's visibility is not changed. Each is
    // told why in its own words: a removed post is one its creator deleted while people held
    // what it carries, not one under a moderation decision (the re-review).
    const reasons = { archived: /restores it on the website first/u, hidden: /under a moderation decision/u, removed: /taken down, and is kept only for the people who unlocked/u };
    for (const state of ['archived', 'hidden', 'removed'] as const) {
      const shelved = harness({ readCreationForPublish: vi.fn(async () => creation({ post: { id: POST_ID, visibility: 'private', state } })) });
      const result = await tool('publish_post').handle({ ...args, visibility: 'public' }, shelved.context);
      expect(toolFailureCode(result), state).toBe('CONFLICT');
      expect(text(result), state).toMatch(reasons[state]);
      if (state === 'removed') expect(text(result)).not.toContain('moderation');
      expect(shelved.services.publishGenerationToShowcaseForRoute, state).not.toHaveBeenCalled();
      expect(shelved.services.enforceBackendRateLimit, state).not.toHaveBeenCalled();
    }
  });

  // The re-review of PR #751: a creation published with allow_remixes false carries no recipe,
  // and the publish service leaves the post's remix column at its default of true. The same
  // call repeated with visibility public was refused with "allows remixes", which was untrue.
  it('lets the same call repeat for a creation published with remixes off, and says what a repeat does not apply', async () => {
    const saved = creation({ post: { id: POST_ID, visibility: 'private', state: 'private' } });
    const stored = (overrides: Partial<AgentPostView> = {}) => (
      vi.fn(async () => ({ ok: true, post: post({ visibility: 'private', state: 'private', title: args.title, remixesAllowed: true, ...overrides }) })) as never
    );
    const off = harness({ readCreationForPublish: vi.fn(async () => saved), readPostForAgent: stored() });
    const opened = await tool('publish_post').handle({ ...args, allow_remixes: false, visibility: 'public' }, off.context);
    expect(structured(opened)).toMatchObject({ post_id: POST_ID, visibility: 'public', visibility_changed: true, resource_access: 'none' });
    expect(await publishBody(off.services)).toEqual({ generationId: GENERATION_ID, visibility: 'public' });
    expect(text(opened)).not.toContain('not applied');
    expect(text(opened)).not.toContain('no recipe to remix from');

    // Remixes asked for on a post with no recipe: the visibility changes, and the answer says no recipe was added.
    const on = harness({ readCreationForPublish: vi.fn(async () => saved), readPostForAgent: stored() });
    const asked = await tool('publish_post').handle({ ...args, allow_remixes: true, visibility: 'public' }, on.context);
    expect(structured(asked)).toMatchObject({ visibility_changed: true });
    expect(text(asked)).toContain('It carries no recipe to remix from; one is added on the website.');

    // Another title, description or category than the post's is not applied, and the answer says so.
    const renamed = harness({ readCreationForPublish: vi.fn(async () => saved), readPostForAgent: stored({ title: 'Red bicycle', description: 'Before', category: 'image' }) });
    const answer = await tool('publish_post').handle({ ...args, description: 'After', visibility: 'public' }, renamed.context);
    expect(structured(answer)).toMatchObject({ visibility_changed: true });
    expect(text(answer)).toContain('The title and description sent with this call were not applied: the post keeps its own, and its title, description, category and Made with are edited on the website.');
    expect(await publishBody(renamed.services)).toEqual({ generationId: GENERATION_ID, visibility: 'public' });
  });

  // Finding 3: a remix of a paid recipe must be public with a paid recipe. The refusal told the
  // agent to add a price where the tool then ignored or refused one, so it came back for ever.
  it('answers the remix terms with a step that works: a price on a new post, the website for an existing post or a creation with no prompt', async () => {
    const mustBePaid = { ok: false, status: 400, body: { error: 'This creation remixes a paid recipe, so its recipe has to be paid. You set the price.', code: 'REMIX_RECIPE_MUST_BE_PAID', field: 'resourceBundle' } };
    const refusing = () => vi.fn(async () => mustBePaid) as never;

    const fresh = harness({ publishGenerationToShowcaseForRoute: refusing() });
    const onNew = await tool('publish_post').handle(args, fresh.context);
    expect(toolFailureCode(onNew)).toBe('INVALID_REQUEST');
    expect(text(onNew)).toContain('Ask the person what to charge, then publish with resource_price_tokens and allow_remixes left on.');

    // The post exists: a repeat cannot price it, so the price is set on the website.
    const existing = harness({
      readCreationForPublish: vi.fn(async () => creation({ post: { id: POST_ID, visibility: 'private', state: 'private' } })),
      readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ visibility: 'private', state: 'private', resource: { access: 'free', priceTokens: 0, status: 'draft' } }) })) as never,
      publishGenerationToShowcaseForRoute: refusing(),
    });
    const onExisting = await tool('publish_post').handle({ ...args, visibility: 'public' }, existing.context);
    expect(toolFailureCode(onExisting)).toBe('INVALID_REQUEST');
    expect(text(onExisting)).toContain('The post already exists, so the person prices its recipe on the website; then publish again with visibility public.');
    expect(text(onExisting)).not.toContain('publish with resource_price_tokens');

    // No prompt: the tool has no recipe to send, and the website builds one from the saved inputs.
    const silent = harness({ readCreationForPublish: vi.fn(async () => creation({ prompt: null })), publishGenerationToShowcaseForRoute: refusing() });
    const onSilent = await tool('publish_post').handle(args, silent.context);
    expect(toolFailureCode(onSilent)).toBe('INVALID_REQUEST');
    expect(text(onSilent)).toContain('This creation has no prompt for the tool to build a recipe from: the person publishes it on the website');
    expect(text(onSilent)).not.toContain('publish with resource_price_tokens');
  });

  it('refuses resources with a creation, whose resource is its own recipe, before anything is read', async () => {
    const { context, services } = harness();
    const result = await tool('publish_post').handle({ ...args, resources: [{ type: 'prompt', title: 'Hook prompt', text: 'Cinematic hook, 35mm' }] }, context);
    expect(toolFailureCode(result)).toBe('INVALID_REQUEST');
    expect((structured(result).error as { field_errors: Record<string, string> }).field_errors.resources)
      .toContain('A creation\'s resource is its own recipe, which the server builds from the run: allow_remixes carries it, and resource_price_tokens prices it.');
    for (const service of [services.readCreationForPublish, services.readPostForAgent, services.enforceBackendRateLimit, services.publishGenerationToShowcaseForRoute, services.createOwnerPostForRoute]) {
      expect(service).not.toHaveBeenCalled();
    }
  });
});

describe('publish_post with uploads', () => {
  const args = {
    uploads: [{ storage_path: STAGED_PICTURE }],
    title: 'Paper-cut fox in a snowy forest',
    made_with: [{ tool: 'Midjourney', model: 'v7' }],
  };
  /** The id the post of that one staged file gets, whichever call asks. */
  const UPLOAD_POST_ID = agentUploadPostId(USER_ID, [STAGED_PICTURE]);
  const UPLOAD_POST_URL = `${SITE}/showcase/${UPLOAD_POST_ID}`;

  /** A harness in which no post exists yet under the id these uploads derive. */
  function fresh(overrides: Partial<McpToolServices> = {}) {
    return harness({ readPostForAgent: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })) as never, ...overrides });
  }

  /** A read that finds the post an earlier publish of these uploads made. */
  function found(overrides: Partial<AgentPostView> = {}) {
    return vi.fn(async () => ({ ok: true, post: post({ postId: UPLOAD_POST_ID, generationId: null, source: 'upload', title: args.title, ...overrides }) })) as never;
  }

  function stagedAs(entry: AgentStagedUpload) {
    return vi.fn(async (_admin: unknown, { storagePaths }: { storagePaths: readonly string[] }) => ({
      ok: true as const,
      uploads: new Map(storagePaths.map((storagePath) => [storagePath, entry])),
    })) as never;
  }

  /** What the composer's create was called with, its form's fields as plain values. */
  async function sent(services: McpToolServices, call = 0) {
    const [input] = vi.mocked(services.createOwnerPostForRoute).mock.calls[call] as unknown as [
      { adminSupabase: unknown; ownerUserId: string; readFormData: () => Promise<FormData>; createPostId: () => string },
    ];
    const json = new Set(['sourceTools', 'resourceBundle', 'mediaItems']);
    const fields = Object.fromEntries(
      [...(await input.readFormData()).entries()].map(([key, value]) => [key, json.has(key) ? JSON.parse(String(value)) : value]),
    ) as Record<string, unknown>;
    return { input, fields };
  }

  it('takes one source of three: a creation, uploads, or with neither a title and a body; never a creation and uploads, and made_with never with a creation', async () => {
    const { context, services } = fresh();
    // Neither a creation nor uploads is a text post, which needs its text: a title alone names no source.
    const neither = await tool('publish_post').handle({ title: 'A paper fox' }, context);
    expect(toolFailureCode(neither)).toBe('INVALID_REQUEST');
    expect(text(neither)).toContain('A post needs a source: generation_id (a creation made here), uploads (files staged with upload_input), or, for a text post, title and body.');
    expect(structured(neither).error).toMatchObject({ field_errors: { body: expect.any(String) } });
    expect(toolFailureCode(await tool('publish_post').handle({}, context))).toBe('INVALID_REQUEST');
    const both = await tool('publish_post').handle({ ...args, generation_id: GENERATION_ID }, context);
    expect(toolFailureCode(both)).toBe('INVALID_REQUEST');
    expect(text(both)).toContain('Give one source, not two');
    expect(structured(both).error).toMatchObject({ field_errors: { generation_id: expect.any(String) } });

    // A creation's Made with is fixed by its run: the argument is refused, not ignored.
    const fixed = await tool('publish_post').handle({ generation_id: GENERATION_ID, made_with: [{ tool: 'Midjourney' }] }, context);
    expect(toolFailureCode(fixed)).toBe('INVALID_REQUEST');
    expect(structured(fixed).error).toMatchObject({ field_errors: { made_with: expect.stringContaining('made_with goes with uploads or a text post') } });

    for (const service of [
      services.readCreationForPublish, services.readPostForAgent, services.readAgentStagedUploads, services.enforceBackendRateLimit,
      services.publishGenerationToShowcaseForRoute, services.createOwnerPostForRoute,
    ]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it('requires a title and made_with, and refuses allow_remixes, Magicbooklet\'s own name and what the composer\'s validator refuses, before anything is read or spent', async () => {
    const { context, services } = fresh();
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ ...args, title: undefined }, 'title', /title is required with uploads/u],
      [{ ...args, made_with: undefined }, 'made_with', /made_with is required with uploads/u],
      [{ ...args, made_with: [] }, 'made_with', /made_with is required with uploads/u],
      // An upload has no recipe: the switch is refused whichever way it is set.
      [{ ...args, allow_remixes: true }, 'allow_remixes', /no recipe to remix/u],
      [{ ...args, allow_remixes: false }, 'allow_remixes', /no recipe to remix/u],
      // Media made here is published from its creation.
      [{ ...args, made_with: [{ tool: 'Magic Booklet' }] }, 'made_with', /published with generation_id/u],
      [{ ...args, made_with: [{ tool: 'Midjourney' }, { tool: 'magicbooklet', model: 'Seedance 2' }] }, 'made_with', /Magic Booklet is not a name for made_with/u],
      [{ ...args, made_with: [{ tool: 'magic-booklet' }] }, 'made_with', /published with generation_id/u],
      // The composer's validator, in its own words.
      [{ ...args, made_with: [{ tool: 'Custom' }] }, 'made_with', /The source tool name "Custom" is reserved\./u],
      [{ ...args, made_with: [{ tool: 'x'.repeat(81) }] }, 'made_with', /Source tool names must be 80 characters or fewer\./u],
      [{ ...args, made_with: [{ tool: 'Midjourney', model: 'unknown' }] }, 'made_with', /The source model name "unknown" is reserved\./u],
      [{ ...args, made_with: Array.from({ length: 6 }, (_, index) => ({ tool: `Tool ${index}` })) }, 'made_with', /A post can include at most 5 source tools\./u],
      [{ ...args, uploads: [{ storage_path: STAGED_PICTURE }, { storage_path: ` ${STAGED_PICTURE} ` }] }, 'uploads', /same staged file twice/u],
      [{ ...args, uploads: Array.from({ length: 6 }, (_, index) => ({ storage_path: `uploads/${USER_ID}/file-${index}.png` })) }, 'uploads', /1 to 5 uploads/u],
      // A price, or listing lines, need a resource to belong to.
      [{ ...args, resource_price_tokens: 250 }, 'resource_price_tokens', /prices a resource, and this post carries none/u],
      [{ ...args, resource_summary: 'Three hooks' }, 'resource_summary', /describe a resource, and this post carries none/u],
      [{ ...args, resource_preview: 'The exact prompt, ready to paste.' }, 'resource_preview', /describe a resource, and this post carries none/u],
      [{ ...args, resources: [{ type: 'prompt', title: 'Hook prompt' }] }, 'resources', /resources\[0\] is a prompt: give its text\./u],
      [{ ...args, resources: [{ type: 'prompt', title: 'Hook prompt', text: 'x' }], resource_price_tokens: 15 }, 'resource_price_tokens', /a whole number of tokens, 10 or more, in steps of 10/u],
    ];
    for (const [input, field, words] of cases) {
      const result = await tool('publish_post').handle(input as never, context);
      expect(toolFailureCode(result), String(words)).toBe('INVALID_REQUEST');
      expect(text(result), String(words)).toMatch(words);
      expect((structured(result).error as { field_errors: Record<string, string> }).field_errors[field], String(words)).toMatch(words);
    }
    expect(AGENT_MADE_WITH_APP_REFUSAL).toMatch(/published with generation_id/u);
    for (const service of [
      services.readPostForAgent, services.readAgentStagedUploads, services.enforceBackendRateLimit,
      services.countAgentPublicPublishesSince, services.createOwnerPostForRoute, services.updateOwnerPostForRoute,
    ]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it('publishes staged files live through the composer\'s own create, with the form the composer page sends, under the post\'s derived id and both limits', async () => {
    const { context, services, admin } = fresh();
    const result = await tool('publish_post').handle({
      ...args,
      uploads: [{ storage_path: STAGED_PICTURE }, { storage_path: STAGED_CLIP }],
      description: 'Cut from one sheet.',
      body: 'Made over a weekend.',
    }, context);
    const postId = agentUploadPostId(USER_ID, [STAGED_PICTURE, STAGED_CLIP]);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      post_id: postId,
      post_url: `${SITE}/showcase/${postId}`,
      visibility: 'public',
      state: 'live',
      already_published: false,
      visibility_changed: false,
      source: 'upload',
      media_count: 2,
      recipe_included: false,
      resources_included: 0,
      ...NO_RESOURCE_FIELDS,
    });
    expect(text(result)).toMatch(/Published 2 uploads as post .* It is public now/u);
    expect(text(result)).toContain(`${SITE}/showcase/${postId}`);
    // The post's id is its only handle: the library read does not list it.
    expect(text(result)).toContain('Keep this post_id: list_creations lists creations, not posts made from uploads.');

    const { input, fields } = await sent(services);
    expect(input.adminSupabase).toBe(admin);
    expect(input.ownerUserId).toBe(USER_ID);
    // The id the composer creates the post under is derived, not random: a repeat finds this post.
    expect(input.createPostId()).toBe(postId);
    expect(fields).toEqual({
      title: 'Paper-cut fox in a snowy forest',
      body: 'Made over a weekend.',
      description: 'Cut from one sheet.',
      sourceTool: 'Midjourney',
      sourceToolSlug: 'midjourney',
      sourceTools: [{ toolLabel: 'Midjourney', toolSlug: 'midjourney', modelLabel: 'v7', modelSlug: 'v7' }],
      visibility: 'public',
      isNsfw: 'false',
      postFormat: 'mixed',
      resourceBundle: { accessMode: 'none' },
      // Each file's type is the one the server recorded when it was staged, never the agent's word.
      mediaItems: [
        { storagePath: STAGED_PICTURE, originalName: 'paper-fox.png', contentType: 'image/png' },
        { storagePath: STAGED_CLIP, originalName: 'fox-run.mp4', contentType: 'video/mp4' },
      ],
      category: 'image',
    });
    expect(services.readPostForAgent).toHaveBeenCalledWith(admin, { postId, viewerUserId: USER_ID });
    expect(services.readAgentStagedUploads).toHaveBeenCalledWith(admin, { userId: USER_ID, storagePaths: [STAGED_PICTURE, STAGED_CLIP] });
    // The web's publish limit, then the agent's daily cap read from the ledger, exactly as for a creation.
    expect(vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options)).toEqual([{ ...SHOWCASE_PUBLISH_RATE_LIMIT, key: USER_ID }]);
    expect(services.countAgentPublicPublishesSince).toHaveBeenCalledWith(admin, { userId: USER_ID, since: new Date('1970-01-01T00:00:00.000Z') });
    // Nothing of the creation path runs.
    expect(services.readCreationForPublish).not.toHaveBeenCalled();
    expect(services.publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
  });

  it('saves a private post without counting the daily cap, and passes the choices on as the composer sends them', async () => {
    const { context, services } = fresh({ countAgentPublicPublishesSince: vi.fn(async () => 10) as never });
    const result = await tool('publish_post').handle({ ...args, visibility: 'private', is_nsfw: true, category: 'image' }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({ post_id: UPLOAD_POST_ID, visibility: 'private', state: 'private', already_published: false, source: 'upload', media_count: 1 });
    expect(text(result)).toMatch(/Saved 1 upload as private post .* Only the creator sees it; publish again with the same uploads and visibility public/u);
    // A private post is not a public publication: the day's count is not read, so a full day does not stop it.
    expect(services.countAgentPublicPublishesSince).not.toHaveBeenCalled();
    expect(vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options.scope)).toEqual([SHOWCASE_PUBLISH_RATE_LIMIT.scope]);
    expect((await sent(services)).fields).toMatchObject({ visibility: 'private', isNsfw: 'true', postFormat: 'media', category: 'image', body: '' });
  });

  it('answers the daily cap for a public post before the composer is called, and the web\'s limit with its wait', async () => {
    const capped = fresh({ countAgentPublicPublishesSince: vi.fn(async () => 10) as never });
    const result = await tool('publish_post').handle(args, capped.context);
    expect(toolFailureCode(result)).toBe('RATE_LIMITED');
    expect(structured(result).error).toMatchObject({ limit: 10, published_today: 10, reset_at: '1970-01-02T00:00:00.000Z' });
    expect(capped.services.createOwnerPostForRoute).not.toHaveBeenCalled();
    const room = fresh({ countAgentPublicPublishesSince: vi.fn(async () => 9) as never });
    expect((await tool('publish_post').handle(args, room.context)).isError).toBeUndefined();

    const busy = fresh({ enforceBackendRateLimit: vi.fn(async () => { throw rateLimit(90); }) as never });
    const limited = await tool('publish_post').handle(args, busy.context);
    expect(toolFailureCode(limited)).toBe('RATE_LIMITED');
    expect(text(limited)).toContain('90 seconds');
    expect(busy.services.createOwnerPostForRoute).not.toHaveBeenCalled();
  });

  it('answers the post an earlier publish of the same uploads made, changing nothing: a repeat never makes a second post', async () => {
    const same = harness({ readPostForAgent: found() });
    const again = await tool('publish_post').handle(args, same.context);
    expect(again.isError).toBeUndefined();
    expect(structured(again)).toEqual({
      post_id: UPLOAD_POST_ID,
      post_url: UPLOAD_POST_URL,
      visibility: 'public',
      state: 'live',
      already_published: true,
      visibility_changed: false,
      source: 'upload',
      ...NO_RESOURCE_FIELDS,
    });
    expect(text(again)).toContain(`These uploads are already published as post ${UPLOAD_POST_ID} (live, public)`);
    // The post keeps the resource and the price it was published with: a repeat that names
    // others changes neither, and says where they are changed.
    const priced = harness({ readPostForAgent: found({ resource: { access: 'paid', priceTokens: 250, status: 'published' } }) });
    const repriced = await tool('publish_post').handle({ ...args, resources: [{ type: 'prompt', title: 'Hook prompt', text: 'Cinematic hook, 35mm' }], resource_price_tokens: 500 }, priced.context);
    expect(structured(repriced)).toMatchObject({ already_published: true, visibility_changed: false, resource_access: 'paid', resource_price_tokens: 250, resource_status: 'published' });
    expect(text(repriced)).toContain('It carries a paid resource at 250 tokens, on offer.');
    expect(text(repriced)).toContain('A resource and its price are changed on the website, not by publishing again.');
    for (const service of [priced.services.createOwnerPostForRoute, priced.services.updateOwnerPostForRoute, priced.services.enforceBackendRateLimit]) {
      expect(service).not.toHaveBeenCalled();
    }
    expect(same.services.readPostForAgent).toHaveBeenCalledWith(same.admin, { postId: UPLOAD_POST_ID, viewerUserId: USER_ID });
    // The staged files were spent by the first publish, so their state is not read: it would turn
    // the repeat into a refusal. Nothing is created, changed or counted.
    for (const service of [
      same.services.readAgentStagedUploads, same.services.createOwnerPostForRoute, same.services.updateOwnerPostForRoute,
      same.services.enforceBackendRateLimit, same.services.countAgentPublicPublishesSince,
    ]) {
      expect(service).not.toHaveBeenCalled();
    }
    // The same visibility named explicitly changes nothing either.
    expect(structured(await tool('publish_post').handle({ ...args, visibility: 'public' }, same.context))).toMatchObject({ already_published: true, visibility_changed: false });

    // A post the first call left private (it asked for that, or its promotion failed) says how to open it.
    const kept = harness({ readPostForAgent: found({ visibility: 'private', state: 'private' }) });
    const described = await tool('publish_post').handle(args, kept.context);
    expect(structured(described)).toMatchObject({ already_published: true, visibility: 'private', state: 'private', visibility_changed: false });
    expect(text(described)).toContain('Publish again with the same uploads and visibility public to make it public.');
    // A post moderation hid is not described as live.
    const hidden = harness({ readPostForAgent: found({ state: 'hidden' }) });
    expect(text(await tool('publish_post').handle(args, hidden.context))).toContain('public, but hidden');
  });

  // PR #751's review, finding 10, and the window it sits beside: the composer makes the post's
  // row before it files the media under it. A repeat in that window, or after a publish that
  // failed there, found a post and answered it as published; a visibility change then made a
  // media post public without its media.
  it('answers a media post that holds none of its files as still being saved, or as left unfinished, and changes nothing of it', async () => {
    const two = { ...args, uploads: [{ storage_path: STAGED_PICTURE }, { storage_path: STAGED_CLIP }] };
    const twoPostId = agentUploadPostId(USER_ID, [STAGED_PICTURE, STAGED_CLIP]);
    // The harness's clock stands at 1,000 seconds into 1970: a post made 10 seconds before it is
    // inside the route's own time limit, so the call that made it may still be running.
    const young = harness({
      readPostForAgent: found({ postId: twoPostId, visibility: 'private', state: 'private', createdAt: new Date(990_000).toISOString() }),
      countPostMediaForAgent: vi.fn(async () => 0) as never,
    });
    const saving = await tool('publish_post').handle({ ...two, visibility: 'public' }, young.context);
    expect(toolFailureCode(saving)).toBe('NOT_READY');
    expect(text(saving)).toContain('is still being saved by the call that made it: it holds none of its files yet');
    expect(text(saving)).toContain('Call publish_post again with the same uploads');
    expect(young.services.countPostMediaForAgent).toHaveBeenCalledWith(young.admin, twoPostId);

    // Older than the route can run: no call is still saving it.
    const old = harness({
      readPostForAgent: found({ postId: twoPostId, visibility: 'private', state: 'private', createdAt: new Date(1_000_000 - (MCP_ROUTE_MAX_DURATION_SECONDS + 1) * 1000).toISOString() }),
      countPostMediaForAgent: vi.fn(async () => 0) as never,
    });
    const unfinished = await tool('publish_post').handle({ ...two, visibility: 'public' }, old.context);
    expect(toolFailureCode(unfinished)).toBe('CONFLICT');
    expect(text(unfinished)).toContain('was left unfinished by a publish that failed midway: it holds none of its files');
    expect(text(unfinished)).toContain('Delete it with delete_post');
    // The same answer without a visibility change: an unfinished post is never called published.
    expect(toolFailureCode(await tool('publish_post').handle(two, old.context))).toBe('CONFLICT');

    const unread = harness({ readPostForAgent: found({ postId: twoPostId }), countPostMediaForAgent: vi.fn(async () => null) as never });
    expect(toolFailureCode(await tool('publish_post').handle(two, unread.context))).toBe('UNAVAILABLE');

    for (const made of [young, old, unread]) {
      for (const service of [made.services.updateOwnerPostForRoute, made.services.createOwnerPostForRoute, made.services.enforceBackendRateLimit]) {
        expect(service).not.toHaveBeenCalled();
      }
    }
    // A post that holds every file is answered as before.
    const whole = harness({ readPostForAgent: found({ postId: twoPostId }), countPostMediaForAgent: vi.fn(async () => 2) as never });
    expect(structured(await tool('publish_post').handle(two, whole.context))).toMatchObject({ post_id: twoPostId, already_published: true });
  });

  // The re-review of PR #751: the media rows go in as one insert, so a post that holds some of
  // the files a repeat names is whole. Its creator removed a picture on the website; counting
  // "fewer than named" told the agent the post was broken and to delete it, for good.
  it('answers a post whose creator removed a file on the website as published, at any age, and changes its visibility', async () => {
    const two = { ...args, uploads: [{ storage_path: STAGED_PICTURE }, { storage_path: STAGED_CLIP }] };
    const twoPostId = agentUploadPostId(USER_ID, [STAGED_PICTURE, STAGED_CLIP]);
    for (const createdAt of [new Date(990_000).toISOString(), new Date(1_000_000 - (MCP_ROUTE_MAX_DURATION_SECONDS + 1) * 1000).toISOString()]) {
      const edited = harness({ readPostForAgent: found({ postId: twoPostId, createdAt }), countPostMediaForAgent: vi.fn(async () => 1) as never });
      const repeated = await tool('publish_post').handle(two, edited.context);
      expect(structured(repeated), createdAt).toMatchObject({ post_id: twoPostId, already_published: true, visibility_changed: false });
      const madePrivate = await tool('publish_post').handle({ ...two, visibility: 'private' }, edited.context);
      expect(structured(madePrivate), createdAt).toMatchObject({ post_id: twoPostId, visibility: 'private', visibility_changed: true });
      expect(edited.services.updateOwnerPostForRoute, createdAt).toHaveBeenCalledTimes(1);
    }
  });

  it('changes an existing upload post\'s visibility through the composer\'s own save, under the limits a publish passes', async () => {
    const flip = harness({ readPostForAgent: found() });
    const madePrivate = await tool('publish_post').handle({ ...args, visibility: 'private' }, flip.context);
    expect(structured(madePrivate)).toEqual({
      post_id: UPLOAD_POST_ID,
      post_url: UPLOAD_POST_URL,
      visibility: 'private',
      state: 'private',
      already_published: true,
      visibility_changed: true,
      source: 'upload',
      ...NO_RESOURCE_FIELDS,
    });
    // The post has no creation behind it, so the creation path's republish cannot carry the
    // change: the composer's save takes the visibility alone and keeps everything else.
    expect(flip.services.updateOwnerPostForRoute).toHaveBeenCalledWith({
      adminSupabase: flip.admin,
      ownerUserId: USER_ID,
      postId: UPLOAD_POST_ID,
      body: { visibility: 'private' },
      runAfterResponse: flip.context.runAfterResponse,
    });
    expect(flip.services.publishGenerationToShowcaseForRoute).not.toHaveBeenCalled();
    expect(flip.services.createOwnerPostForRoute).not.toHaveBeenCalled();
    // Going private counts no public post.
    expect(vi.mocked(flip.services.enforceBackendRateLimit).mock.calls.map(([, options]) => options.scope)).toEqual([SHOWCASE_PUBLISH_RATE_LIMIT.scope]);
    expect(flip.services.countAgentPublicPublishesSince).not.toHaveBeenCalled();

    // Going public is a public publication: the day's count is read, and a full day refuses it.
    const open = harness({ readPostForAgent: found({ visibility: 'private', state: 'private' }) });
    const madePublic = await tool('publish_post').handle({ ...args, visibility: 'public' }, open.context);
    expect(structured(madePublic)).toMatchObject({ visibility: 'public', state: 'live', already_published: true, visibility_changed: true });
    expect(text(madePublic)).toContain('Anyone can see it.');
    expect(open.services.countAgentPublicPublishesSince).toHaveBeenCalledTimes(1);

    // A priced resource held as a draft goes on offer with the post, at the price it had: the
    // save answers its status, and the tool adds nothing of its own.
    const onOffer = harness({
      readPostForAgent: found({ visibility: 'private', state: 'private', resource: { access: 'paid', priceTokens: 250, status: 'draft' } }),
      updateOwnerPostForRoute: vi.fn(async ({ postId }: { postId: string }) => ({
        ok: true as const,
        body: { success: true as const, postId, visibility: 'public' as const, showcasePath: `/showcase/${postId}`, ownerPath: `/post/${postId}/edit`, resourceBundlePath: `/showcase/${postId}#recipe`, resourceBundleStatus: 'published' as const },
      })) as never,
    });
    const listed = await tool('publish_post').handle({ ...args, visibility: 'public', resources: [{ type: 'prompt', title: 'The fox prompt', text: 'paper-cut fox' }], resource_price_tokens: 250 }, onOffer.context);
    expect(structured(listed)).toMatchObject({ visibility_changed: true, resource_access: 'paid', resource_price_tokens: 250, resource_status: 'published' });
    expect(text(listed)).toContain('It carries a paid resource at 250 tokens, on offer.');
    // The cards a repeat sends are not compared (no tool reads what a resource holds), so the answer says they were not applied.
    expect(text(listed)).toContain('Its resource is the one it was published with');
    expect(onOffer.services.updateOwnerPostForRoute).toHaveBeenCalledWith(expect.objectContaining({ body: { visibility: 'public' } }));
  });

  // PR #751's review, finding 2: a repeat that changed the visibility dropped a new price without
  // a word, so "make it public at 250" put a free resource on offer.
  it('refuses a repeat that asks for a visibility change and names a price, a mature mark or a resource the post does not have, before any limit is spent', async () => {
    const card = { type: 'prompt' as const, title: 'The fox prompt', text: 'paper-cut fox' };
    const cases: Array<[string, Partial<AgentPostView>, Record<string, unknown>, string, RegExp]> = [
      ['a price on a free resource', { resource: { access: 'free', priceTokens: 0, status: 'draft' } }, { resources: [card], resource_price_tokens: 250 }, 'resource_price_tokens', /already exists with a free resource.*a price is changed on the website/u],
      ['another price', { resource: { access: 'paid', priceTokens: 250, status: 'draft' } }, { resources: [card], resource_price_tokens: 990 }, 'resource_price_tokens', /already exists with a paid resource at 250 tokens/u],
      ['free asked of a paid resource', { resource: { access: 'paid', priceTokens: 250, status: 'draft' } }, { resources: [card], resource_price_tokens: 0 }, 'resource_price_tokens', /already exists with a paid resource at 250 tokens/u],
      ['a resource on a post with none', {}, { resources: [card] }, 'resources', /was published with no resource, and publishing again cannot add one/u],
      ['listing lines on a post with none', {}, { resources: [card], resource_preview: 'The exact prompt behind the fox.' }, 'resources', /was published with no resource/u],
      ['a mature mark the post does not have', {}, { is_nsfw: true }, 'is_nsfw', /is not marked mature.*the mark is changed on the website/u],
      ['a mature mark taken off', { isNsfw: true }, { is_nsfw: false }, 'is_nsfw', /is marked mature/u],
    ];
    for (const [label, stored, extra, field, words] of cases) {
      const repeat = harness({ readPostForAgent: found({ visibility: 'private', state: 'private', ...stored }) });
      const result = await tool('publish_post').handle({ ...args, visibility: 'public', ...extra }, repeat.context);
      expect(toolFailureCode(result), label).toBe('INVALID_REQUEST');
      expect((structured(result).error as { field_errors: Record<string, string> }).field_errors[field], label).toMatch(words);
      expect(text(result), label).toContain('Nothing was changed');
      // The post stays as it is, and nothing is spent: no save, no limit, no cap read.
      for (const service of [repeat.services.updateOwnerPostForRoute, repeat.services.createOwnerPostForRoute, repeat.services.enforceBackendRateLimit, repeat.services.countAgentPublicPublishesSince]) {
        expect(service, label).not.toHaveBeenCalled();
      }
    }
    // The same arguments the post was published with change the visibility alone.
    const same = harness({ readPostForAgent: found({ visibility: 'private', state: 'private', isNsfw: true, resource: { access: 'free', priceTokens: 0, status: 'draft' } }) });
    const opened = await tool('publish_post').handle({ ...args, visibility: 'public', is_nsfw: true, resources: [card], resource_price_tokens: 0 }, same.context);
    expect(opened.isError).toBeUndefined();
    expect(structured(opened)).toMatchObject({ visibility_changed: true, visibility: 'public' });
  });

  // Finding 12: the composer's save takes an archived post's visibility, and the answer called it live.
  it('changes no visibility of a post that is archived, hidden or removed, and says which', async () => {
    for (const state of ['archived', 'hidden', 'removed'] as const) {
      const shelved = harness({ readPostForAgent: found({ visibility: 'private', state }) });
      const result = await tool('publish_post').handle({ ...args, visibility: 'public' }, shelved.context);
      expect(toolFailureCode(result), state).toBe('CONFLICT');
      expect(text(result), state).toContain(`is ${state}`);
      for (const service of [shelved.services.updateOwnerPostForRoute, shelved.services.enforceBackendRateLimit, shelved.services.countAgentPublicPublishesSince]) {
        expect(service, state).not.toHaveBeenCalled();
      }
    }
  });

  // Finding 6: a stored resource that fails the listing rule stays a draft on a post that went
  // public, and the answer said it was held "while its post is not public".
  it('says a resource left off offer on a post that went public is not listed, and why', async () => {
    const unlisted = harness({
      readPostForAgent: found({ visibility: 'private', state: 'private', resource: { access: 'free', priceTokens: 0, status: 'draft' } }),
      updateOwnerPostForRoute: vi.fn(async ({ postId }: { postId: string }) => ({
        ok: true as const,
        body: { success: true as const, postId, visibility: 'public' as const, showcasePath: `/showcase/${postId}`, ownerPath: `/post/${postId}/edit`, resourceBundlePath: `/post/${postId}/edit#recipe`, resourceBundleStatus: 'draft' as const },
      })) as never,
    });
    const result = await tool('publish_post').handle({ ...args, visibility: 'public' }, unlisted.context);
    expect(structured(result)).toMatchObject({ visibility: 'public', state: 'live', resource_access: 'free', resource_status: 'draft' });
    expect(text(result)).toContain('It carries a free resource, but it is not on offer');
    expect(text(result)).toContain('a preview or summary');
    expect(text(result)).not.toContain('only while its post is public');
  });

  // Finding 5: the composer claims each file before the post's row exists, so a retry in that
  // moment found no post and a file "already used", and was told to stage again: a second post.
  it('tells a retry that arrives while the first publish is still running to call again, never to stage the files again', async () => {
    const { context, services } = fresh({ readAgentStagedUploads: stagedAs({ kind: 'staged', status: 'consuming', contentType: 'image/png' }) });
    const result = await tool('publish_post').handle(args, context);
    expect(toolFailureCode(result)).toBe('NOT_READY');
    expect(text(result)).toContain('is being published by another call right now');
    expect(text(result)).toContain('Call publish_post again with the same uploads');
    expect(text(result)).not.toMatch(/[Ss]tage the file again/u);
    expect(services.createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(services.enforceBackendRateLimit).not.toHaveBeenCalled();
    const capped = harness({ readPostForAgent: found({ visibility: 'private', state: 'private' }), countAgentPublicPublishesSince: vi.fn(async () => 10) as never });
    expect(toolFailureCode(await tool('publish_post').handle({ ...args, visibility: 'public' }, capped.context))).toBe('RATE_LIMITED');
    expect(capped.services.updateOwnerPostForRoute).not.toHaveBeenCalled();

    // The save's own refusals: a post under a moderation decision, one gone since the read, its limit.
    const refusals: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ status: 409, body: { error: 'This post is locked while a moderation decision is in effect.' } }, 'CONFLICT', /locked while a moderation decision/u],
      [{ status: 404, body: { error: 'Post not found.' } }, 'NOT_FOUND', /Post not found/u],
      [{ status: 429, rateLimitError: rateLimit(30), body: { error: 'Too many', code: 'RATE_LIMITED', retryAfterSeconds: 30, limit: 60, resetAt: 'x' } }, 'RATE_LIMITED', /30 seconds/u],
      [{ status: 400, body: { error: 'Add your name and handle to publish publicly.', actionHref: '/profile/edit', actionLabel: 'Edit profile' } }, 'INVALID_REQUEST', /name and handle/u],
      // The listing rule a stored resource is held to when its post goes public.
      [{ status: 400, body: { error: 'Complete your profile before publishing: Choose a custom handle and add your display name before publishing a recipe.', field: 'profile', actionHref: '/profile', actionLabel: 'Complete profile and return' } }, 'INVALID_REQUEST', /The person sets their handle and display name on the website/u],
    ];
    for (const [answer, code, words] of refusals) {
      const refused = harness({ readPostForAgent: found(), updateOwnerPostForRoute: vi.fn(async () => ({ ok: false, ...answer })) as never });
      const result = await tool('publish_post').handle({ ...args, visibility: 'private' }, refused.context);
      expect(toolFailureCode(result), code).toBe(code);
      expect(text(result), code).toMatch(words);
      expect(JSON.stringify(result), code).not.toMatch(/actionHref|actionLabel|\/profile|Edit profile|Complete profile and return/u);
    }
  });

  it('carries a resource with the uploads as the composer\'s serializer makes it, free or at the person\'s price', async () => {
    const cards = [
      { type: 'prompt' as const, title: 'The fox prompt', description: 'The exact prompt.', text: 'paper-cut fox, snowy forest, soft light' },
      { type: 'external_link' as const, title: 'Paper stock', url: 'https://example.com/paper' },
    ];
    // The composer's create answers the status the stored bundle has: on offer on a public post.
    const answering = (status: 'draft' | 'published') => vi.fn(async ({ readFormData, createPostId }: { readFormData: () => Promise<FormData>; createPostId: () => string }) => {
      const form = await readFormData();
      const postId = createPostId();
      const visibility = form.get('visibility') === 'private' ? 'private' as const : 'public' as const;
      return { ok: true as const, body: { success: true as const, postId, visibility, showcasePath: `/showcase/${postId}`, ownerPath: `/post/${postId}/edit`, resourceBundlePath: `/showcase/${postId}#recipe`, resourceBundleStatus: status } };
    }) as never;

    const free = fresh({ createOwnerPostForRoute: answering('published') });
    const shared = await tool('publish_post').handle({ ...args, resources: cards }, free.context);
    expect(shared.isError).toBeUndefined();
    expect(structured(shared)).toMatchObject({ source: 'upload', media_count: 1, recipe_included: false, resources_included: 2, resource_access: 'free', resource_price_tokens: 0, resource_status: 'published' });
    expect(text(shared)).toContain('It carries a free resource, on offer.');
    expect((await sent(free.services)).fields.resourceBundle).toEqual(buildAgentResourceBundle({ cards }));
    expect((await sent(free.services)).fields.resourceBundle).toMatchObject({ accessMode: 'free', priceUsdCents: 0 });

    const paid = fresh({ createOwnerPostForRoute: answering('published') });
    const sold = await tool('publish_post').handle({ ...args, resources: cards, resource_price_tokens: 250, resource_summary: 'The fox prompt and its paper', resource_preview: 'The exact prompt and the paper it was cut from.' }, paid.context);
    expect(structured(sold)).toMatchObject({ resources_included: 2, resource_access: 'paid', resource_price_tokens: 250, resource_status: 'published' });
    expect(text(sold)).toContain('It carries a paid resource at 250 tokens, on offer.');
    const bundle = (await sent(paid.services)).fields.resourceBundle;
    expect(bundle).toEqual(buildAgentResourceBundle({ cards, priceTokens: 250, summary: 'The fox prompt and its paper', preview: 'The exact prompt and the paper it was cut from.' }));
    expect(bundle).toMatchObject({ accessMode: 'paid', priceUsdCents: 250, summary: 'The fox prompt and its paper', previewText: 'The exact prompt and the paper it was cut from.' });
    // An answer names what a resource is, never what it holds.
    expect(JSON.stringify(sold)).not.toContain('paper-cut fox, snowy forest');
    expect(JSON.stringify(sold)).not.toContain('example.com/paper');
    expect(JSON.stringify(structured(sold))).not.toMatch(RESOURCE_CONTENT_KEYS);

    // Private: the composer holds the resource as a draft, and the answer says it is not on sale.
    const privately = fresh({ createOwnerPostForRoute: answering('draft') });
    const held = await tool('publish_post').handle({ ...args, visibility: 'private', resources: cards, resource_price_tokens: 250 }, privately.context);
    expect(structured(held)).toMatchObject({ visibility: 'private', resource_access: 'paid', resource_price_tokens: 250, resource_status: 'draft' });
    expect(text(held)).toContain('held as a draft: a resource is on offer only while its post is public.');
  });

  it('publishes nothing when it cannot tell whether the uploads are already published, or cannot read them', async () => {
    const blind = harness({ readPostForAgent: vi.fn(async () => ({ ok: false, code: 'UNAVAILABLE' })) as never });
    const result = await tool('publish_post').handle(args, blind.context);
    expect(toolFailureCode(result)).toBe('UNAVAILABLE');
    expect(text(result)).toContain('Nothing was published');
    expect(blind.services.createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(blind.services.enforceBackendRateLimit).not.toHaveBeenCalled();

    const unread = fresh({ readAgentStagedUploads: vi.fn(async () => ({ ok: false })) as never });
    const failed = await tool('publish_post').handle(args, unread.context);
    expect(toolFailureCode(failed)).toBe('UNAVAILABLE');
    expect(unread.services.createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(unread.services.enforceBackendRateLimit).not.toHaveBeenCalled();
  });

  it('refuses a path that is not a file staged through upload_input and still unused, before any limit is spent', async () => {
    const cases: Array<[AgentStagedUpload, string, RegExp]> = [
      // A path in the caller's folder that no upload was signed for.
      [{ kind: 'unknown' }, 'NOT_FOUND', /is not a file staged with upload_input/u],
      // Sent with curl, or not sent at all, and never finalized: the signature rule has not seen it.
      [{ kind: 'staged', status: 'issued', contentType: 'image/png' }, 'NOT_READY', /has not been through upload_input/u],
      [{ kind: 'staged', status: 'reserved', contentType: 'image/png' }, 'NOT_READY', /call upload_input with its upload_id/u],
      [{ kind: 'staged', status: 'finalizing', contentType: 'image/png' }, 'NOT_READY', /has not been through upload_input/u],
      // Spent by an earlier post or run.
      [{ kind: 'staged', status: 'consumed', contentType: 'image/png' }, 'CONFLICT', /already used by a post or a run/u],
      [{ kind: 'staged', status: 'consumed', contentType: 'image/png' }, 'CONFLICT', /Stage the file again/u],
      // Lapsed, or removed for failing a check.
      [{ kind: 'staged', status: 'deleted', contentType: 'image/png' }, 'NOT_FOUND', /no longer staged/u],
      [{ kind: 'staged', status: 'released', contentType: 'image/png' }, 'NOT_FOUND', /no longer staged/u],
      [{ kind: 'staged', status: 'reclaiming', contentType: 'image/png' }, 'NOT_FOUND', /no longer staged/u],
    ];
    for (const [entry, code, words] of cases) {
      const { context, services } = fresh({ readAgentStagedUploads: stagedAs(entry) });
      const result = await tool('publish_post').handle(args, context);
      const label = `${entry.kind} ${'status' in entry ? entry.status : ''}`;
      expect(toolFailureCode(result), label).toBe(code);
      expect(text(result), label).toMatch(words);
      expect(text(result), label).toContain(`uploads[0] (${STAGED_PICTURE})`);
      expect(structured(result).error, label).toMatchObject({ storage_path: STAGED_PICTURE, field_errors: { uploads: expect.any(String) } });
      expect(services.createOwnerPostForRoute, label).not.toHaveBeenCalled();
      expect(services.enforceBackendRateLimit, label).not.toHaveBeenCalled();
      expect(services.countAgentPublicPublishesSince, label).not.toHaveBeenCalled();
    }
    // The second of two files is named by its place.
    const second = fresh({
      readAgentStagedUploads: vi.fn(async () => ({
        ok: true as const,
        uploads: new Map<string, AgentStagedUpload>([
          [STAGED_PICTURE, { kind: 'staged', status: 'finalized', contentType: 'image/png' }],
          [STAGED_CLIP, { kind: 'staged', status: 'consumed', contentType: 'video/mp4' }],
        ]),
      })) as never,
    });
    expect(text(await tool('publish_post').handle({ ...args, uploads: [{ storage_path: STAGED_PICTURE }, { storage_path: STAGED_CLIP }] }, second.context)))
      .toContain(`uploads[1] (${STAGED_CLIP})`);
  });

  it('leaves another account\'s file to the composer service, whose ownership rule refuses it', async () => {
    // The composer's own parser runs on the form the tool built: what it refuses, the real service refuses.
    const composer = vi.fn(async ({ readFormData, ownerUserId, createPostId }: { readFormData: () => Promise<FormData>; ownerUserId: string; createPostId: () => string }) => {
      const prepared = await preparePostCreationSubmission({ formData: await readFormData(), userId: ownerUserId, sourceToolCatalog: [] });
      if (!prepared.ok) return prepared;
      const postId = createPostId();
      return {
        ok: true as const,
        body: {
          success: true as const,
          postId,
          visibility: prepared.submission.visibility,
          showcasePath: `/showcase/${postId}`,
          ownerPath: `/post/${postId}/edit`,
          resourceBundlePath: `/post/${postId}/edit#recipe`,
          resourceBundleStatus: null,
        },
      };
    });
    const theirs = `uploads/${OTHER_USER_ID}/${UPLOAD_ID}-theirs.png`;
    const { context, services } = fresh({
      createOwnerPostForRoute: composer as never,
      readAgentStagedUploads: stagedAs({ kind: 'foreign' }),
    });
    const refused = await tool('publish_post').handle({ ...args, uploads: [{ storage_path: theirs }] }, context);
    expect(toolFailureCode(refused)).toBe('INVALID_REQUEST');
    expect(text(refused)).toContain('Uploaded media must belong to the authenticated user.');
    // The service was asked, and it is the one that refused.
    expect(composer).toHaveBeenCalledTimes(1);
    expect(services.readAgentStagedUploads).toHaveBeenCalledTimes(1);

    // A file outside the staging bucket is refused by the same service.
    const elsewhere = fresh({ createOwnerPostForRoute: composer as never, readAgentStagedUploads: stagedAs({ kind: 'foreign' }) });
    expect(text(await tool('publish_post').handle({ ...args, uploads: [{ storage_path: `post_media/${USER_ID}/x.png` }] }, elsewhere.context)))
      .toContain('Uploaded media must come from the uploads bucket.');

    // The same service takes the caller's own staged file, so the refusals above are the paths' doing.
    const own = fresh({ createOwnerPostForRoute: composer as never });
    const published = await tool('publish_post').handle(args, own.context);
    expect(published.isError).toBeUndefined();
    expect(structured(published)).toMatchObject({ post_id: UPLOAD_POST_ID, visibility: 'public' });
  });

  it('refuses a category that is not the first file\'s kind by name, before any limit is spent', async () => {
    const { context, services } = fresh();
    const result = await tool('publish_post').handle({ ...args, category: 'video' }, context);
    expect(toolFailureCode(result)).toBe('INVALID_REQUEST');
    expect((structured(result).error as { field_errors: Record<string, string> }).field_errors.category)
      .toBe('category files the post by its first upload, which is a picture: give image, or leave category out.');
    expect(services.createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(services.enforceBackendRateLimit).not.toHaveBeenCalled();
    // The first file's own kind stands, and so does a clip filed as video.
    expect((await tool('publish_post').handle({ ...args, category: 'image' }, fresh().context)).isError).toBeUndefined();
    const clip = fresh();
    expect((await tool('publish_post').handle({ ...args, uploads: [{ storage_path: STAGED_CLIP }, { storage_path: STAGED_PICTURE }], category: 'video' }, clip.context)).isError).toBeUndefined();
  });

  it('names a refusal\'s field only where it is one of the tool\'s arguments, and answers a thin preview with the argument that fixes it', async () => {
    const refusing = (body: Record<string, unknown>) => fresh({ createOwnerPostForRoute: vi.fn(async () => ({ ok: false, status: 400, body })) as never });
    const call = (made: ReturnType<typeof fresh>) => tool('publish_post').handle({ ...args, resources: [{ type: 'prompt', title: 'Tip', text: 'Use heavier paper.' }] }, made.context);
    // The safety check names the part of the resource it refused in the service's own terms: not passed on.
    const unsafe = await call(refusing({ error: 'This post cannot be published publicly.', field: 'resourcePrompt' }));
    expect(toolFailureCode(unsafe)).toBe('INVALID_REQUEST');
    expect(structured(unsafe).error).not.toHaveProperty('field_errors');
    expect(JSON.stringify(unsafe)).not.toContain('resourcePrompt');
    // An argument of the tool is named as it is.
    expect(structured(await call(refusing({ error: 'Descriptions are limited to 1000 characters.', field: 'description' }))).error)
      .toMatchObject({ field_errors: { description: expect.any(String) } });
    // The listing rule names no field for a preview that says too little: its words do.
    const thin = await call(refusing({ error: 'Improve this recipe before publishing: Add a useful preview or summary that tells buyers what the recipe includes.' }));
    expect(structured(thin).error).toMatchObject({ field_errors: { resource_preview: expect.stringContaining('Add a useful preview or summary') } });
  });

  it('maps the composer service\'s refusals to stable codes with its own message, and never a link', async () => {
    const cases: Array<[Record<string, unknown>, string, RegExp, string?]> = [
      [{ status: 400, body: { error: 'Add a title for your post.', field: 'title' } }, 'INVALID_REQUEST', /Add a title for your post/u, 'title'],
      // The composer's field names are answered as the tool's arguments.
      [{ status: 400, body: { error: 'The source tool name "All" is reserved.', field: 'sourceTools' } }, 'INVALID_REQUEST', /is reserved/u, 'made_with'],
      [{ status: 400, body: { error: 'Audio uploads are not supported in Explore yet.' } }, 'INVALID_REQUEST', /Audio uploads are not supported/u],
      // The web's follow-up link (complete your profile) stays on the web.
      [{ status: 400, body: { error: 'Add your name and handle to publish publicly.', actionHref: '/profile/edit', actionLabel: 'Edit profile' } }, 'INVALID_REQUEST', /Add your name and handle/u],
      [{ status: 400, body: { error: 'That upload was already consumed with a non-reusable disposition.' } }, 'INVALID_REQUEST', /already consumed/u],
      [{ status: 429, rateLimitError: rateLimit(30), body: { error: 'Too many', code: 'RATE_LIMITED', retryAfterSeconds: 30, limit: 60, resetAt: 'x' } }, 'RATE_LIMITED', /30 seconds/u],
      [{ status: 500, body: { error: 'Failed to prepare uploaded media.' } }, 'UNAVAILABLE', /Call publish_post again with the same uploads/u],
      // The post may exist privately after this one: the repeat finds it by its derived id.
      [{ status: 500, body: { error: 'Your post was saved as a private draft, but publishing failed. Open it from your posts to publish again.' } }, 'UNAVAILABLE', /it answers the post if one was saved/u],
      // A resource the service refuses: its validator's own words, its field under the tool's name.
      [{ status: 400, body: { error: 'Paid recipes must cost at least 10 credits and use 10-credit increments.' } }, 'INVALID_REQUEST', /Paid recipes must cost at least 10 credits and use 10-credit increments\./u],
      [{ status: 400, body: { error: 'Package previews are limited to 180 characters.', field: 'resourcePreview' } }, 'INVALID_REQUEST', /Package previews are limited to 180 characters\./u, 'resource_preview'],
      [{ status: 400, body: { error: 'Public summaries are limited to 180 characters.', field: 'resourceSummary' } }, 'INVALID_REQUEST', /Public summaries are limited to 180 characters\./u, 'resource_summary'],
      [{ status: 400, body: { error: 'Unlocked descriptions are limited to 120 characters.', field: 'resourceCards' } }, 'INVALID_REQUEST', /Unlocked descriptions are limited to 120 characters\./u, 'resources'],
      [{ status: 400, body: { error: 'Improve this recipe before publishing: Add a useful preview or summary that tells buyers what the recipe includes.' } }, 'INVALID_REQUEST', /Add a useful preview or summary/u],
      [{ status: 400, body: { error: 'A recipe needs a title of at least 3 characters.', field: 'title', code: 'RECIPE_TITLE_TOO_SHORT' } }, 'INVALID_REQUEST', /A recipe needs a title of at least 3 characters\./u, 'title'],
      // The seller's profile: the web's answer is a link to it, the agent's is words.
      [{ status: 400, body: { error: 'Complete your profile before publishing: Choose a custom handle and add your display name before publishing a recipe.', field: 'profile', actionHref: '/profile', actionLabel: 'Complete profile and return' } }, 'INVALID_REQUEST', /Choose a custom handle and add your display name before publishing a recipe\. The person sets their handle and display name on the website, then you publish again\./u],
    ];
    for (const [answer, code, words, field] of cases) {
      const { context } = fresh({ createOwnerPostForRoute: vi.fn(async () => ({ ok: false, ...answer })) as never });
      const result = await tool('publish_post').handle({ ...args, resources: [{ type: 'prompt', title: 'Hook prompt', text: 'Cinematic hook, 35mm' }], resource_price_tokens: 250 }, context);
      const label = JSON.stringify(answer);
      expect(toolFailureCode(result), label).toBe(code);
      expect(text(result), label).toMatch(words);
      expect(JSON.stringify(result), label).not.toMatch(/actionHref|actionLabel|\/profile|Edit profile|Complete profile and return/u);
      if (field) expect(structured(result).error, label).toMatchObject({ field_errors: { [field]: expect.any(String) } });
      // A refusal over the profile names no argument: none of the tool's fixes it.
      if ((answer.body as { field?: string }).field === 'profile') expect(structured(result).error, label).not.toHaveProperty('field_errors');
    }
  });
});

describe('publish_post as a text post', () => {
  const args = {
    title: 'A prompt for product shots',
    body: 'Three lines that work.\nTry them on a white sweep.',
  };
  const GUIDE = { type: 'guide' as const, title: 'Studio-shot skill', description: 'A skill for clean product shots.', text: '# Studio shots\n1. Light from the left.\n2. Shoot on a white sweep.' };
  /** The id a text post of that title and body gets, whichever call asks. */
  const TEXT_POST_ID = agentTextPostId(USER_ID, args.title, args.body);
  const TEXT_POST_URL = `${SITE}/showcase/${TEXT_POST_ID}`;

  /** A harness in which no post exists yet under the id this text derives. */
  function fresh(overrides: Partial<McpToolServices> = {}) {
    return harness({ readPostForAgent: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })) as never, ...overrides });
  }

  /** A read that finds the post an earlier publish of this text made. */
  function found(overrides: Partial<AgentPostView> = {}) {
    return vi.fn(async () => ({ ok: true, post: post({ postId: TEXT_POST_ID, generationId: null, source: 'text', format: 'text', category: 'text', title: args.title, body: args.body, ...overrides }) })) as never;
  }

  /** The composer's create, answering the status its stored bundle would have. */
  function composing(status: 'draft' | 'published' | null) {
    return vi.fn(async ({ readFormData, createPostId }: { readFormData: () => Promise<FormData>; createPostId: () => string }) => {
      const form = await readFormData();
      const postId = createPostId();
      const visibility = form.get('visibility') === 'private' ? 'private' as const : 'public' as const;
      return { ok: true as const, body: { success: true as const, postId, visibility, showcasePath: visibility === 'private' ? null : `/showcase/${postId}`, ownerPath: `/post/${postId}/edit`, resourceBundlePath: `/post/${postId}/edit#recipe`, resourceBundleStatus: status } };
    }) as never;
  }

  async function sent(services: McpToolServices, call = 0) {
    const [input] = vi.mocked(services.createOwnerPostForRoute).mock.calls[call] as unknown as [
      { adminSupabase: unknown; ownerUserId: string; readFormData: () => Promise<FormData>; createPostId: () => string },
    ];
    const json = new Set(['sourceTools', 'resourceBundle', 'mediaItems']);
    const fields = Object.fromEntries(
      [...(await input.readFormData()).entries()].map(([key, value]) => [key, json.has(key) ? JSON.parse(String(value)) : value]),
    ) as Record<string, unknown>;
    return { input, fields };
  }

  it('publishes a title and a body live through the composer\'s own create, as the composer\'s text post, under the post\'s derived id and both limits', async () => {
    const { context, services, admin } = fresh();
    const result = await tool('publish_post').handle({ ...args, description: 'For studio work.' }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({
      post_id: TEXT_POST_ID,
      post_url: TEXT_POST_URL,
      visibility: 'public',
      state: 'live',
      already_published: false,
      visibility_changed: false,
      source: 'text',
      media_count: 0,
      recipe_included: false,
      resources_included: 0,
      ...NO_RESOURCE_FIELDS,
    });
    expect(text(result)).toMatch(/Published the text post as post .* It is public now; anyone can see it, and it goes through moderation as any post does\./u);
    expect(text(result)).toContain(TEXT_POST_URL);
    expect(text(result)).toContain('Keep this post_id: list_creations lists creations, not text posts.');

    const { input, fields } = await sent(services);
    expect(input.adminSupabase).toBe(admin);
    expect(input.ownerUserId).toBe(USER_ID);
    // Derived from the creator, the title and the text: a repeat finds this post.
    expect(input.createPostId()).toBe(TEXT_POST_ID);
    expect(fields).toEqual({
      title: 'A prompt for product shots',
      body: 'Three lines that work.\nTry them on a white sweep.',
      description: 'For studio work.',
      visibility: 'public',
      isNsfw: 'false',
      resourceBundle: { accessMode: 'none' },
      postFormat: 'text',
      category: 'text',
    });
    expect(services.readPostForAgent).toHaveBeenCalledWith(admin, { postId: TEXT_POST_ID, viewerUserId: USER_ID });
    // The web's publish limit, then the agent's daily cap read from the ledger, as for any post.
    expect(vi.mocked(services.enforceBackendRateLimit).mock.calls.map(([, options]) => options)).toEqual([{ ...SHOWCASE_PUBLISH_RATE_LIMIT, key: USER_ID }]);
    expect(services.countAgentPublicPublishesSince).toHaveBeenCalledWith(admin, { userId: USER_ID, since: new Date('1970-01-01T00:00:00.000Z') });
    // No file is read, and nothing of the creation path runs.
    for (const service of [services.readAgentStagedUploads, services.readCreationForPublish, services.publishGenerationToShowcaseForRoute, services.updateOwnerPostForRoute]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it('is a form the composer service takes: a text post filed as text, written here', async () => {
    const composer = vi.fn(async ({ readFormData, ownerUserId, createPostId }: { readFormData: () => Promise<FormData>; ownerUserId: string; createPostId: () => string }) => {
      const prepared = await preparePostCreationSubmission({ formData: await readFormData(), userId: ownerUserId, sourceToolCatalog: [] });
      if (!prepared.ok) return prepared;
      expect(prepared.submission).toMatchObject({ postFormat: 'text', category: 'text', sourceKind: 'manual', hasSubmittedMedia: false, resourceBundle: { accessMode: 'paid', priceUsdCents: 250 } });
      const postId = createPostId();
      return { ok: true as const, body: { success: true as const, postId, visibility: prepared.submission.visibility, showcasePath: `/showcase/${postId}`, ownerPath: `/post/${postId}/edit`, resourceBundlePath: `/showcase/${postId}#recipe`, resourceBundleStatus: 'published' as const } };
    });
    const { context } = fresh({ createOwnerPostForRoute: composer as never });
    const result = await tool('publish_post').handle({ ...args, resources: [GUIDE], resource_price_tokens: 250 }, context);
    expect(result.isError).toBeUndefined();
    expect(composer).toHaveBeenCalledTimes(1);
    expect(structured(result)).toMatchObject({ post_id: TEXT_POST_ID, source: 'text', resource_access: 'paid', resource_price_tokens: 250, resource_status: 'published' });
  });

  it('needs its title and its body, and refuses a category, allow_remixes and Magicbooklet\'s own name, before anything is read or spent', async () => {
    const { context, services } = fresh();
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ body: args.body }, 'title', /title is required for a text post/u],
      [{ ...args, title: '' }, 'title', /title is required for a text post/u],
      [{ title: args.title }, 'body', /for a text post, title and body/u],
      [{ ...args, body: '' }, 'body', /A post needs a source/u],
      // A text post is filed as text, and has no recipe to remix.
      [{ ...args, category: 'image' }, 'category', /a text post is filed as text/u],
      [{ ...args, allow_remixes: true }, 'allow_remixes', /a text post or a post made from uploads has no recipe to remix/u],
      [{ ...args, allow_remixes: false }, 'allow_remixes', /no recipe to remix/u],
      // made_with is optional here, and held to the same rules where given.
      [{ ...args, made_with: [{ tool: 'Magic Booklet' }] }, 'made_with', /Magic Booklet is not a name for made_with/u],
      [{ ...args, made_with: [{ tool: 'Custom' }] }, 'made_with', /The source tool name "Custom" is reserved\./u],
    ];
    for (const [input, field, words] of cases) {
      const result = await tool('publish_post').handle(input as never, context);
      expect(toolFailureCode(result), String(words)).toBe('INVALID_REQUEST');
      expect((structured(result).error as { field_errors: Record<string, string> }).field_errors[field], String(words)).toMatch(words);
    }
    for (const service of [
      services.readPostForAgent, services.readAgentStagedUploads, services.enforceBackendRateLimit,
      services.countAgentPublicPublishesSince, services.createOwnerPostForRoute, services.updateOwnerPostForRoute,
    ]) {
      expect(service).not.toHaveBeenCalled();
    }

    // Without made_with nothing is filed under Made with; with one, the composer's fields carry it.
    const named = fresh();
    expect((await tool('publish_post').handle({ ...args, made_with: [{ tool: 'Midjourney', model: 'v7' }] }, named.context)).isError).toBeUndefined();
    expect((await sent(named.services)).fields).toMatchObject({
      sourceTool: 'Midjourney',
      sourceTools: [{ toolLabel: 'Midjourney', toolSlug: 'midjourney', modelLabel: 'v7', modelSlug: 'v7' }],
      postFormat: 'text',
    });
  });

  it('shares a skill: a guide card rides as the bundle the composer\'s serializer makes, free unless a price is given', async () => {
    const { context, services } = fresh({ createOwnerPostForRoute: composing('published') });
    const result = await tool('publish_post').handle({ ...args, resources: [GUIDE] }, context);
    expect(result.isError).toBeUndefined();
    const { fields } = await sent(services);
    // What the composer service receives for a text post with a guide card.
    expect(fields.postFormat).toBe('text');
    expect(fields.category).toBe('text');
    expect(fields.resourceBundle).toEqual(buildAgentResourceBundle({ cards: [GUIDE] }));
    expect(fields.resourceBundle).toEqual({
      accessMode: 'free',
      summary: 'Studio-shot skill',
      previewText: 'Includes Studio-shot skill.',
      priceUsdCents: 0,
      resources: {
        promptText: null,
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
        sections: [expect.objectContaining({ id: 'agent-resource-1', publicTitle: 'Studio-shot skill', resourceType: 'note', description: 'A skill for clean product shots.' })],
        items: [expect.objectContaining({ id: 'agent-resource-1-item-1', type: 'note', title: 'Studio-shot skill', textContent: GUIDE.text, sectionId: 'agent-resource-1' })],
      },
    });
    expect(fields).not.toHaveProperty('mediaItems');
    expect(structured(result)).toMatchObject({ source: 'text', resources_included: 1, resource_access: 'free', resource_price_tokens: 0, resource_status: 'published', recipe_included: false });
    expect(text(result)).toContain('It carries a free resource, on offer.');
    // The skill's text is on the post for whoever unlocks it, never in the answer.
    expect(JSON.stringify(result)).not.toContain('Light from the left');
    expect(JSON.stringify(structured(result))).not.toMatch(RESOURCE_CONTENT_KEYS);
  });

  it('sells a resource at the person\'s price, as the composer sends a paid one, and holds it as a draft on a private post', async () => {
    const paid = fresh({ createOwnerPostForRoute: composing('published') });
    const sold = await tool('publish_post').handle({ ...args, resources: [GUIDE], resource_price_tokens: 250 }, paid.context);
    expect(sold.isError).toBeUndefined();
    const bundle = (await sent(paid.services)).fields.resourceBundle as Record<string, unknown>;
    // The serializer's paid bundle for these cards: the access mode and the token count, nothing computed.
    expect(bundle).toEqual(buildAgentResourceBundle({ cards: [GUIDE], priceTokens: 250 }));
    expect(bundle).toMatchObject({ accessMode: 'paid', priceUsdCents: 250 });
    expect({ ...bundle, accessMode: 'free', priceUsdCents: 0 }).toEqual(buildAgentResourceBundle({ cards: [GUIDE] }));
    expect(structured(sold)).toMatchObject({ visibility: 'public', resources_included: 1, resource_access: 'paid', resource_price_tokens: 250, resource_status: 'published' });
    expect(text(sold)).toContain('It carries a paid resource at 250 tokens, on offer.');

    const privately = fresh({ createOwnerPostForRoute: composing('draft') });
    const held = await tool('publish_post').handle({ ...args, visibility: 'private', resources: [GUIDE], resource_price_tokens: 250 }, privately.context);
    expect(structured(held)).toMatchObject({ visibility: 'private', state: 'private', resource_access: 'paid', resource_price_tokens: 250, resource_status: 'draft' });
    expect(text(held)).toContain('It carries a paid resource at 250 tokens, held as a draft: a resource is on offer only while its post is public.');
    expect(privately.services.countAgentPublicPublishesSince).not.toHaveBeenCalled();

    // Free by default, and at a price of 0.
    for (const price of [undefined, 0]) {
      const free = fresh({ createOwnerPostForRoute: composing('published') });
      const shared = await tool('publish_post').handle({ ...args, resources: [GUIDE], ...(price === undefined ? {} : { resource_price_tokens: price }) }, free.context);
      expect(structured(shared), String(price)).toMatchObject({ resource_access: 'free', resource_price_tokens: 0 });
      expect((await sent(free.services)).fields.resourceBundle, String(price)).toMatchObject({ accessMode: 'free', priceUsdCents: 0 });
    }
  });

  it('refuses a price below 10, off the step, a fraction, a negative one and one with no resource, and a card without what it carries, before anything is read or spent', async () => {
    const { context, services } = fresh();
    for (const price of [1, 5, 9, 15, 255, 10.5, 9.99, -10, -250]) {
      const result = await tool('publish_post').handle({ ...args, resources: [GUIDE], resource_price_tokens: price }, context);
      expect(toolFailureCode(result), String(price)).toBe('INVALID_REQUEST');
      expect((structured(result).error as { field_errors: Record<string, string> }).field_errors.resource_price_tokens, String(price))
        .toContain('resource_price_tokens is a whole number of tokens, 10 or more, in steps of 10 (100 tokens = $1.00). Leave it out, or give 0, for a free resource.');
    }
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      // A text post with no resources has nothing to price.
      [{ ...args, resource_price_tokens: 250 }, 'resource_price_tokens', /prices a resource, and this post carries none: give resources/u],
      [{ ...args, resource_summary: 'A skill' }, 'resource_summary', /describe a resource, and this post carries none/u],
      // Each card type's one required thing.
      [{ ...args, resources: [{ type: 'prompt', title: 'Hook prompt' }] }, 'resources', /resources\[0\] is a prompt: give its text\./u],
      [{ ...args, resources: [GUIDE, { type: 'guide', title: 'How to reuse', text: '  ' }] }, 'resources', /resources\[1\] is a guide: give its text\./u],
      [{ ...args, resources: [{ type: 'external_link', title: 'Docs' }] }, 'resources', /resources\[0\] is an external_link: give url, an https address\./u],
      [{ ...args, resources: [{ type: 'external_link', title: 'Docs', url: 'http://example.com/docs' }] }, 'resources', /give url, an https address/u],
      [{ ...args, resources: [{ type: 'external_link', title: 'Docs', url: 'https://example.com', text: 'Read me' }] }, 'resources', /it carries a url, not text/u],
      [{ ...args, resources: [{ ...GUIDE, url: 'https://example.com' }] }, 'resources', /it carries text, not a url/u],
      [{ ...args, resources: [{ ...GUIDE, title: ' ' }] }, 'resources', /resources\[0\] needs a title/u],
      [{ ...args, resources: [] }, 'resources', /at least one card/u],
      [{ ...args, resources: Array.from({ length: AGENT_RESOURCE_CARDS_MAX + 1 }, () => GUIDE) }, 'resources', /at most 10 cards/u],
    ];
    for (const [input, field, words] of cases) {
      const result = await tool('publish_post').handle(input as never, context);
      expect(toolFailureCode(result), String(words)).toBe('INVALID_REQUEST');
      expect((structured(result).error as { field_errors: Record<string, string> }).field_errors[field], String(words)).toMatch(words);
    }
    for (const service of [
      services.readPostForAgent, services.enforceBackendRateLimit, services.countAgentPublicPublishesSince,
      services.createOwnerPostForRoute, services.updateOwnerPostForRoute,
    ]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it('counts a public text post against the daily cap and a private one not at all', async () => {
    const capped = fresh({ countAgentPublicPublishesSince: vi.fn(async () => 10) as never });
    const result = await tool('publish_post').handle(args, capped.context);
    expect(toolFailureCode(result)).toBe('RATE_LIMITED');
    expect(structured(result).error).toMatchObject({ limit: 10, published_today: 10, reset_at: '1970-01-02T00:00:00.000Z' });
    expect(capped.services.createOwnerPostForRoute).not.toHaveBeenCalled();
    const room = fresh({ countAgentPublicPublishesSince: vi.fn(async () => 9) as never });
    expect((await tool('publish_post').handle(args, room.context)).isError).toBeUndefined();

    // A private post is no public publication: a full day does not stop it.
    const privately = fresh({ countAgentPublicPublishesSince: vi.fn(async () => 10) as never });
    const saved = await tool('publish_post').handle({ ...args, visibility: 'private', is_nsfw: true }, privately.context);
    expect(structured(saved)).toMatchObject({ post_id: TEXT_POST_ID, visibility: 'private', state: 'private', source: 'text' });
    expect(text(saved)).toMatch(/Saved the text post as private post .* publish again with the same title and body and visibility public/u);
    expect(privately.services.countAgentPublicPublishesSince).not.toHaveBeenCalled();
    expect((await sent(privately.services)).fields).toMatchObject({ visibility: 'private', isNsfw: 'true', postFormat: 'text', category: 'text' });

    const busy = fresh({ enforceBackendRateLimit: vi.fn(async () => { throw rateLimit(90); }) as never });
    const limited = await tool('publish_post').handle(args, busy.context);
    expect(toolFailureCode(limited)).toBe('RATE_LIMITED');
    expect(busy.services.createOwnerPostForRoute).not.toHaveBeenCalled();
  });

  it('answers the post an earlier publish of the same title and body made, changing nothing, its resource and price included', async () => {
    const same = harness({ readPostForAgent: found({ resource: { access: 'paid', priceTokens: 250, status: 'published' } }) });
    const again = await tool('publish_post').handle({ ...args, resources: [GUIDE], resource_price_tokens: 990 }, same.context);
    expect(again.isError).toBeUndefined();
    expect(structured(again)).toEqual({
      post_id: TEXT_POST_ID,
      post_url: TEXT_POST_URL,
      visibility: 'public',
      state: 'live',
      already_published: true,
      visibility_changed: false,
      source: 'text',
      resource_access: 'paid',
      resource_price_tokens: 250,
      resource_status: 'published',
    });
    expect(text(again)).toContain(`This text post is already published as post ${TEXT_POST_ID} (live, public)`);
    expect(text(again)).toContain('Nothing was changed.');
    expect(text(again)).toContain('A resource and its price are changed on the website, not by publishing again.');
    for (const service of [
      same.services.createOwnerPostForRoute, same.services.updateOwnerPostForRoute, same.services.readAgentStagedUploads,
      same.services.enforceBackendRateLimit, same.services.countAgentPublicPublishesSince,
    ]) {
      expect(service).not.toHaveBeenCalled();
    }
    // The text is read as the composer reads it: outer space and line ends do not make another post.
    const typed = harness({ readPostForAgent: found() });
    await tool('publish_post').handle({ title: `  ${args.title} `, body: `${args.body.replace('\n', '\r\n')}\n` }, typed.context);
    expect(typed.services.readPostForAgent).toHaveBeenCalledWith(typed.admin, { postId: TEXT_POST_ID, viewerUserId: USER_ID });
    // Another body is another post.
    const other = fresh();
    await tool('publish_post').handle({ ...args, body: 'Four lines that work.' }, other.context);
    expect(other.services.readPostForAgent).not.toHaveBeenCalledWith(other.admin, { postId: TEXT_POST_ID, viewerUserId: USER_ID });

    // Private since its first publish: the repeat says how to open it, and an explicit visibility
    // does, through the composer's own save.
    const kept = harness({ readPostForAgent: found({ visibility: 'private', state: 'private' }) });
    expect(text(await tool('publish_post').handle(args, kept.context))).toContain('Publish again with the same title and body and visibility public to make it public.');
    const madePublic = await tool('publish_post').handle({ ...args, visibility: 'public' }, kept.context);
    expect(structured(madePublic)).toMatchObject({ visibility: 'public', state: 'live', already_published: true, visibility_changed: true, source: 'text' });
    expect(kept.services.updateOwnerPostForRoute).toHaveBeenCalledWith({
      adminSupabase: kept.admin,
      ownerUserId: USER_ID,
      postId: TEXT_POST_ID,
      body: { visibility: 'public' },
      runAfterResponse: kept.context.runAfterResponse,
    });
    expect(kept.services.countAgentPublicPublishesSince).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing when it cannot tell whether the text is already published, and maps the composer\'s refusals with its own words', async () => {
    const blind = harness({ readPostForAgent: vi.fn(async () => ({ ok: false, code: 'UNAVAILABLE' })) as never });
    const result = await tool('publish_post').handle(args, blind.context);
    expect(toolFailureCode(result)).toBe('UNAVAILABLE');
    expect(text(result)).toContain('Whether this text post is already published could not be read right now. Nothing was published');
    expect(blind.services.createOwnerPostForRoute).not.toHaveBeenCalled();
    expect(blind.services.enforceBackendRateLimit).not.toHaveBeenCalled();

    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ status: 400, body: { error: 'Text posts are limited to 2000 characters.' } }, 'INVALID_REQUEST', /Text posts are limited to 2000 characters\./u],
      [{ status: 400, body: { error: 'This post cannot be published publicly because it appears to contain abusive, sexual, or dangerous content.', field: 'body' } }, 'INVALID_REQUEST', /cannot be published publicly/u],
      [{ status: 500, body: { error: 'Failed to create post.' } }, 'UNAVAILABLE', /Call publish_post again with the same title and body: it answers the post if one was saved\./u],
    ];
    for (const [answer, code, words] of cases) {
      const { context } = fresh({ createOwnerPostForRoute: vi.fn(async () => ({ ok: false, ...answer })) as never });
      const refused = await tool('publish_post').handle(args, context);
      expect(toolFailureCode(refused), JSON.stringify(answer)).toBe(code);
      expect(text(refused), JSON.stringify(answer)).toMatch(words);
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
      source: 'creation',
      format: 'media',
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
      ...NO_RESOURCE_FIELDS,
    });
    expect(text(result)).toContain('3 saves, 1 comment, 0 remixes, 2 shares');
    expect(text(result)).not.toContain('It carries');
    expect(services.readPostForAgent).toHaveBeenCalledWith(admin, { postId: POST_ID, viewerUserId: USER_ID });

    const hidden = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ state: 'hidden', visibility: 'public' }) })) as never });
    expect(text(await tool('get_post').handle({ post_id: POST_ID }, hidden.context))).toContain('hidden by moderation');
  });

  it('reads a post made from uploads, which has no creation behind it, by the post_id its publish gave', async () => {
    const { context, services, admin } = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ generationId: null, source: 'upload', title: 'Paper-cut fox' }) })) as never });
    const result = await tool('get_post').handle({ post_id: POST_ID }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toMatchObject({ post_id: POST_ID, post_url: `${SITE}/showcase/${POST_ID}`, generation_id: null, title: 'Paper-cut fox', state: 'live', is_own: true });
    expect(text(result)).toContain('It was made from uploaded media, not from a creation here.');
    expect(services.readPostForAgent).toHaveBeenCalledWith(admin, { postId: POST_ID, viewerUserId: USER_ID });
    // A creation's post says nothing of the kind.
    expect(text(await tool('get_post').handle({ post_id: POST_ID }, harness().context))).not.toContain('uploaded media');
    // A text post says what it is.
    const written = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ generationId: null, source: 'text', format: 'text', category: 'text', body: 'Three lines that work.' }) })) as never });
    const read = await tool('get_post').handle({ post_id: POST_ID }, written.context);
    expect(structured(read)).toMatchObject({ generation_id: null, source: 'text', format: 'text', category: 'text', body: 'Three lines that work.' });
    expect(text(read)).toContain('It is a text post.');
    expect(text(read)).not.toContain('uploaded media');
    // A creation's post whose creation was deleted since is still a creation's post, not uploaded media.
    const orphaned = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ generationId: null, source: 'creation' }) })) as never });
    const kept = await tool('get_post').handle({ post_id: POST_ID }, orphaned.context);
    expect(structured(kept)).toMatchObject({ generation_id: null, source: 'creation' });
    expect(text(kept)).toContain('It was made from a creation here that has been deleted since.');
    expect(text(kept)).not.toContain('uploaded media');
  });

  it('says three things of a post\'s resource, its access, its price and whether it is on offer, and never what it holds', async () => {
    const paid = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ generationId: null, source: 'text', format: 'text', isOwn: false, resource: { access: 'paid', priceTokens: 250, status: 'published' } }) })) as never });
    const result = await tool('get_post').handle({ post_id: POST_ID }, paid.context);
    expect(structured(result)).toMatchObject({ is_own: false, resource_access: 'paid', resource_price_tokens: 250, resource_status: 'published' });
    expect(text(result)).toContain('It carries a paid resource at 250 tokens, on offer.');
    // The whole answer is the post's own fields and those three: no card, no text, no link, no listing line.
    expect(Object.keys(structured(result)).sort()).toEqual([
      'allow_remixes', 'body', 'category', 'counts', 'created_at', 'description', 'format', 'generation_id', 'is_nsfw', 'is_own',
      'post_id', 'post_url', 'resource_access', 'resource_price_tokens', 'resource_status', 'source', 'state', 'title', 'visibility',
    ]);
    expect(JSON.stringify(structured(result))).not.toMatch(RESOURCE_CONTENT_KEYS);
    // The read the tool makes is the agent read alone: the bundle read behind the paywall is not among its services.
    expect(Object.keys(paid.services).filter((name) => /bundle|resource|recipe/iu.test(name))).toEqual([]);

    const own = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ visibility: 'private', state: 'private', resource: { access: 'free', priceTokens: 0, status: 'draft' } }) })) as never });
    const draft = await tool('get_post').handle({ post_id: POST_ID }, own.context);
    expect(structured(draft)).toMatchObject({ resource_access: 'free', resource_price_tokens: 0, resource_status: 'draft' });
    expect(text(draft)).toContain('It carries a free resource, held as a draft: a resource is on offer only while its post is public.');
  });

  it('answers NOT_FOUND for a post the agent may not see, and UNAVAILABLE for a failed read', async () => {
    const missing = harness({ readPostForAgent: vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })) as never });
    expect(toolFailureCode(await tool('get_post').handle({ post_id: POST_ID }, missing.context))).toBe('NOT_FOUND');
    // list_creations does not list a post made from uploads: the refusal says how such a post is known.
    expect(text(await tool('get_post').handle({ post_id: POST_ID }, missing.context))).toContain('the post_id publish_post gave');
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
    // A creation's post goes; the creation stays.
    expect(text(result)).toBe(`Post ${POST_ID} is deleted. The creation stays in the creator's library.`);
  });

  it('deletes a post made from uploads through the same service, and says its media goes with it', async () => {
    const { context, services, admin } = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ generationId: null, source: 'upload' }) })) as never });
    const result = await tool('delete_post').handle({ post_id: POST_ID }, context);
    expect(result.isError).toBeUndefined();
    expect(structured(result)).toEqual({ post_id: POST_ID, deleted: true, tombstoned: false });
    expect(services.deleteOwnerPostForRoute).toHaveBeenCalledWith({ adminSupabase: admin, ownerUserId: USER_ID, postId: POST_ID, forceDelete: false });
    // No creation holds a copy: the agent must not tell the person otherwise.
    expect(text(result)).toBe(`Post ${POST_ID} is deleted. It was made from uploaded media, which is removed with it.`);
    expect(tool('delete_post').description).toContain('A post made from uploads has no creation behind it, so its media goes with it, and a text post goes whole.');
    // A delete uses nothing of the post's resource, so it does not read it: that read cannot fail a delete.
    expect(services.readPostForAgent).toHaveBeenCalledWith(admin, { postId: POST_ID, viewerUserId: USER_ID, withResource: false });
    // A post whose creation was deleted since has no creation left to stay and no upload to go.
    const orphaned = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ generationId: null, source: 'creation' }) })) as never });
    expect(text(await tool('delete_post').handle({ post_id: POST_ID }, orphaned.context))).toBe(`Post ${POST_ID} is deleted.`);

    // A text post had nothing beside itself; where people hold its resource they keep it.
    const written = harness({ readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ generationId: null, source: 'text', format: 'text' }) })) as never });
    expect(text(await tool('delete_post').handle({ post_id: POST_ID }, written.context))).toBe(`Post ${POST_ID} is deleted.`);
    const held = harness({
      readPostForAgent: vi.fn(async () => ({ ok: true, post: post({ generationId: null, source: 'text', format: 'text' }) })) as never,
      deleteOwnerPostForRoute: vi.fn(async () => ({ ok: true, body: { success: true, deleted: true, tombstoned: true } })) as never,
    });
    expect(text(await tool('delete_post').handle({ post_id: POST_ID, force: true }, held.context)))
      .toBe(`Post ${POST_ID} is off every public surface; the people who unlocked its resource keep their copy.`);
    expect(tool('delete_post').description).toContain('When people have unlocked the post\'s recipe or resource, free or paid');
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

  it('records a publish of uploads under publish_post with its post and no creation, so the cap and the moderation list hold it unchanged', async () => {
    const publish = { uploads: [{ storage_path: STAGED_PICTURE }], title: 'Paper-cut fox in a snowy forest', made_with: [{ tool: 'Midjourney' }] };
    const postId = agentUploadPostId(USER_ID, [STAGED_PICTURE]);
    const none = () => vi.fn(async () => ({ ok: false, code: 'NOT_FOUND' })) as never;
    const existing = (overrides: Partial<AgentPostView> = {}) => vi.fn(async () => ({ ok: true, post: post({ postId, generationId: null, source: 'upload', ...overrides }) })) as never;

    // A new public post: what the daily cap counts and the moderation list reads.
    const live = harness({ readPostForAgent: none() });
    await runMcpTool(tool('publish_post'), publish, live.context);
    expect(live.records).toEqual([expect.objectContaining({ tool: 'publish_post', outcome: 'ok', code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PUBLIC, postId, generationId: null, costCredits: null })]);

    const privately = harness({ readPostForAgent: none() });
    await runMcpTool(tool('publish_post'), { ...publish, visibility: 'private' }, privately.context);
    expect(privately.records[0]).toEqual(expect.objectContaining({ code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PRIVATE, postId, generationId: null }));

    // An unchanged repeat is no new publication (the cap does not count it), but it still names
    // the post: only an agent's publish makes a post under this id, and the call that made it may
    // have lost its row to the same timeout that made the agent repeat it.
    const repeated = harness({ readPostForAgent: existing() });
    await runMcpTool(tool('publish_post'), publish, repeated.context);
    expect(repeated.records[0]).toEqual(expect.objectContaining({ outcome: 'ok', code: AGENT_PUBLISH_RECORD_CODES.ALREADY_PUBLISHED, postId, generationId: null }));

    const madePrivate = harness({ readPostForAgent: existing() });
    await runMcpTool(tool('publish_post'), { ...publish, visibility: 'private' }, madePrivate.context);
    expect(madePrivate.records[0]).toEqual(expect.objectContaining({ code: AGENT_PUBLISH_RECORD_CODES.MADE_PRIVATE, postId }));
    const madePublic = harness({ readPostForAgent: existing({ visibility: 'private', state: 'private' }) });
    await runMcpTool(tool('publish_post'), { ...publish, visibility: 'public' }, madePublic.context);
    expect(madePublic.records[0]).toEqual(expect.objectContaining({ code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PUBLIC, postId }));

    // A refusal records its code and no post: nothing was made.
    const refused = harness({ readPostForAgent: none() });
    await runMcpTool(tool('publish_post'), { ...publish, made_with: [{ tool: 'Magic Booklet' }] }, refused.context);
    expect(refused.records[0]).toEqual(expect.objectContaining({ outcome: 'error', code: 'INVALID_REQUEST', postId: null, generationId: null }));

    // A text post is recorded the same way: a public one is what the cap counts, and an
    // unchanged repeat still names the post only this tool makes.
    const written = { title: 'A prompt for product shots', body: 'Three lines that work.' };
    const textPostId = agentTextPostId(USER_ID, written.title, written.body);
    const liveText = harness({ readPostForAgent: none() });
    await runMcpTool(tool('publish_post'), { ...written, resources: [{ type: 'guide', title: 'Studio-shot skill', text: '# Studio shots' }], resource_price_tokens: 250 }, liveText.context);
    expect(liveText.records).toEqual([expect.objectContaining({ tool: 'publish_post', outcome: 'ok', code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PUBLIC, postId: textPostId, generationId: null, costCredits: null })]);
    const privateText = harness({ readPostForAgent: none() });
    await runMcpTool(tool('publish_post'), { ...written, visibility: 'private' }, privateText.context);
    expect(privateText.records[0]).toEqual(expect.objectContaining({ code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PRIVATE, postId: textPostId, generationId: null }));
    const existingText = (overrides: Partial<AgentPostView> = {}) => vi.fn(async () => ({ ok: true, post: post({ postId: textPostId, generationId: null, source: 'text', format: 'text', ...overrides }) })) as never;
    const repeatedText = harness({ readPostForAgent: existingText() });
    await runMcpTool(tool('publish_post'), written, repeatedText.context);
    expect(repeatedText.records[0]).toEqual(expect.objectContaining({ outcome: 'ok', code: AGENT_PUBLISH_RECORD_CODES.ALREADY_PUBLISHED, postId: textPostId, generationId: null }));
    const openedText = harness({ readPostForAgent: existingText({ visibility: 'private', state: 'private' }) });
    await runMcpTool(tool('publish_post'), { ...written, visibility: 'public' }, openedText.context);
    expect(openedText.records[0]).toEqual(expect.objectContaining({ code: AGENT_PUBLISH_RECORD_CODES.PUBLISHED_PUBLIC, postId: textPostId }));
    // A refused price records its code and no post, and spends no limit.
    const mispriced = harness({ readPostForAgent: none() });
    await runMcpTool(tool('publish_post'), { ...written, resources: [{ type: 'guide', title: 'Studio-shot skill', text: '# Studio shots' }], resource_price_tokens: 5 }, mispriced.context);
    expect(mispriced.records[0]).toEqual(expect.objectContaining({ outcome: 'error', code: 'INVALID_REQUEST', postId: null, generationId: null }));
    expect(mispriced.services.enforceBackendRateLimit).not.toHaveBeenCalled();

    // request_upload and upload_input record no post and no charge.
    const staging = harness();
    await runMcpTool(tool('request_upload'), { file_name: 'a.png', mime_type: 'image/png', size_bytes: 10 }, staging.context);
    await runMcpTool(tool('upload_input'), { upload_id: UPLOAD_ID }, staging.context);
    expect(staging.records).toEqual([
      expect.objectContaining({ tool: 'request_upload', outcome: 'ok', code: null, postId: null, generationId: null, costCredits: null }),
      expect.objectContaining({ tool: 'upload_input', outcome: 'ok', code: null, postId: null, generationId: null, costCredits: null }),
    ]);
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
