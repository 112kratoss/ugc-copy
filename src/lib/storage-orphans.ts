/**
 * Stored objects that nothing names, for the operator CLI
 * (`npm run ops:storage-orphans`, scripts/ops/storage-orphans.ts).
 *
 * The method is the 2026-11-04 usage audit's: an object is named when its name
 * appears anywhere in a row of a content table (every table that can hold a
 * path or a link, read whole), plain, bucket-prefixed or URL-encoded. A derived
 * file (`.preview.`, `.display.`, `.normalized.`, `.feed.<hash>.mp4`,
 * `.teaser.<hash>.mp4`, `<user>/playback/<creation>/`, a run's
 * `<user>/<creation>/provider-tracks/` in generation_inputs) counts as named
 * when its base is. Left out of the listing, whatever the rows say:
 * - objects younger than seven days;
 * - objects upload bookkeeping still tracks (a live `media_upload_intents` or
 *   `upload_byte_reservations` row): their sweeps own them;
 * - every staged upload (the `uploads` bucket) and every object an expired
 *   reservation tracks, unless asked for (`includeExpiredUploads`) while the
 *   reclaim interlock is on (`getMediaUploadReclaimPolicy().effectiveEnabled`:
 *   MEDIA_UPLOAD_RECLAIM_ABANDONED=true and the app floor). An app's draft can
 *   hold an uploads path no row records and never expires, which is what that
 *   interlock protects; staged uploads from before the intents table have no
 *   row at all. They are then listed under their own reason;
 * - the recipe-copy sweep's two folders (`recipeFileKind`): that job owns them;
 * - retained buyer copies (`post_resource_files/retained/`), whatever names them.
 *
 * Removal (`confirmOrphanRemovals`) takes exactly the reviewed list, through the
 * Storage API, and checks each entry again right before removing it: the same
 * object (id) still there, still old enough, still outside the exclusions,
 * named by no path column that records it exactly, and by no row of a corpus
 * read at most a minute before.
 *
 * No `server-only` import anywhere below: the CLI loads this under tsx.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import { PROVIDER_TRACKS_FOLDER } from '@/lib/generation-provider-tracks';
import { RECLAIM_AFTER_HOURS } from '@/lib/media-upload-reclaim';
import { getMediaUploadReclaimPolicy } from '@/lib/media-upload-reclaim-policy';
import { recipeFileKind } from '@/lib/recipe-copy-sweep-policy';
import { STORAGE_BUCKET_IDS } from '@/lib/storage-buckets';
import { iterateStorageObjectsV2 } from '@/lib/storage-list-v2';
import { parseCanonicalStorageObjectPath } from '@/lib/storage-ownership';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const ORPHAN_MIN_AGE_MS = 7 * DAY_MS;
/** A list older than this is refused by the confirm step: review a fresh one. */
export const ORPHAN_LIST_MAX_AGE_MS = 3 * DAY_MS;
/** The confirm step reads the corpus again once it is this old. */
export const ORPHAN_CORPUS_MAX_AGE_MS = 60 * 1000;
export const ORPHAN_LIST_HEADER = '# storage-orphans v1';

const PAGE_SIZE = 1000;

/**
 * The content tables read whole, each with the key it is paged by: one unique
 * column (keyset paging), or the primary key's columns (offset paging, for the
 * few with a composite key).
 */
