import 'server-only';

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import {
  compileTemplateGraph,
  createTemplateSnapshotHash,
  validateAndCompileTemplateGraph,
} from '@/lib/template-graph-compiler';
import { createVideoPosterBuffer } from '@/lib/video-poster';
import {
  isRecord,
  MediaTemplateError,
  type CompiledTemplateGraph,
  type MediaTemplateDto,
  type MediaTemplateStatus,
  type TemplateCreator,
  type TemplateGraphValidationDto,
  type TemplateInputSlot,
  type TemplateMediaKind,
  type TemplateVersionSnapshot,
} from '@/lib/media-template-types';
import { resolveStoredMediaUrl } from '@/lib/server-helpers';
import type { WorkflowCanvasGraph } from '@/lib/workflow-canvas';

const TEMPLATE_SELECT = [
  'id', 'name', 'description', 'video_url', 'thumbnail_url', 'category',
  'is_active', 'created_at', 'creator_user_id', 'slug', 'source_canvas_id',
  'input_slots', 'output_kind', 'status', 'use_count', 'active_version_id',
  'draft_output_node_id', 'draft_catalog_revision', 'updated_at',
].join(', ');

export type MediaTemplateRow = {
  id: string;
  name: string;
  description: string | null;
  video_url: string | null;
  thumbnail_url: string | null;
  category: string | null;
  is_active: boolean | null;
  created_at: string | null;
  creator_user_id: string | null;
  slug: string | null;
  source_canvas_id: string | null;
  input_slots: unknown;
  output_kind: string | null;
  status: string | null;
  use_count: number | null;
  active_version_id: string | null;
  draft_output_node_id: string | null;
  draft_catalog_revision: string | null;
  updated_at: string | null;
};

type CanvasRow = {
  id: string;
  user_id: string;
  title: string;
  graph: Partial<WorkflowCanvasGraph>;
  revision: number;
};

type TemplateWriteInput = {
  sourceCanvasId?: unknown;
  name?: unknown;
  description?: unknown;
  category?: unknown;
  thumbnailUrl?: unknown;
  outputNodeId?: unknown;
  catalogRevision?: unknown;
};

function normalizeText(value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = normalizeText(value, maxLength);
  if (!text) {
    throw new MediaTemplateError(`${field} is required.`, 400, 'INVALID_TEMPLATE', {
      [field]: `${field} is required.`,
    });
  }
  return text;
}

export function normalizeTemplateInputSlots(value: unknown): TemplateInputSlot[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const key = typeof entry.key === 'string' ? entry.key.trim() : '';
    const kind = entry.kind === 'video' ? 'video' : entry.kind === 'image' ? 'image' : null;
    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 100) : '';
    if (!/^[a-z][a-z0-9_]*$/.test(key) || !kind || !label || seen.has(key)) return [];
    seen.add(key);
    const description = normalizeText(entry.description, 300);
    return [{ key, kind, label, ...(description ? { description } : {}), required: true as const }];
  });
}

export function normalizeTemplateSlug(value: string): string {
  const slug = value.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'template';
}

