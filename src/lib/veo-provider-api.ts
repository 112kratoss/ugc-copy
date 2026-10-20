/**
 * Veo 3.1 on Kie: which API a generation's task lives on, the body the jobs API is
 * sent, and where a finished jobs-API task keeps its video.
 *
 * Kie moved Veo 3.1 from its own endpoints (POST /api/v1/veo/generate, polled at
 * GET /api/v1/veo/record-info) to the unified market API: POST
 * /api/v1/jobs/createTask with `model: "veo-3-1"`, polled at GET
 * /api/v1/jobs/recordInfo (docs.kie.ai/veo3-api/generate-veo-3-video.md, read
 * 2026-10-20; the old page moved to docs.kie.ai/old-model/veo3-api/…). A task is
 * known only to the API that created it, so every Veo start on the jobs API marks
 * its generation's `workflow_settings` with {@link VEO_JOBS_PROVIDER_API_SETTINGS},
 * and every status check reads that marker. A row without it was started on the
 * legacy endpoints before the move and is still checked there: no row written
 * before this change is ever read under the new shape.
 *
 * Field mapping, legacy flat body → jobs body (`input.*`, snake-cased):
 *   model (the tier: veo3 | veo3_fast | veo3_lite) → model "veo-3-1" + input.model
 *   prompt → input.prompt
 *   generationType → input.generation_type (same three values)
 *   imageUrls → input.image_urls
 *   aspect_ratio → input.aspect_ratio (16:9 | 9:16 | Auto, same spelling)
 *   resolution → input.resolution (720p | 1080p | 4k)
 *   (duration, omitted: Kie's default 8) → input.duration 8, sent explicitly
 * The app sent no watermark, seed, enable_fallback or enableTranslation before
 * and sends none now.
 */

export const VEO_JOBS_MODEL_ID = 'veo-3-1';

/** What a jobs-API Veo start writes into its generation's `workflow_settings`. */
export const VEO_JOBS_PROVIDER_API_SETTINGS: Readonly<{ providerApi: 'jobs' }> = Object.freeze({
  providerApi: 'jobs',
});

export type VeoProviderApi = 'jobs' | 'legacy';

/**
 * The catalog's providerModelMap values for veo-3.1 (the creator's mode ids) and the
 * jobs API's `input.model` tier for each: the same three ids, listed so that any
 * other published value is refused instead of being sent.
 */
const VEO_JOBS_TIERS = {
  veo3: 'veo3',
  veo3_fast: 'veo3_fast',
  veo3_lite: 'veo3_lite',
} as const;

export type VeoJobsTier = (typeof VEO_JOBS_TIERS)[keyof typeof VEO_JOBS_TIERS];

export type VeoGenerationType = 'TEXT_2_VIDEO' | 'FIRST_AND_LAST_FRAMES_2_VIDEO' | 'REFERENCE_2_VIDEO';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Which Kie API a Veo generation's task was created on, read from its `workflow_settings`. */
export function readVeoProviderApi(workflowSettings: unknown): VeoProviderApi {
  return isRecord(workflowSettings)
    && workflowSettings.providerApi === VEO_JOBS_PROVIDER_API_SETTINGS.providerApi
    ? 'jobs'
    : 'legacy';
}

/** The jobs API's `input.model` for a published providerModelMap value, or a refusal. */
export function veoJobsTier(providerModelId: string): VeoJobsTier {
  const tier = Object.hasOwn(VEO_JOBS_TIERS, providerModelId)
    ? VEO_JOBS_TIERS[providerModelId as keyof typeof VEO_JOBS_TIERS]
    : null;
  if (!tier) {
    throw new Error(`Veo 3.1 has no jobs-API tier for the provider model ${JSON.stringify(providerModelId)}.`);
  }
  return tier;
}

/**
 * The POST /api/v1/jobs/createTask body for a Veo 3.1 run, without its callBackUrl
 * (the task creator adds it). Reference pictures win over frames, as they did in the
 * legacy body; a run cannot carry both (the start refuses that earlier).
 */
export function buildVeoJobsTaskBody(params: {
  prompt: string;
  /** The providerModelMap value for the run's mode: veo3, veo3_fast or veo3_lite. */
  providerModelId: string;
  aspectRatio: string;
  resolution: string;
  durationSeconds: number;
  referenceImageUrls: readonly string[];
  /** [start] or [start, end]. */
  frameImageUrls: readonly string[];
}): { model: typeof VEO_JOBS_MODEL_ID; input: Record<string, unknown> } {
  const generationType: VeoGenerationType = params.referenceImageUrls.length > 0
    ? 'REFERENCE_2_VIDEO'
    : params.frameImageUrls.length > 0
      ? 'FIRST_AND_LAST_FRAMES_2_VIDEO'
      : 'TEXT_2_VIDEO';
  const imageUrls = params.referenceImageUrls.length > 0
    ? params.referenceImageUrls
    : params.frameImageUrls;

  return {
    model: VEO_JOBS_MODEL_ID,
    input: {
      prompt: params.prompt,
      model: veoJobsTier(params.providerModelId),
      generation_type: generationType,
      ...(imageUrls.length > 0 ? { image_urls: [...imageUrls] } : {}),
      aspect_ratio: params.aspectRatio,
      resolution: params.resolution,
      duration: params.durationSeconds,
    },
  };
}

function firstUrl(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) return entry.trim();
    }
    return null;
  }
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim();
    if (text.startsWith('[')) {
      try {
        return firstUrl(JSON.parse(text));
      } catch {
        return null;
      }
    }
    return text;
  }
  return null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const RENDERED_LIST_KEYS = ['result_urls', 'resultUrls'] as const;
const ORIGIN_LIST_KEYS = ['origin_urls', 'originUrls'] as const;

/**
 * The video a finished jobs-API Veo task produced, read from its record
 * (GET /api/v1/jobs/recordInfo `data`) or a callback's `data`, or null.
 *
 * The market API keeps a result at `resultJson.resultUrls`; Kie's Veo docs put a
 * 1080p or 4k render at `resultJson.data.result_urls` and its 720p original at
 * `data.origin_urls`, and Veo's own callbacks at `info.resultUrls`. Every rendered
 * list is read before any origin list, so a 1080p or 4k run is never delivered at
 * 720p while its render exists; an origin list stands in only when no rendered list
 * has a URL, the order the legacy reader used (resultUrls, then originUrls).
 */
export function readVeoJobsResultUrl(task: unknown): string | null {
  if (!isRecord(task)) return null;

  const result = parseRecord(task.resultJson);
  const response = parseRecord(task.response);
  const info = parseRecord(task.info);
  const containers = [
    parseRecord(result?.data),
    result,
    parseRecord(response?.data),
    response,
    info,
    // The record's own keys last: the docs put the 720p original at `data.origin_urls`.
    // Only Lite 720p was run live (2026-10-20, `resultJson.resultUrls`), so a 1080p or 4k
    // record that keeps a list there is still read rather than failing after Kie billed.
    task,
  ].filter((container): container is Record<string, unknown> => container !== null);

  for (const keys of [RENDERED_LIST_KEYS, ORIGIN_LIST_KEYS]) {
    for (const container of containers) {
      for (const key of keys) {
        const url = firstUrl(container[key]);
        if (url) return url;
      }
    }
  }
  return null;
}