export const ORPHAN_SCANNED_TABLES: ReadonlyArray<{ table: string; key: readonly string[] }> = [
  { table: 'account_deletion_jobs', key: ['user_id'] },
  { table: 'account_labels', key: ['user_id', 'label'] },
  { table: 'account_merge_tickets', key: ['id'] },
  { table: 'account_merges', key: ['id'] },
  { table: 'admin_credit_adjustments', key: ['id'] },
  { table: 'admin_generation_moderation_actions', key: ['id'] },
  { table: 'admin_post_moderation_actions', key: ['id'] },
  { table: 'admin_sessions', key: ['session_id'] },
  { table: 'admin_user_sanctions', key: ['id'] },
  { table: 'ai_usage_events', key: ['id'] },
  { table: 'blocked_upload_owners', key: ['owner_user_id'] },
  { table: 'cash_purchase_adjustments', key: ['id'] },
  { table: 'contact_messages', key: ['id'] },
  { table: 'creation_credit_reservations', key: ['id'] },
  { table: 'creator_payout_requests', key: ['id'] },
  { table: 'creator_resource_wallet_entries', key: ['id'] },
  { table: 'creator_search_documents', key: ['creator_user_id'] },
  { table: 'credit_grant_identity_fingerprints', key: ['program_key', 'fingerprint'] },
  { table: 'credit_grant_programs', key: ['program_key'] },
  { table: 'credit_grants', key: ['id'] },
  { table: 'credit_purchase_adjustments', key: ['id'] },
  { table: 'deleted_account_identity_fingerprints', key: ['fingerprint'] },
  { table: 'feed_algorithm_versions', key: ['id'] },
  { table: 'feed_experiment_variants', key: ['id'] },
  { table: 'feed_experiments', key: ['id'] },
  { table: 'generation_completion_jobs', key: ['id'] },
  { table: 'generation_input_media', key: ['id'] },
  { table: 'generation_input_media_repairs', key: ['generation_id'] },
  { table: 'generation_model_catalog_entries', key: ['release_id', 'model_id'] },
  { table: 'generation_model_catalog_releases', key: ['id'] },
  { table: 'generation_model_provider_checks', key: ['id'] },
  { table: 'generation_models', key: ['model_id'] },
  { table: 'generation_output_import_jobs', key: ['id'] },
  { table: 'generation_spend_audits', key: ['id'] },
  { table: 'generation_start_requests', key: ['user_id', 'key_hash'] },
  { table: 'generations', key: ['id'] },
  { table: 'marketplace_asset_content', key: ['asset_id'] },
  { table: 'marketplace_assets', key: ['id'] },
  { table: 'marketplace_bundle_listings', key: ['bundle_id'] },
  { table: 'marketplace_bundle_search_documents', key: ['bundle_id'] },
  { table: 'marketplace_orders', key: ['id'] },
  { table: 'marketplace_purchases', key: ['id'] },
  { table: 'mobile_notifications', key: ['id'] },
  { table: 'mobile_onboarding_states', key: ['user_id', 'flow_version'] },
  { table: 'mobile_purchase_adjustment_events', key: ['provider_event_id'] },
  { table: 'mobile_purchase_intents', key: ['id'] },
  { table: 'mobile_push_deliveries', key: ['id'] },
  { table: 'mobile_push_maintenance_scans', key: ['phase'] },
  { table: 'mobile_push_tokens', key: ['id'] },
  { table: 'mobile_store_products', key: ['product_id'] },
  { table: 'mobile_store_transactions', key: ['id'] },
  { table: 'moderation_reports', key: ['id'] },
  { table: 'post_comments', key: ['id'] },
  { table: 'post_deletion_audits', key: ['id'] },
  { table: 'post_media', key: ['id'] },
  { table: 'post_reports', key: ['id'] },
  { table: 'post_resource_bundle_migration_audit', key: ['id'] },
  { table: 'post_resource_bundle_orders', key: ['id'] },
  { table: 'post_resource_bundle_purchases', key: ['id'] },
  { table: 'post_resource_bundle_revision_files', key: ['revision_id', 'source_bucket', 'source_path'] },
  { table: 'post_resource_bundle_revision_supplements', key: ['revision_id'] },
  { table: 'post_resource_bundle_revisions', key: ['id'] },
  { table: 'post_resource_bundles', key: ['id'] },
  { table: 'post_resource_purchase_media', key: ['purchase_id', 'media_key'] },
  { table: 'post_search_documents', key: ['post_id'] },
  { table: 'post_source_tools', key: ['id'] },
  { table: 'posts', key: ['id'] },
  { table: 'profiles', key: ['id'] },
  { table: 'provider_submission_reconciliations', key: ['id'] },
  { table: 'razorpay_checkout_intents', key: ['id'] },
  { table: 'razorpay_credit_adjustment_sources', key: ['source_kind', 'source_id'] },
  { table: 'referral_attributions', key: ['id'] },
  { table: 'referral_codes', key: ['id'] },
  { table: 'referral_credit_ledger', key: ['id'] },
  { table: 'referral_programs', key: ['id'] },
  { table: 'referral_purchase_events', key: ['transaction_id'] },
  { table: 'referral_review_events', key: ['id'] },
  { table: 'referral_reward_adjustments', key: ['id'] },
  { table: 'referral_reward_notification_outbox', key: ['ledger_id'] },
  { table: 'referral_rewards', key: ['id'] },
  { table: 'seedance_prepared_assets', key: ['asset_id'] },
  { table: 'source_tool_models', key: ['id'] },
  { table: 'source_tools', key: ['id'] },
  { table: 'template_run_jobs', key: ['id'] },
  { table: 'template_run_steps', key: ['id'] },
  { table: 'template_runs', key: ['id'] },
  { table: 'template_versions', key: ['id'] },
  { table: 'templates', key: ['id'] },
  { table: 'transactions', key: ['id'] },
  // A permanent alias: buyers' old quotes resolve their public path through it.
  { table: 'uploaded_media_private_copies', key: ['public_path'] },
  { table: 'workflow_canvas_assistant_messages', key: ['id'] },
  { table: 'workflow_canvas_assistant_proposals', key: ['id'] },
  { table: 'workflow_canvas_history', key: ['id'] },
  { table: 'workflow_canvas_run_steps', key: ['id'] },
  { table: 'workflow_canvas_runs', key: ['id'] },
  { table: 'workflow_canvases', key: ['id'] },
  { table: 'workflow_run_step_jobs', key: ['id'] },
  { table: 'workflow_shares', key: ['id'] },
];

