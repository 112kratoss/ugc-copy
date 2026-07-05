import type { GenerationTiming } from '@/lib/generation-timing';

const GENERATION_STATUSES = new Set([
  'processing',
  'waiting',
  'succeeded',
  'failed',
]);

export type GenerationStatusResponse = {
  status: 'processing' | 'waiting' | 'succeeded' | 'failed';
  output?: string | null;
  outputs?: string[] | null;
  error?: string | null;
  timing?: GenerationTiming | null;
};

type FetchGenerationStatusOptions = {
  url: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return typeof payload.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : null;
}

export async function fetchGenerationStatus<
  T extends GenerationStatusResponse = GenerationStatusResponse,
>({
  url,
  accessToken,
  fetchImpl = fetch,
}: FetchGenerationStatusOptions): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) {
      throw new Error('Invalid generation status response.');
    }
  }

  if (!response.ok) {
    throw new Error(
      getErrorMessage(payload) ?? `Generation status request failed (${response.status}).`
    );
  }

  if (
    !isRecord(payload)
    || typeof payload.status !== 'string'
    || !GENERATION_STATUSES.has(payload.status)
  ) {
    throw new Error('Invalid generation status response.');
  }

  return payload as T;
}
