import { NextRequest, NextResponse } from 'next/server';
import {
  authenticateRequest,
  createServiceClient,
  requireKieApiKey,
  resolveStoredMediaUrl,
} from '@/lib/server-helpers';
import {
  normalizeSeedanceAssetStatus,
  type SeedanceAssetKind,
} from '@/lib/seedance-assets';

function extractAssetPayloadValue<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'object' && value !== null && 'data' in value) {
    return extractAssetPayloadValue<T>((value as { data?: unknown }).data);
  }

  return value as T;
}

function extractAssetId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [record.assetId, record.asset_id, record.id, record.taskId];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function extractRawStatus(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [
    record.status,
    record.state,
    record.assetStatus,
    record.asset_state,
    record.taskStatus,
    record.task_state,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function extractErrorMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const candidates = [record.error, record.message, record.msg, record.failMsg];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  const data = await response.json();
  if (!response.ok || data?.code && data.code !== 200) {
    throw new Error(
      (typeof data?.msg === 'string' && data.msg)
      || (typeof data?.message === 'string' && data.message)
      || 'Seedance asset request failed'
    );
  }

  return data as Record<string, unknown>;
}

function normalizeAssetType(value: unknown): SeedanceAssetKind | null {
  if (value === 'Image' || value === 'Video' || value === 'Audio') {
    return value;
  }

  return null;
}

export async function POST(request: NextRequest) {
  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const apiKey = requireKieApiKey();
  if (apiKey instanceof NextResponse) {
    return apiKey;
  }

  try {
    const { url, assetType } = await request.json();
    const normalizedAssetType = normalizeAssetType(assetType);
    const normalizedUrl = typeof url === 'string' ? url.trim() : '';

    if (!normalizedUrl) {
      return NextResponse.json({ error: 'Missing url' }, { status: 400 });
    }

    if (!normalizedAssetType) {
      return NextResponse.json({ error: 'Invalid assetType' }, { status: 400 });
    }

    const adminSupabase = createServiceClient();
    const resolvedUrl = await resolveStoredMediaUrl(adminSupabase, normalizedUrl);
    const response = await fetch('https://api.kie.ai/api/v1/playground/createAsset', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        assetType: normalizedAssetType,
        url: resolvedUrl,
      }),
    });

    const data = await parseResponse(response);
    const payload = extractAssetPayloadValue(data) ?? data;
    const rawStatus = extractRawStatus(payload) ?? 'processing';
    const assetId = extractAssetId(payload);

    return NextResponse.json({
      success: true,
      assetId,
      assetType: normalizedAssetType,
      status: normalizeSeedanceAssetStatus(rawStatus),
      rawStatus,
      error: extractErrorMessage(payload),
      sourceUrl: resolvedUrl,
      lastCheckedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create Seedance asset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const authResult = await authenticateRequest(request);
  if (authResult instanceof NextResponse) {
    return authResult;
  }

  const apiKey = requireKieApiKey();
  if (apiKey instanceof NextResponse) {
    return apiKey;
  }

  const assetId = new URL(request.url).searchParams.get('assetId')?.trim() || '';
  if (!assetId) {
    return NextResponse.json({ error: 'Missing assetId' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `https://api.kie.ai/api/v1/playground/getAsset?assetId=${encodeURIComponent(assetId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    const data = await parseResponse(response);
    const payload = extractAssetPayloadValue(data) ?? data;
    const rawStatus = extractRawStatus(payload) ?? 'processing';

    return NextResponse.json({
      success: true,
      assetId: extractAssetId(payload) ?? assetId,
      assetType: normalizeAssetType((payload as Record<string, unknown>)?.assetType ?? null),
      status: normalizeSeedanceAssetStatus(rawStatus),
      rawStatus,
      error: extractErrorMessage(payload),
      sourceUrl: typeof (payload as Record<string, unknown>)?.url === 'string'
        ? String((payload as Record<string, unknown>).url)
        : null,
      lastCheckedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load Seedance asset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