const TELEMETRY = 'telemetry or counters: no stored paths, and too large to read whole';
const NO_TEXT = 'no text or JSON column';
const SEARCH_DICTIONARY = 'single words of letters, held to that by a check: never a path';
const SEARCH_ENTITIES = 'model and tool names and their keys, at most 80 characters, copied from Made with: never a stored path';
const SEARCH_DENYLIST = 'single words an operator withdrew from suggestions, each with a note: never a path';
const UPLOAD_BOOKKEEPING = 'upload bookkeeping: read for the exclusions, never a reference';
const RECIPE_SWEEP = "the recipe-copy sweep's own bookkeeping: its folders are excluded";
const RECIPE_COPY_SOURCES = 'where passed-on recipe copies came from: it names only copies, whose folders are excluded';

/** Every other table, and why it is not read for references. */
export const ORPHAN_SKIPPED_TABLES: Readonly<Record<string, string>> = {
  account_deletion_wallet_records: NO_TEXT,
  // The MCP server's audit ledger: tool names, codes and ids, one row per agent call.
  agent_tool_calls: TELEMETRY,
  backend_job_locks: TELEMETRY,
  backend_job_runs: TELEMETRY,
  backend_rate_limits: TELEMETRY,
  completed_post_remixes: NO_TEXT,
  content_preferences: NO_TEXT,
  creator_feed_stats: TELEMETRY,
  creator_resource_wallets: NO_TEXT,
  feed_delivery_fact_daily: TELEMETRY,
  feed_delivery_facts: TELEMETRY,
  feed_events: TELEMETRY,
  feed_experiment_assignments: TELEMETRY,
  feed_semantic_clusters: TELEMETRY,
  feed_session_items: TELEMETRY,
  feed_sessions: TELEMETRY,
  feed_user_creator_feedback: TELEMETRY,
  feed_user_post_feedback: TELEMETRY,
  feed_viewer_daily: TELEMETRY,
  follows: NO_TEXT,
  generation_share_events: TELEMETRY,
  media_upload_intents: UPLOAD_BOOKKEEPING,
  mobile_notification_preferences: NO_TEXT,
  nsfw_post_reveals: NO_TEXT,
  onboarding_events: TELEMETRY,
  playback_metrics: TELEMETRY,
  playback_metrics_daily_rollup: TELEMETRY,
  post_content_embeddings: TELEMETRY,
  post_feed_stats: TELEMETRY,
  post_media_object_cleanup: UPLOAD_BOOKKEEPING,
  post_save_events: TELEMETRY,
  post_saves: NO_TEXT,
  // Search's models and tools: which a post has, under the name it prints.
  post_search_entities: SEARCH_ENTITIES,
  post_share_events: TELEMETRY,
  profile_share_events: TELEMETRY,
  provider_admission_buckets: TELEMETRY,
  provider_circuit_breakers: TELEMETRY,
  provider_dependency_events: TELEMETRY,
  provider_fetch_attempt_counters: TELEMETRY,
  recipe_copy_sources: RECIPE_COPY_SOURCES,
  recipe_file_sweep_cursors: RECIPE_SWEEP,
  recipe_file_sweep_deletions: RECIPE_SWEEP,
  recipe_import_uses: RECIPE_SWEEP,
  // Digests of the installations an account used Invite & Earn from.
  referral_account_devices: TELEMETRY,
  referral_purchase_reconciliation_retries: NO_TEXT,
  referral_visits: TELEMETRY,
  // The anonymous search log: a short query, a hash and three counts per row.
  search_query_events: TELEMETRY,
  search_visitor_day_keys: TELEMETRY,
  // Search's spelling dictionary: one lowercase word of letters per row.
  search_terms: SEARCH_DICTIONARY,
  // Words an operator took out of typeahead: a lowercase word and a note per row.
  search_suggestion_denylist: SEARCH_DENYLIST,
  showcase_media_revocations: UPLOAD_BOOKKEEPING,
  showcase_saves: NO_TEXT,
  upload_byte_global_counters: NO_TEXT,
  upload_byte_reservations: UPLOAD_BOOKKEEPING,
  upload_byte_user_counters: NO_TEXT,
  upload_path_tombstones: UPLOAD_BOOKKEEPING,
  user_blocks: NO_TEXT,
  user_interest_refresh_state: NO_TEXT,
  user_interest_weights: TELEMETRY,
};