async function createUniqueSlug(client: SupabaseClient, name: string, templateId?: string): Promise<string> {
  const base = normalizeTemplateSlug(name);
  for (let suffix = 0; suffix < 50; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base.slice(0, 58)}-${suffix + 1}`;
    let query = client.from('templates').select('id').eq('slug', candidate).limit(1);
    if (templateId) query = query.neq('id', templateId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return candidate;
  }
  return `${base.slice(0, 48)}-${randomUUID().slice(0, 8)}`;
}

function templateStatus(value: string | null): MediaTemplateStatus {
  return value === 'active' || value === 'disabled' ? value : 'draft';
}

function templateOutputKind(value: string | null): TemplateMediaKind | null {
  return value === 'image' || value === 'video' ? value : null;
}

async function getCreatorMap(client: SupabaseClient, creatorIds: string[]): Promise<Map<string, TemplateCreator>> {
  const ids = Array.from(new Set(creatorIds.filter(Boolean)));
  if (!ids.length) return new Map();
  const { data, error } = await client.from('profiles')
    .select('id, username, display_name, avatar_url').in('id', ids);
  if (error) throw error;
  const pairs = await Promise.all(((data ?? []) as Array<{
    id: string; username: string | null; display_name: string | null; avatar_url: string | null;
  }>).map(async (profile) => [profile.id, {
    id: profile.id,
    username: profile.username,
    displayName: profile.display_name,
    avatarUrl: profile.avatar_url ? await resolveStoredMediaUrl(client, profile.avatar_url) : null,
  }] as const));
  return new Map(pairs);
}

async function activeVersionCosts(client: SupabaseClient, versionIds: string[]) {
  if (!versionIds.length) return new Map<string, number>();
  const { data, error } = await client.from('template_versions')
    .select('id, estimated_total_credits').in('id', Array.from(new Set(versionIds)));
  if (error) throw error;
  return new Map(((data ?? []) as Array<{ id: string; estimated_total_credits: number }>)
    .map((row) => [row.id, Math.max(0, Number(row.estimated_total_credits ?? 0))]));
}

async function resolveTemplateCatalogMediaUrl(client: SupabaseClient, value: string | null): Promise<string | null> {
  if (!value) return null;
  if (!value.startsWith('template_assets/')) return resolveStoredMediaUrl(client, value);
  const objectPath = value.slice('template_assets/'.length);
  const { data, error } = await client.storage.from('template_assets').createSignedUrl(objectPath, 60 * 60);
  return error || !data?.signedUrl ? null : data.signedUrl;
}

function rowToDto(row: MediaTemplateRow, options: {
  creator?: TemplateCreator | null;
  estimatedTotalCredits?: number | null;
  includeAuthoring?: boolean;
  videoUrl?: string | null;
  thumbnailUrl?: string | null;
} = {}): MediaTemplateDto {
  return {
    id: row.id,
    slug: row.slug ?? row.id,
    name: row.name,
    description: row.description,
    category: row.category ?? 'general',
    videoUrl: options.videoUrl ?? row.video_url,
    thumbnailUrl: options.thumbnailUrl ?? row.thumbnail_url,
    creatorUserId: row.creator_user_id,
    creator: options.creator ?? null,
    inputSlots: normalizeTemplateInputSlots(row.input_slots),
    outputKind: templateOutputKind(row.output_kind),
    status: templateStatus(row.status),
    useCount: Math.max(0, Number(row.use_count ?? 0)),
    estimatedTotalCredits: options.estimatedTotalCredits ?? null,
    createdAt: row.created_at ?? new Date(0).toISOString(),
    updatedAt: row.updated_at ?? row.created_at ?? new Date(0).toISOString(),
    ...(options.includeAuthoring ? {
      authoring: {
        sourceCanvasId: row.source_canvas_id,
        outputNodeId: row.draft_output_node_id,
        activeVersionId: row.active_version_id,
      },
    } : {}),
  };
}

async function attachTemplateDetails(
  client: SupabaseClient,
  rows: MediaTemplateRow[],
  includeAuthoring: boolean,
): Promise<MediaTemplateDto[]> {
  const creators = await getCreatorMap(client, rows.flatMap((row) => row.creator_user_id ? [row.creator_user_id] : []));
  const costs = await activeVersionCosts(client, rows.flatMap((row) => row.active_version_id ? [row.active_version_id] : []));
  return Promise.all(rows.map(async (row) => rowToDto(row, {
    creator: row.creator_user_id ? creators.get(row.creator_user_id) ?? null : null,
    estimatedTotalCredits: row.active_version_id ? costs.get(row.active_version_id) ?? null : null,
    includeAuthoring,
    videoUrl: await resolveTemplateCatalogMediaUrl(client, row.video_url),
    thumbnailUrl: await resolveTemplateCatalogMediaUrl(client, row.thumbnail_url),
  })));
}

export async function listActiveMediaTemplates(client: SupabaseClient): Promise<MediaTemplateDto[]> {
  return (await listActiveMediaTemplatesPage(client)).templates;
}

const PUBLIC_TEMPLATE_PAGE_SIZE = 48;

function decodeTemplateCursor(value: string | null | undefined): { createdAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    return typeof parsed.createdAt === 'string' && typeof parsed.id === 'string'
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function encodeTemplateCursor(row: MediaTemplateRow): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), 'utf8').toString('base64url');
}

export async function listActiveMediaTemplatesPage(
  client: SupabaseClient,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<{ templates: MediaTemplateDto[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? PUBLIC_TEMPLATE_PAGE_SIZE), 96));
  const cursor = decodeTemplateCursor(options.cursor);
  let query = client.from('templates').select(TEMPLATE_SELECT)
    .eq('status', 'active').eq('is_active', true).not('active_version_id', 'is', null)
    .not('creator_user_id', 'is', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);
  if (cursor) {
    query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  }
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as unknown as MediaTemplateRow[];
  const pageRows = rows.slice(0, limit);
  return {
    templates: await attachTemplateDetails(client, pageRows, false),
    nextCursor: rows.length > limit && pageRows.length > 0
      ? encodeTemplateCursor(pageRows[pageRows.length - 1]!)
      : null,
  };
}

export async function listOwnedMediaTemplates(client: SupabaseClient, userId: string): Promise<MediaTemplateDto[]> {
  const { data, error } = await client.from('templates').select(TEMPLATE_SELECT)
    .eq('creator_user_id', userId).order('updated_at', { ascending: false });
  if (error) throw error;
  return attachTemplateDetails(client, (data ?? []) as unknown as MediaTemplateRow[], true);
}

export async function loadMediaTemplateRow(client: SupabaseClient, identifier: string): Promise<MediaTemplateRow | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier);
  let query = client.from('templates').select(TEMPLATE_SELECT);
  query = isUuid ? query.eq('id', identifier) : query.eq('slug', identifier);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data as MediaTemplateRow | null;
}

export async function getMediaTemplate(client: SupabaseClient, identifier: string, viewerUserId: string | null) {
  const row = await loadMediaTemplateRow(client, identifier);
  const isOwner = Boolean(viewerUserId && row?.creator_user_id === viewerUserId);
  if (!row || (!isOwner && !(row.status === 'active' && row.is_active && row.active_version_id))) {
    throw new MediaTemplateError('Template not found.', 404, 'TEMPLATE_NOT_FOUND');
  }
  return (await attachTemplateDetails(client, [row], isOwner))[0]!;
}

async function loadOwnedCanvas(client: SupabaseClient, canvasId: string, userId: string): Promise<CanvasRow> {
  const { data, error } = await client.from('workflow_canvases')
    .select('id, user_id, title, graph, revision').eq('id', canvasId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new MediaTemplateError('Workflow canvas not found.', 404, 'CANVAS_NOT_FOUND');
  return data as unknown as CanvasRow;
}

async function loadOwnedTemplateByCanvas(
  client: SupabaseClient,
  canvasId: string,
  userId: string,
): Promise<MediaTemplateRow | null> {
  const { data, error } = await client.from('templates')
    .select(TEMPLATE_SELECT)
    .eq('creator_user_id', userId)
    .eq('source_canvas_id', canvasId)
    .maybeSingle();
  if (error) throw error;
  return data as MediaTemplateRow | null;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return isRecord(error) && error.code === '23505';
}

function assertExpectedRevision(canvas: CanvasRow, value: unknown) {
  if (value === undefined || value === null) return;
  const expected = Number(value);
  if (!Number.isInteger(expected) || expected !== canvas.revision) {
    throw new MediaTemplateError(
      'The workflow changed after this template action began. Save and test the latest revision.',
      409,
      'CANVAS_REVISION_MISMATCH',
    );
  }
}

export async function validateMediaTemplateGraph(params: {
  client: SupabaseClient;
  userId: string;
  body: unknown;
}): Promise<TemplateGraphValidationDto> {
  const input = isRecord(params.body) ? params.body : {};
  const canvasId = requiredText(input.canvasId, 'canvasId', 80);
  const canvas = await loadOwnedCanvas(params.client, canvasId, params.userId);
  assertExpectedRevision(canvas, input.expectedRevision);
  return validateAndCompileTemplateGraph({
    graph: canvas.graph,
    outputNodeId: normalizeText(input.outputNodeId, 160),
    canvasRevision: canvas.revision,
    catalogRevision: normalizeText(input.catalogRevision, 160),
  }).validation;
}

export async function createMediaTemplate(client: SupabaseClient, userId: string, body: unknown) {
  const input = (isRecord(body) ? body : {}) as TemplateWriteInput;
  const sourceCanvasId = requiredText(input.sourceCanvasId, 'sourceCanvasId', 80);
  const canvas = await loadOwnedCanvas(client, sourceCanvasId, userId);
  const existing = await loadOwnedTemplateByCanvas(client, canvas.id, userId);
  if (existing) {
    return updateMediaTemplate(client, userId, existing.id, input);
  }
  const name = normalizeText(input.name, 80) ?? canvas.title.slice(0, 80);
  const slug = await createUniqueSlug(client, name);
  const { data, error } = await client.from('templates').insert({
    creator_user_id: userId,
    source_canvas_id: canvas.id,
    name,
    slug,
    description: normalizeText(input.description, 500),
    category: normalizeText(input.category, 80) ?? 'general',
    thumbnail_url: normalizeText(input.thumbnailUrl, 1000),
    draft_output_node_id: normalizeText(input.outputNodeId, 160),
    draft_catalog_revision: normalizeText(input.catalogRevision, 160),
    video_url: null,
    is_active: false,
    status: 'draft',
  }).select(TEMPLATE_SELECT).single();
  if (error) {
    // Two tabs can both observe no draft before one insert wins the unique
    // (creator_user_id, source_canvas_id) race. Resolve the winner and apply
    // this request to that same draft instead of surfacing a database 500.
    if (isUniqueConstraintViolation(error)) {
      const concurrent = await loadOwnedTemplateByCanvas(client, canvas.id, userId);
      if (concurrent) {
        return updateMediaTemplate(client, userId, concurrent.id, input);
      }
    }
    throw error;
  }
  return (await attachTemplateDetails(client, [data as unknown as MediaTemplateRow], true))[0]!;
}

async function loadOwnedTemplate(client: SupabaseClient, templateId: string, userId: string) {
  const row = await loadMediaTemplateRow(client, templateId);
  if (!row || row.creator_user_id !== userId) {
    throw new MediaTemplateError('Template not found.', 404, 'TEMPLATE_NOT_FOUND');
  }
  return row;
}

export async function updateMediaTemplate(client: SupabaseClient, userId: string, templateId: string, body: unknown) {
  const current = await loadOwnedTemplate(client, templateId, userId);
  const input = (isRecord(body) ? body : {}) as TemplateWriteInput;
  const patch: Record<string, unknown> = {};
  if ('sourceCanvasId' in input) {
    const canvasId = requiredText(input.sourceCanvasId, 'sourceCanvasId', 80);
    await loadOwnedCanvas(client, canvasId, userId);
    patch.source_canvas_id = canvasId;
  }
  if ('name' in input) {
    const name = requiredText(input.name, 'name', 80);
    patch.name = name;
    if (name !== current.name) patch.slug = await createUniqueSlug(client, name, current.id);
  }
  if ('description' in input) patch.description = normalizeText(input.description, 500);
  if ('category' in input) patch.category = normalizeText(input.category, 80) ?? 'general';
  if ('thumbnailUrl' in input) patch.thumbnail_url = normalizeText(input.thumbnailUrl, 1000);
  if ('outputNodeId' in input) patch.draft_output_node_id = normalizeText(input.outputNodeId, 160);
  if ('catalogRevision' in input) patch.draft_catalog_revision = normalizeText(input.catalogRevision, 160);
  const { data, error } = await client.from('templates').update(patch)
    .eq('id', current.id).eq('creator_user_id', userId).select(TEMPLATE_SELECT).single();
  if (error) throw error;
  return (await attachTemplateDetails(client, [data as unknown as MediaTemplateRow], true))[0]!;
}

function parseStoragePath(value: string): { bucket: string; objectPath: string } {
  const normalized = value.replace(/^\/+/, '');
  const slash = normalized.indexOf('/');
  if (slash <= 0 || slash === normalized.length - 1) {
    throw new MediaTemplateError('A fixed template asset path is invalid.', 400, 'INVALID_FIXED_ASSET');
  }
  const bucket = normalized.slice(0, slash);
  const objectPath = normalized.slice(slash + 1);
  if (objectPath.includes('\\')) {
    throw new MediaTemplateError('A fixed template asset path is invalid.', 400, 'INVALID_FIXED_ASSET');
  }
  const segments = objectPath.split('/');
  try {
    if (segments.some((segment) => {
      const decoded = decodeURIComponent(segment);
      return !decoded || decoded === '.' || decoded === '..';
    })) {
      throw new Error('unsafe path');
    }
  } catch {
    throw new MediaTemplateError('A fixed template asset path is invalid.', 400, 'INVALID_FIXED_ASSET');
  }
  return { bucket, objectPath };
}

function mediaFileMatchesKind(blob: Blob, objectPath: string, kind: TemplateMediaKind): boolean {
  if (blob.size <= 0 || blob.size > 100 * 1024 * 1024) return false;
  if (blob.type) return blob.type.toLowerCase().startsWith(`${kind}/`);
  const extension = path.posix.extname(objectPath).toLowerCase();
  return kind === 'image'
    ? ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(extension)
    : ['.mp4', '.webm', '.mov'].includes(extension);
}

async function copyOwnedAssetToVersion(params: {
  client: SupabaseClient;
  userId: string;
  templateId: string;
  versionId: string;
  sourceStoragePath: string;
  kind: TemplateMediaKind;
  destinationSegment: string;
}) {
  const source = parseStoragePath(params.sourceStoragePath);
  const allowedBucket = params.kind === 'image' ? 'generated_images' : 'generated_videos';
  if (source.bucket !== allowedBucket || source.objectPath.split('/')[0] !== params.userId) {
    throw new MediaTemplateError(
      'Template media must be an upload or result owned by the template creator.',
      400,
      'TEMPLATE_ASSET_NOT_OWNED',
    );
  }
  const fileName = path.posix.basename(source.objectPath).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'asset.bin';
  const safeSegment = params.destinationSegment.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100) || 'asset';
  const destination = `${params.templateId}/${params.versionId}/${safeSegment}/${fileName}`;
  const { data: blob, error: downloadError } = await params.client.storage.from(source.bucket).download(source.objectPath);
  if (downloadError || !blob || !mediaFileMatchesKind(blob, source.objectPath, params.kind)) {
    throw new MediaTemplateError('Template media could not be verified.', 400, 'TEMPLATE_ASSET_COPY_FAILED');
  }
  const { error: uploadError } = await params.client.storage.from('template_assets')
    .upload(destination, blob, { contentType: blob.type || undefined, upsert: false });
  if (uploadError) throw new MediaTemplateError('Template media could not be stored.', 500, 'TEMPLATE_ASSET_COPY_FAILED');
  return { destination, blob };
}

/**
 * Derives the catalog poster for a video template from the demo blob the
 * publish already holds. Cosmetic: a failure must never fail the publish —
 * the media-preview-repair sweep retries missing posters hourly.
 */
async function createTemplateDemoPosterAsset(params: {
  client: SupabaseClient;
  templateId: string;
  versionId: string;
  demoBlob: Blob;
}): Promise<string | null> {
  try {
    const poster = await createVideoPosterBuffer(params.demoBlob);
    const destination = `${params.templateId}/${params.versionId}/demo/poster.webp`;
    const { error } = await params.client.storage.from('template_assets')
      .upload(destination, poster, { contentType: 'image/webp', upsert: false });
    if (error) throw error;
    return destination;
  } catch (error) {
    logBackendError('failed_to_create_template_demo_poster', { templateId: params.templateId, error: error });
    return null;
  }
}

async function copyFixedAssets(params: {
  client: SupabaseClient;
  userId: string;
  templateId: string;
  versionId: string;
  compiled: CompiledTemplateGraph;
}) {
  const snapshot = JSON.parse(JSON.stringify(params.compiled)) as CompiledTemplateGraph;
  const graph = snapshot.graph as { nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }> };
  const copiedPaths: string[] = [];
  try {
    for (const node of graph.nodes ?? []) {
      if (node.type !== 'image-input' && node.type !== 'video-input') continue;
      const config = isRecord(node.data.templateInput) ? node.data.templateInput : {};
      if (config.mode !== 'fixed') continue;
      const storagePath = typeof node.data.storagePath === 'string' ? node.data.storagePath : '';
      const { destination } = await copyOwnedAssetToVersion({
        client: params.client,
        userId: params.userId,
        templateId: params.templateId,
        versionId: params.versionId,
        sourceStoragePath: storagePath,
        kind: node.type === 'image-input' ? 'image' : 'video',
        destinationSegment: `fixed-${node.id}`,
      });
      copiedPaths.push(destination);
      node.data.storagePath = `template_assets/${destination}`;
      node.data.imageUrl = null;
      node.data.videoUrl = null;
      if (isRecord(node.data.seedanceAsset)) {
        node.data.seedanceAsset = { ...node.data.seedanceAsset, sourceUrl: null, assetId: null, status: 'idle' };
      }
    }
    return { snapshot, copiedPaths };
  } catch (error) {
    if (copiedPaths.length) await params.client.storage.from('template_assets').remove(copiedPaths);
    throw error;
  }
}

export async function publishMediaTemplate(client: SupabaseClient, userId: string, templateId: string, body: unknown) {
  const template = await loadOwnedTemplate(client, templateId, userId);
  if (!template.source_canvas_id) throw new MediaTemplateError('Choose a source workflow.', 400, 'CANVAS_REQUIRED');
  const input = isRecord(body) ? body : {};
  if (input.rightsConfirmed !== true) {
    throw new MediaTemplateError('Confirm that you have permission to publish these assets.', 400, 'RIGHTS_CONFIRMATION_REQUIRED');
  }
  const canvas = await loadOwnedCanvas(client, template.source_canvas_id, userId);
  assertExpectedRevision(canvas, input.expectedRevision);
  const outputNodeId = normalizeText(input.outputNodeId, 160) ?? template.draft_output_node_id;
  const catalogRevision = normalizeText(input.catalogRevision, 160) ?? template.draft_catalog_revision;
  const compiled = compileTemplateGraph({
    graph: canvas.graph,
    outputNodeId,
    canvasRevision: canvas.revision,
    catalogRevision,
  });
  const expectedHash = requiredText(input.graphHash, 'graphHash', 128);
  if (compiled.graphHash !== expectedHash) {
    throw new MediaTemplateError('The workflow changed after it was tested.', 409, 'GRAPH_HASH_MISMATCH');
  }
  const testRunId = requiredText(input.testRunId, 'testRunId', 80);
  const { data: testRun, error: testError } = await client.from('template_runs')
    .select('id, template_id, user_id, status, is_test, graph_hash, source_canvas_revision, catalog_revision, result_url')
    .eq('id', testRunId).eq('template_id', template.id).eq('user_id', userId).maybeSingle();
  if (testError) throw testError;
  if (!testRun || !testRun.is_test || testRun.status !== 'succeeded'
      || testRun.graph_hash !== compiled.graphHash
      || testRun.source_canvas_revision !== canvas.revision
      || (testRun.catalog_revision ?? null) !== (compiled.catalogRevision ?? null)
      || !testRun.result_url) {
    throw new MediaTemplateError('Run a successful test of this exact workflow revision before publishing.', 409, 'TEST_REQUIRED');
  }

  const versionId = randomUUID();
  const copied = await copyFixedAssets({ client, userId, templateId: template.id, versionId, compiled });
  let demoObjectPath: string;
  let demoPosterPath: string | null = null;
  try {
    const demoCopy = await copyOwnedAssetToVersion({
      client,
      userId,
      templateId: template.id,
      versionId,
      sourceStoragePath: testRun.result_url,
      kind: compiled.outputKind,
      destinationSegment: 'demo',
    });
    demoObjectPath = demoCopy.destination;
    copied.copiedPaths.push(demoObjectPath);
    if (compiled.outputKind === 'video') {
      demoPosterPath = await createTemplateDemoPosterAsset({
        client,
        templateId: template.id,
        versionId,
        demoBlob: demoCopy.blob,
      });
      if (demoPosterPath) copied.copiedPaths.push(demoPosterPath);
    }
  } catch (error) {
    if (copied.copiedPaths.length) await client.storage.from('template_assets').remove(copied.copiedPaths);
    throw error;
  }
  const demoOutputUrl = `template_assets/${demoObjectPath}`;
  const privateSnapshot: TemplateVersionSnapshot = {
    ...copied.snapshot,
    templateId: template.id,
    templateVersionId: versionId,
    templateTitle: template.name,
    sourceCanvasId: canvas.id,
    sourceCanvasRevision: canvas.revision,
    demoOutputUrl,
  };
  const snapshotHash = createTemplateSnapshotHash(privateSnapshot);
  const { data: activation, error: activationError } = await client.rpc('activate_template_version', {
    p_version_id: versionId,
    p_template_id: template.id,
    p_creator_id: userId,
    p_source_canvas_id: canvas.id,
    p_source_canvas_revision: canvas.revision,
    p_graph_snapshot: privateSnapshot,
    p_graph_hash: compiled.graphHash,
    p_snapshot_hash: snapshotHash,
    p_output_node_id: compiled.outputNodeId,
    p_output_kind: compiled.outputKind,
    p_input_manifest: compiled.inputSlots,
    p_estimated_total_credits: compiled.estimatedTotalCredits,
    p_catalog_revision: compiled.catalogRevision,
    p_demo_output_url: demoOutputUrl,
    p_rights_confirmed_at: new Date().toISOString(),
  });
  if (activationError || !isRecord(activation)) {
    if (copied.copiedPaths.length) await client.storage.from('template_assets').remove(copied.copiedPaths);
    if (activationError) throw activationError;
    throw new MediaTemplateError('The template version could not be activated.', 500, 'VERSION_ACTIVATION_FAILED');
  }
  if (activation.inserted !== true && copied.copiedPaths.length) {
    await client.storage.from('template_assets').remove(copied.copiedPaths);
  }
  if (activation.inserted === true && demoPosterPath) {
    // The activation RPC assigns video_url from the demo; the derived poster
    // is recorded separately so the catalog cards get a still image on both
    // clients. Cosmetic — a failure here is healed by media-preview-repair.
    const { error: posterError } = await client.from('templates')
      .update({ thumbnail_url: `template_assets/${demoPosterPath}` })
      .eq('id', template.id)
      .eq('creator_user_id', userId);
    if (posterError) {
      logBackendError('failed_to_record_template_demo_poster', { templateId: template.id, error: posterError });
    }
  }
  const updated = await loadOwnedTemplate(client, template.id, userId);
  return (await attachTemplateDetails(client, [updated], true))[0]!;
}

export async function disableMediaTemplate(client: SupabaseClient, userId: string, templateId: string) {
  const template = await loadOwnedTemplate(client, templateId, userId);
  const { data, error } = await client.from('templates').update({ status: 'disabled', is_active: false })
    .eq('id', template.id).eq('creator_user_id', userId).select(TEMPLATE_SELECT).single();
  if (error) throw error;
  return (await attachTemplateDetails(client, [data as unknown as MediaTemplateRow], true))[0]!;
}

export async function loadCompiledDraftForTemplate(params: {
  client: SupabaseClient;
  templateId: string;
  userId: string;
  body: unknown;
}) {
  const template = await loadOwnedTemplate(params.client, params.templateId, params.userId);
  if (!template.source_canvas_id) throw new MediaTemplateError('Choose a source workflow.', 400, 'CANVAS_REQUIRED');
  const input = isRecord(params.body) ? params.body : {};
  const canvas = await loadOwnedCanvas(params.client, template.source_canvas_id, params.userId);
  assertExpectedRevision(canvas, input.expectedRevision);
  const outputNodeId = normalizeText(input.outputNodeId, 160) ?? template.draft_output_node_id;
  const catalogRevision = normalizeText(input.catalogRevision, 160) ?? template.draft_catalog_revision;
  const compiled = compileTemplateGraph({
    graph: canvas.graph,
    outputNodeId,
    canvasRevision: canvas.revision,
    catalogRevision,
  });
  return { template, canvas, compiled };
}
