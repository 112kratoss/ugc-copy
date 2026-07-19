import 'server-only';

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

type VerificationEntryRow = {
  release_id: string;
  model_id: string;
  verification_config: unknown;
};

type PreviousCheckRow = {
  model_id: string;
  status: string;
  consecutive_discrepancies: number;
};

type ProviderCheckStatus = 'available' | 'changed' | 'missing' | 'unverifiable' | 'error';

const ALLOWED_VERIFICATION_HOSTS = new Set(['api.kie.ai']);
const VERIFICATION_TIMEOUT_MS = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDiscrepancy(status: ProviderCheckStatus) {
  return status === 'changed' || status === 'missing' || status === 'error';
}

function parseVerificationEndpoint(config: unknown): { url: URL; expectedHash: string | null } | null {
  if (!isRecord(config) || config.mode !== 'http' || typeof config.url !== 'string') return null;
  try {
    const url = new URL(config.url);
    if (url.protocol !== 'https:' || !ALLOWED_VERIFICATION_HOSTS.has(url.hostname)) return null;
    return {
      url,
      expectedHash: typeof config.expectedHash === 'string' && config.expectedHash.trim()
        ? config.expectedHash.trim()
        : null,
    };
  } catch {
    return null;
  }
}

async function verifyEntry(entry: VerificationEntryRow): Promise<{
  status: ProviderCheckStatus;
  observedHash: string | null;
  details: Record<string, unknown>;
}> {
  const endpoint = parseVerificationEndpoint(entry.verification_config);
  if (!endpoint) {
    return {
      status: 'unverifiable',
      observedHash: null,
      details: { reason: 'manual_verification_required' },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.url, {
      method: 'HEAD',
      headers: process.env.KIE_AI_API_KEY
        ? { Authorization: `Bearer ${process.env.KIE_AI_API_KEY}` }
        : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
    const fingerprint = JSON.stringify({
      status: response.status,
      etag: response.headers.get('etag'),
      modified: response.headers.get('last-modified'),
    });
    const observedHash = createHash('sha256').update(fingerprint).digest('hex');
    const status: ProviderCheckStatus = response.status === 404
      ? 'missing'
      : !response.ok
        ? 'error'
        : endpoint.expectedHash && endpoint.expectedHash !== observedHash
          ? 'changed'
          : 'available';
    return {
      status,
      observedHash,
      details: { httpStatus: response.status },
    };
  } catch (error) {
    return {
      status: 'error',
      observedHash: null,
      details: { reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error' },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyPublishedGenerationModels(
  client: SupabaseClient,
  options: { now?: Date } = {},
) {
  const { data: release, error: releaseError } = await client
    .from('generation_model_catalog_releases')
    .select('id')
    .eq('status', 'active')
    .maybeSingle();
  if (releaseError) throw releaseError;
  if (!release?.id) return { checked: 0, discrepancies: 0, unverifiable: 0 };

  const { data: entries, error: entriesError } = await client
    .from('generation_model_catalog_entries')
    .select('release_id, model_id, verification_config')
    .eq('release_id', release.id);
  if (entriesError) throw entriesError;
  const rows = (entries ?? []) as VerificationEntryRow[];
  if (rows.length === 0) return { checked: 0, discrepancies: 0, unverifiable: 0 };

  const { data: previousRows, error: previousError } = await client
    .from('generation_model_provider_checks')
    .select('model_id, status, consecutive_discrepancies')
    .eq('release_id', release.id)
    .order('checked_at', { ascending: false })
    .limit(Math.max(100, rows.length * 3));
  if (previousError) throw previousError;
  const latestByModel = new Map<string, PreviousCheckRow>();
  for (const previous of (previousRows ?? []) as PreviousCheckRow[]) {
    if (!latestByModel.has(previous.model_id)) latestByModel.set(previous.model_id, previous);
  }

  const checks = await Promise.all(rows.map(async (entry) => {
    const result = await verifyEntry(entry);
    const previous = latestByModel.get(entry.model_id);
    const consecutiveDiscrepancies = isDiscrepancy(result.status)
      ? (isDiscrepancy(previous?.status as ProviderCheckStatus) ? previous!.consecutive_discrepancies : 0) + 1
      : 0;
    return {
      release_id: entry.release_id,
      model_id: entry.model_id,
      provider: 'kie',
      status: result.status,
      observed_hash: result.observedHash,
      sanitized_details: result.details,
      consecutive_discrepancies: consecutiveDiscrepancies,
      checked_at: (options.now ?? new Date()).toISOString(),
    };
  }));

  const { error: insertError } = await client.from('generation_model_provider_checks').insert(checks);
  if (insertError) throw insertError;
  return {
    checked: checks.length,
    discrepancies: checks.filter((check) => check.consecutive_discrepancies > 0).length,
    degraded: checks.filter((check) => check.consecutive_discrepancies >= 2).length,
    unverifiable: checks.filter((check) => check.status === 'unverifiable').length,
  };
}