/**
 * Columns that record a stored object's path exactly, asked by equality right
 * before each removal: the names a content-addressed write (a publish again, a
 * sweep) can record anew between the corpus read and the removal.
 */
const EXACT_PATH_COLUMNS: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
  { table: 'generations', columns: ['output_url', 'preview_url', 'display_url', 'showcase_asset_path', 'playback_rendition_path'] },
  { table: 'posts', columns: ['showcase_asset_path', 'output_url'] },
  {
    table: 'post_media',
    columns: ['storage_path', 'preview_storage_path', 'display_storage_path', 'rendition_storage_path', 'teaser_storage_path'],
  },
  { table: 'generation_input_media', columns: ['storage_path'] },
  { table: 'post_resource_purchase_media', columns: ['storage_path', 'preview_storage_path', 'rendition_storage_path'] },
  { table: 'post_resource_bundle_revision_files', columns: ['source_path', 'retained_path'] },
];

export type StoredObject = {
  bucket: string;
  path: string;
  id: string;
  sizeBytes: number | null;
  createdAt: string;
  /** When its bytes last changed: an overwrite keeps the id and the creation time. */
  updatedAt?: string | null;
};

export type OrphanReason = 'unnamed' | 'expired_upload';

export type OrphanEntry = StoredObject & { reason: OrphanReason };

export type OrphanListing = {
  orphans: OrphanEntry[];
  /** Objects left out of the listing, by why. */
  kept: Record<string, number>;
  scannedObjects: number;
  scannedTables: number;
  scannedRows: number;
};

type Row = Record<string, unknown>;

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    if (value) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Row)) collectStrings(entry, output);
  }
}

function decoded(value: string): string | null {
  if (!value.includes('%')) return null;
  try {
    const result = decodeURIComponent(value);
    return result === value ? null : result;
  } catch {
    return null;
  }
}

/** Every string any scanned row holds, as written and URL-decoded, searchable by substring. */
export class NameCorpus {
  private readonly exact = new Set<string>();
  private readonly chunks: string[] = [];
  private text: string | null = null;
  rows = 0;
  /**
   * The ids of the `generations` rows read: a creation that exists. Its id alone in some row
   * is no such sign, as a deleted paid run's spend audit keeps it for good.
   */
  readonly generationIds = new Set<string>();
  /** When the read finished: what the confirm step's minute is counted from. */
  readAt: number;

  constructor(readAt: number) {
    this.readAt = readAt;
  }

  addRow(row: Row, table?: string): void {
    this.rows += 1;
    if (table === 'generations' && typeof row.id === 'string') this.generationIds.add(row.id);
    const strings: string[] = [];
    collectStrings(row, strings);
    for (const value of strings) {
      this.exact.add(value);
      this.chunks.push(value);
      const plain = decoded(value);
      if (plain !== null) {
        this.exact.add(plain);
        this.chunks.push(plain);
      }
    }
    this.text = null;
  }

  /** Whether any row holds one of `needles`, whole or inside a longer value. */
  containsAny(needles: readonly string[]): boolean {
    const present = needles.filter(Boolean);
    if (present.some((needle) => this.exact.has(needle))) return true;
    this.text ??= this.chunks.join('\n');
    const text = this.text;
    return present.some((needle) => text.includes(needle));
  }
}

/** The forms a row can name an object in. */
function nameForms(bucket: string, path: string): string[] {
  const segmentsEncoded = path.split('/').map(encodeURIComponent).join('/');
  return [...new Set([path, `${bucket}/${path}`, encodeURI(path), segmentsEncoded])];
}

const DERIVED_FILE = /^(.*)\.(?:preview|display|normalized)\.[0-9a-f]+\.webp$|^(.*)\.(?:feed|teaser)\.[0-9a-f]+\.mp4$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PLAYBACK_FILE = new RegExp(`^[^/]+/playback/(${UUID})/[^/]+$`);
// The copies of a run's tracks converted for its provider, which go with the run (generation-provider-tracks).
const PROVIDER_TRACK_FILE = new RegExp(`^[^/]+/(${UUID})/${PROVIDER_TRACKS_FOLDER}/[^/]+$`);

