import type { GenerationStatusResponse } from './types';

export type GenerationKind = 'image' | 'video' | 'motion';

export function isGenerationFinished(status: string) {
  return status === 'succeeded' || status === 'failed';
}

export function getGenerationOutput(status: GenerationStatusResponse) {
  return status.outputs?.[0] ?? status.output ?? null;
}

export async function pollGenerationStatus(
  getStatus: () => Promise<GenerationStatusResponse>,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onTick?: (status: GenerationStatusResponse) => void;
  } = {}
) {
  const intervalMs = options.intervalMs ?? 4000;
  const timeoutMs = options.timeoutMs ?? 1000 * 60 * 12;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = await getStatus();
    options.onTick?.(status);
    if (isGenerationFinished(status.status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Generation is still processing. Check Studio in a few minutes.');
}