/** Whether a row names the object, or the base a derived file was made from. */
export function isObjectNamed(corpus: NameCorpus, bucket: string, path: string): boolean {
  if (corpus.containsAny(nameForms(bucket, path))) return true;
  const derived = DERIVED_FILE.exec(path);
  const stem = derived ? derived[1] ?? derived[2] : null;
  // Any file of the stem (the original under any extension, a sibling
  // derivative) named anywhere keeps it: a derivative goes with its base.
  if (stem && corpus.containsAny(nameForms(bucket, `${stem}.`))) return true;
  const providerTrack = bucket === 'generation_inputs' ? PROVIDER_TRACK_FILE.exec(path) : null;
  if (providerTrack) return corpus.generationIds.has(providerTrack[1]);
  const playback = PLAYBACK_FILE.exec(path);
  return Boolean(playback && corpus.containsAny([playback[1]]));
}

async function readTable(
  client: SupabaseClient,
  { table, key }: { table: string; key: readonly string[] },
  corpus: NameCorpus,
): Promise<void> {
  if (key.length === 1) {
    const [column] = key;
    let after: unknown = null;
    for (;;) {
      let query = client.from(table).select('*').order(column, { ascending: true }).limit(PAGE_SIZE);
      if (after !== null) query = query.gt(column, after);
      const { data, error } = await query;
      if (error) throw new Error(`Could not read ${table}: ${error.message ?? 'unknown error'}`);
      const rows = (data ?? []) as Row[];
      for (const row of rows) corpus.addRow(row, table);
      if (rows.length < PAGE_SIZE) return;
      after = rows[rows.length - 1]?.[column] ?? null;
      if (after === null) throw new Error(`Could not page ${table} by ${column}.`);
    }
  }

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = client.from(table).select('*');
    for (const column of key) query = query.order(column, { ascending: true });
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read ${table}: ${error.message ?? 'unknown error'}`);
    const rows = (data ?? []) as Row[];
    for (const row of rows) corpus.addRow(row, table);
    if (rows.length < PAGE_SIZE) return;
  }
}

/** Reads every scanned table whole. Any table that cannot be read fails the whole read. */
export async function readNameCorpus(
  client: SupabaseClient,
  { clock = Date.now, onTable }: { clock?: () => number; onTable?: (table: string) => void } = {},
): Promise<NameCorpus> {
  const corpus = new NameCorpus(clock());
  for (const table of ORPHAN_SCANNED_TABLES) {
    onTable?.(table.table);
    await readTable(client, table, corpus);
  }
  // Dated from the end of the read: dated from its start, a read longer than
  // a minute was stale on arrival, and the confirm step read it again for
  // every entry.
  corpus.readAt = clock();
  return corpus;
}

type UploadBookkeeping = {
  /** `<bucket>/<path>` of objects a live intent or reservation tracks. */
  live: Set<string>;
  /** Of those tracked only by expired bookkeeping. */
  expired: Set<string>;
};

/** What the upload sweeps still own: uncleared intents (uploads bucket) and unreleased reservations. */
export async function readUploadBookkeeping(client: SupabaseClient, nowMs: number): Promise<UploadBookkeeping> {
  const live = new Set<string>();
  const expired = new Set<string>();
  const intentCutoff = nowMs - RECLAIM_AFTER_HOURS * HOUR_MS;

  let after: string | null = null;
  for (;;) {
    let query = client.from('media_upload_intents').select('id, storage_path, created_at').is('storage_cleared_at', null)
      .order('id', { ascending: true }).limit(PAGE_SIZE);
    if (after) query = query.gt('id', after);
    const { data, error } = await query;
    if (error) throw new Error(`Could not read media_upload_intents: ${error.message ?? 'unknown error'}`);
    const rows = (data ?? []) as Array<{ id: string; storage_path: string; created_at: string }>;
    for (const row of rows) {
      const key = `uploads/${row.storage_path}`;
      if (Date.parse(row.created_at) < intentCutoff) expired.add(key);
      else live.add(key);
    }
    if (rows.length < PAGE_SIZE) break;
    after = rows[rows.length - 1].id;
  }

  after = null;
  for (;;) {
    let query = client.from('upload_byte_reservations').select('id, bucket_id, storage_path, expires_at')
      .is('released_at', null).order('id', { ascending: true }).limit(PAGE_SIZE);
    if (after) query = query.gt('id', after);
    const { data, error } = await query;
    if (error) throw new Error(`Could not read upload_byte_reservations: ${error.message ?? 'unknown error'}`);
    const rows = (data ?? []) as Array<{ id: string; bucket_id: string; storage_path: string; expires_at: string }>;
    for (const row of rows) {
      const key = `${row.bucket_id}/${row.storage_path}`;
      if (Date.parse(row.expires_at) < nowMs) expired.add(key);
      else live.add(key);
    }
    if (rows.length < PAGE_SIZE) break;
    after = rows[rows.length - 1].id;
  }

  for (const key of live) expired.delete(key);
  return { live, expired };
}

/** Lists every object of the buckets through the Storage API. */
export async function listStoredObjects(
  client: SupabaseClient,
  buckets: readonly string[] = STORAGE_BUCKET_IDS,
): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];
  for (const bucket of buckets) {
    for await (const object of iterateStorageObjectsV2(client, { bucket })) {
      const size = object.metadata?.size;
      objects.push({
        bucket,
        path: object.path,
        id: object.id,
        sizeBytes: typeof size === 'number' ? size : null,
        createdAt: object.createdAt,
        updatedAt: object.updatedAt,
      });
    }
  }
  return objects;
}

type Exclusion =
  | 'placeholder'
  | 'not_canonical'
  | 'too_young'
  | 'recipe_copy_sweep'
  | 'retained_buyer_copy'
  | 'upload_bookkeeping'
  | 'staged_upload';

const STAGED_UPLOADS_BUCKET = 'uploads';

/**
 * Whether expired staged uploads may be listed and removed: only when asked,
 * and never past the reclaim interlock, whatever the caller asks (the same
 * rule `reclaimAbandonedMediaUploads` holds at its delete boundary).
 */
function expiredUploadsAllowed(
  includeExpiredUploads: boolean,
  environment: Record<string, string | undefined>,
): boolean {
  if (!includeExpiredUploads) return false;
  if (!getMediaUploadReclaimPolicy({ environment }).effectiveEnabled) {
    throw new Error(
      'Expired staged uploads are listed and removed only while the reclaim interlock is on: MEDIA_UPLOAD_RECLAIM_ABANDONED=true and the app floor at or past its safe version.',
    );
  }
  return true;
}

function exclusionOf(
  object: StoredObject,
  { nowMs, minAgeMs, bookkeeping, includeExpiredUploads }: {
    nowMs: number;
    minAgeMs: number;
    bookkeeping: UploadBookkeeping;
    includeExpiredUploads: boolean;
  },
): Exclusion | null {
  const fileName = object.path.split('/').pop() ?? '';
  if (fileName === '.emptyFolderPlaceholder') return 'placeholder';
  if (parseCanonicalStorageObjectPath(object.path, { minimumSegments: 2 }) !== object.path) return 'not_canonical';
  // Its age is from its last write: an overwrite keeps the creation time.
  const createdAt = Date.parse(object.createdAt);
  const updatedAt = object.updatedAt ? Date.parse(object.updatedAt) : createdAt;
  const writtenAt = Math.max(createdAt, Number.isFinite(updatedAt) ? updatedAt : createdAt);
  if (!Number.isFinite(writtenAt) || nowMs - writtenAt < minAgeMs) return 'too_young';
  if (recipeFileKind(object.bucket, object.path)) return 'recipe_copy_sweep';
  if (object.bucket === 'post_resource_files' && object.path.startsWith('retained/')) return 'retained_buyer_copy';
  const key = `${object.bucket}/${object.path}`;
  if (bookkeeping.live.has(key)) return 'upload_bookkeeping';
  if (object.bucket === STAGED_UPLOADS_BUCKET && !includeExpiredUploads) return 'staged_upload';
  if (bookkeeping.expired.has(key) && !includeExpiredUploads) return 'upload_bookkeeping';
  return null;
}

/** The listing: every object nothing names, outside the exclusions. Reads only. */
export async function listStorageOrphans(
  client: SupabaseClient,
  {
    clock = Date.now,
    minAgeMs = ORPHAN_MIN_AGE_MS,
    buckets = STORAGE_BUCKET_IDS,
    includeExpiredUploads: askedForExpiredUploads = false,
    environment = process.env,
    onProgress,
  }: {
    clock?: () => number;
    minAgeMs?: number;
    buckets?: readonly string[];
    includeExpiredUploads?: boolean;
    /** Where the reclaim interlock's flag is read from. */
    environment?: Record<string, string | undefined>;
    onProgress?: (message: string) => void;
  } = {},
): Promise<OrphanListing> {
  const includeExpiredUploads = expiredUploadsAllowed(askedForExpiredUploads, environment);
  const effectiveMinAgeMs = Math.max(minAgeMs, ORPHAN_MIN_AGE_MS);
  onProgress?.('Listing stored objects');
  const objects = await listStoredObjects(client, buckets);
  onProgress?.('Reading upload bookkeeping');
  const nowMs = clock();
  const bookkeeping = await readUploadBookkeeping(client, nowMs);
  onProgress?.('Reading content tables');
  const corpus = await readNameCorpus(client, { clock, onTable: (table) => onProgress?.(`  ${table}`) });

  const listing: OrphanListing = {
    orphans: [],
    kept: {},
    scannedObjects: objects.length,
    scannedTables: ORPHAN_SCANNED_TABLES.length,
    scannedRows: corpus.rows,
  };
  const keep = (reason: string) => {
    listing.kept[reason] = (listing.kept[reason] ?? 0) + 1;
  };

  for (const object of objects) {
    const exclusion = exclusionOf(object, {
      nowMs,
      minAgeMs: effectiveMinAgeMs,
      bookkeeping,
      includeExpiredUploads,
    });
    if (exclusion) {
      keep(exclusion);
      continue;
    }
    if (isObjectNamed(corpus, object.bucket, object.path)) {
      keep('named');
      continue;
    }
    const expiredUpload = object.bucket === STAGED_UPLOADS_BUCKET
      || bookkeeping.expired.has(`${object.bucket}/${object.path}`);
    listing.orphans.push({ ...object, reason: expiredUpload ? 'expired_upload' : 'unnamed' });
  }

  listing.orphans.sort((a, b) => (a.bucket === b.bucket ? a.path.localeCompare(b.path) : a.bucket.localeCompare(b.bucket)));
  return listing;
}

const LIST_COLUMNS = ['bucket', 'path', 'size_bytes', 'age_days', 'reason', 'object_id', 'created_at'] as const;

/**
 * Where a list goes unless asked: the system's temporary directory, never the
 * checkout (the repository is public, and a list names accounts and their
 * files). `.gitignore` covers the name wherever it lands.
 */
export function defaultOrphanListPath(listedAt: Date, directory: string = tmpdir()): string {
  return join(directory, `storage-orphans-${listedAt.toISOString().replace(/[:.]/g, '-')}.tsv`);
}

/** A reviewable list: a header naming the project and the time, then one tab-separated line an object. */
export function formatOrphanList(listing: OrphanListing, { projectHost, listedAt }: { projectHost: string; listedAt: Date }): string {
  const lines = [
    `${ORPHAN_LIST_HEADER} project=${projectHost} listed_at=${listedAt.toISOString()}`,
    `# ${listing.orphans.length} object(s), ${listing.orphans.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0)} byte(s). Remove a line to keep its object.`,
    LIST_COLUMNS.join('\t'),
  ];
  for (const entry of listing.orphans) {
    const ageDays = Math.floor((listedAt.getTime() - Date.parse(entry.createdAt)) / DAY_MS);
    lines.push([entry.bucket, entry.path, entry.sizeBytes ?? '', ageDays, entry.reason, entry.id, entry.createdAt].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

export type ParsedOrphanList = {
  projectHost: string;
  listedAt: Date;
  entries: Array<{ bucket: string; path: string; id: string; createdAt: string }>;
};

/** Reads a list back, refusing anything it did not write: a wrong header, an unknown bucket, a path that is not canonical. */
export function parseOrphanList(text: string): ParsedOrphanList {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const header = /^# storage-orphans v1 project=(\S+) listed_at=(\S+)$/.exec(lines[0] ?? '');
  if (!header) throw new Error('Not a storage-orphans list: the first line is not its header.');
  const listedAt = new Date(header[2]);
  if (!Number.isFinite(listedAt.getTime())) throw new Error('The list header has no valid listed_at.');

  const buckets = new Set<string>(STORAGE_BUCKET_IDS);
  const entries: ParsedOrphanList['entries'] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (index === 0 || !line.trim() || line.startsWith('#') || line === LIST_COLUMNS.join('\t')) continue;
    const fields = line.split('\t');
    if (fields.length !== LIST_COLUMNS.length) throw new Error(`Line ${index + 1} does not have ${LIST_COLUMNS.length} columns.`);
    const [bucket, path, , , , id, createdAt] = fields;
    if (!buckets.has(bucket)) throw new Error(`Line ${index + 1} names an unknown bucket: ${bucket}`);
    if (parseCanonicalStorageObjectPath(path, { minimumSegments: 2 }) !== path) {
      throw new Error(`Line ${index + 1} is not a canonical object path.`);
    }
    if (!id) throw new Error(`Line ${index + 1} has no object id.`);
    const key = `${bucket}/${path}`;
    if (seen.has(key)) throw new Error(`Line ${index + 1} repeats ${key}.`);
    seen.add(key);
    entries.push({ bucket, path, id, createdAt });
  }
  return { projectHost: header[1], listedAt, entries };
}

export type OrphanRemovalOutcome =
  | 'removed'
  | 'gone'
  | 'changed'
  | 'too_young'
  | 'excluded'
  | 'named'
  | 'failed';

async function isNamedByExactPath(client: SupabaseClient, bucket: string, path: string): Promise<boolean> {
  const values = [path, `${bucket}/${path}`];
  const reads = EXACT_PATH_COLUMNS.flatMap(({ table, columns }) => columns.map(async (column) => {
    const { data, error } = await client.from(table).select(column).in(column, values).limit(1);
    if (error) throw new Error(`Could not read ${table}.${column}: ${error.message ?? 'unknown error'}`);
    return (data ?? []).length > 0;
  }));
  return (await Promise.all(reads)).some(Boolean);
}

/**
 * Removes exactly the listed objects, each only after it is checked again: the
 * same object still there, old enough, outside the exclusions, and named by
 * nothing (exact path columns, then a corpus read at most a minute before).
 * Stops at the first check that cannot be made.
 */
export async function confirmOrphanRemovals(
  client: SupabaseClient,
  list: ParsedOrphanList,
  {
    projectHost,
    clock = Date.now,
    includeExpiredUploads: askedForExpiredUploads = false,
    environment = process.env,
    onResult,
    readCorpus = readNameCorpus,
  }: {
    projectHost: string;
    clock?: () => number;
    includeExpiredUploads?: boolean;
    /** Where the reclaim interlock's flag is read from. */
    environment?: Record<string, string | undefined>;
    onResult?: (entry: ParsedOrphanList['entries'][number], outcome: OrphanRemovalOutcome) => void;
    readCorpus?: typeof readNameCorpus;
  },
): Promise<Record<OrphanRemovalOutcome, number>> {
  const includeExpiredUploads = expiredUploadsAllowed(askedForExpiredUploads, environment);
  if (list.projectHost !== projectHost) {
    throw new Error(`The list was made for ${list.projectHost}, not ${projectHost}.`);
  }
  if (clock() - list.listedAt.getTime() > ORPHAN_LIST_MAX_AGE_MS) {
    throw new Error('The list is more than three days old: list again and review the new one.');
  }

  const counts: Record<OrphanRemovalOutcome, number> = {
    removed: 0, gone: 0, changed: 0, too_young: 0, excluded: 0, named: 0, failed: 0,
  };
  let corpus: NameCorpus | null = null;
  let bookkeeping: UploadBookkeeping | null = null;

  for (const entry of list.entries) {
    const record = (outcome: OrphanRemovalOutcome) => {
      counts[outcome] += 1;
      onResult?.(entry, outcome);
    };
    const nowMs = clock();
    if (!corpus || !bookkeeping || nowMs - corpus.readAt > ORPHAN_CORPUS_MAX_AGE_MS) {
      bookkeeping = await readUploadBookkeeping(client, nowMs);
      corpus = await readCorpus(client, { clock });
    }

    const files = client.storage.from(entry.bucket);
    const { data: info, error: infoError } = await files.info(entry.path);
    if (infoError || !info) {
      const status = (infoError as { statusCode?: string; status?: number } | null);
      if (status?.statusCode === '404' || status?.status === 404 || /not found/i.test(String((infoError as { message?: string } | null)?.message ?? ''))) {
        record('gone');
        continue;
      }
      throw new Error(`Could not read ${entry.bucket}/${entry.path}: ${(infoError as { message?: string } | null)?.message ?? 'no answer'}`);
    }
    const stored = info as { id?: string; createdAt?: string; lastModified?: string; updatedAt?: string; size?: number };
    if (!stored.id || stored.id !== entry.id) {
      record('changed');
      continue;
    }
    const object: StoredObject = {
      bucket: entry.bucket,
      path: entry.path,
      id: stored.id,
      sizeBytes: typeof stored.size === 'number' ? stored.size : null,
      createdAt: stored.createdAt ?? entry.createdAt,
      updatedAt: stored.lastModified ?? stored.updatedAt ?? null,
    };
    const exclusion = exclusionOf(object, { nowMs, minAgeMs: ORPHAN_MIN_AGE_MS, bookkeeping, includeExpiredUploads });
    if (exclusion === 'too_young') {
      record('too_young');
      continue;
    }
    if (exclusion) {
      record('excluded');
      continue;
    }
    if (await isNamedByExactPath(client, entry.bucket, entry.path) || isObjectNamed(corpus, entry.bucket, entry.path)) {
      record('named');
      continue;
    }

    const { error: removeError } = await files.remove([entry.path]);
    if (removeError) {
      record('failed');
      continue;
    }
    record('removed');
  }

  return counts;
}
