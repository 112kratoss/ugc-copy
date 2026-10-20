import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';

/**
 * The largest picture Kie takes in each request field that carries pictures, for each Kie
 * endpoint the app sends pictures to, as the endpoint's docs page
 * (docs.kie.ai/market/<page>.md) documented it on 2026-10-20; the line numbers cited are
 * that day's. Kie fetches a run's pictures only after the start has held its credits and
 * answers one over the limit with a failed task, so the run failed and was refunded.
 * Every start now measures the pictures it sends and asks this first, before any hold
 * (provider-image-sizes).
 *
 * Kie's "MB" is read as 1,024 × 1,024 bytes, the larger reading and the unit of the app's
 * own upload caps, so no picture Kie takes is refused here; Seedance's "less than 30 MB"
 * is held as at most 30 MB for the same reason. An endpoint or field with no entry
 * documents no size for its pictures and is never measured: among the endpoints the app
 * sends pictures to, the GPT Image and Wan 2.7 pages, pixverse/reference-to-video,
 * kling-3.0/video's frames, the Seedance 2 frames and Veo name none, and wan/2-7-r2v's
 * "up to `30MB`" (:168) is its reference voice. Seedance 1.5 Pro's page is gone (404), so
 * the 10 MB of its archived capture cannot be re-read and is not held.
 */

const MEGABYTE = 1024 * 1024;

/** What a field's pictures are to the run, which is how a refusal names them. */
export type ProviderImageRole = 'reference' | 'frame' | 'image' | 'character' | 'element';

export type ProviderImageFieldLimit = {
  /**
   * The field of the request's `input` holding the pictures: a link or a list of links.
   * `kling_elements` is read element by element, and only an image element's pictures.
   */
  field: string;
  role: ProviderImageRole;
  /** The largest picture Kie takes, in its MB. */
  maxMegabytes: number;
  /** The limit is for the field's pictures together, not each (Ideogram Character). */
  total?: boolean;
};

function limit(
  field: string,
  role: ProviderImageRole,
  maxMegabytes: number,
  options: { total?: boolean } = {},
): ProviderImageFieldLimit {
  return { field, role, maxMegabytes, ...(options.total ? { total: true } : {}) };
}

const WAN_3_LIMITS = [
  limit('first_frame_url', 'frame', 20),
  limit('last_frame_url', 'frame', 20),
  limit('reference_image_urls', 'reference', 20),
];

const SEEDANCE_2_LIMITS = [limit('reference_image_urls', 'reference', 30)];

const PROVIDER_IMAGE_LIMITS: Readonly<Record<string, readonly ProviderImageFieldLimit[]>> = {
  // ── 10 MB a picture ──
  // FLUX.2 Pro: input_urls "Max size: 10.0MB" (flux2/pro-image-to-image:108-112).
  'flux-2/pro-image-to-image': [limit('input_urls', 'reference', 10)],
  // Grok Imagine: image_urls "Max size: 10.0MB per image" (grok-imagine/image-to-image:164-172).
  'grok-imagine/image-to-image': [limit('image_urls', 'reference', 10)],
  // Grok Imagine Video: image_urls "Maximum file size for each image: 10MB"
  // (grok-imagine/image-to-video:105-119); the run's references, or its start frame.
  'grok-imagine/image-to-video': [limit('image_urls', 'image', 10)],
  // Hailuo 2.3: image_url "Max size: 10.0MB" (hailuo/2-3-image-to-video-standard:126-130,
  // hailuo/2-3-image-to-video-pro:124-128).
  'hailuo/2-3-image-to-video-standard': [limit('image_url', 'frame', 10)],
  'hailuo/2-3-image-to-video-pro': [limit('image_url', 'frame', 10)],
  // Kling 3 Turbo: image_urls "Max size: 10.0MB" (kling/v3-turbo-image-to-video:137-145).
  'kling/v3-turbo-image-to-video': [limit('image_urls', 'frame', 10)],
  // Kling 3.0 Cinematic: an element is "Either 2–4 images (JPG/PNG, up to 10 MB each) or 1
  // video" (kling/kling-3-0:581-588; also :176, :228). Its frames carry no limit (:428-439).
  'kling-3.0/video': [limit('kling_elements', 'element', 10)],
  // Kling 2.6 and 3.0 motion control: the character image "Max size: 10.0MB"
  // (kling/motion-control:170-176), "Max File Size: 10MB per file" (kling/motion-control-v3:35, :60).
  'kling-2.6/motion-control': [limit('input_urls', 'character', 10)],
  'kling-3.0/motion-control': [limit('input_urls', 'character', 10)],
  // Qwen Image 3.0 and Pro: image_urls "Maximum file size: 10 MB per image"
  // (qwen3/image-to-image:26, :98-104; qwen3-pro/image-to-image:26, :98-104).
  'qwen3/image-to-image': [limit('image_urls', 'reference', 10)],
  'qwen3/pro-image-to-image': [limit('image_urls', 'reference', 10)],
  // Ideogram V3 remix: image_url "Max size: 10.0MB" (ideogram/v3-remix:96-107).
  'ideogram/v3-remix': [limit('image_url', 'reference', 10)],
  // Ideogram Character: reference_image_urls "maximum total size 10MB across all character
  // references" (ideogram/character:123-131).
  'ideogram/character': [limit('reference_image_urls', 'reference', 10, { total: true })],

  // ── 20 MB a picture ──
  // Gemini Omni Video: image_urls "Each file must be no larger than `20MB`" (gemini-omni-video:132-145).
  'gemini-omni-video': [limit('image_urls', 'reference', 20)],
  // Gemini Omni 1.1 Flash: image_urls "Each file must not exceed `20MB`"
  // (google/gemini-omni-flash-1-1:136-149); its frames name no size (:161-182).
  'google/gemini-omni-flash-1-1': [limit('image_urls', 'reference', 20)],
  // HappyHorse 1.1: the first frame "File size: Up to 20 MB" (happyhorse-1-1/image-to-video:106-123),
  // reference_image "Maximum file size: 20 MB" (happyhorse-1-1/reference-to-video:109-127).
  'happyhorse-1-1/image-to-video': [limit('image_urls', 'frame', 20)],
  'happyhorse-1-1/reference-to-video': [limit('reference_image', 'reference', 20)],
  // Grok Imagine Video 1.5: image_urls "Maximum file size: 20MB" (grok-imagine/1-5-preview:106-114);
  // the run's references, or its frames.
  'grok-imagine-video-1-5-preview': [limit('image_urls', 'image', 20)],
  // PixVerse V6: the start frame "Single image size not exceeding 20 MB"
  // (pixverse/image-to-video:121-129); each frame of a transition "must not exceed 20 MB"
  // (pixverse/transition:120-127, :130-137).
  'pixverse-v6/image-to-video': [limit('image_urls', 'frame', 20)],
  'pixverse-v6/transition': [
    limit('first_frame_image_url', 'frame', 20),
    limit('last_frame_image_url', 'frame', 20),
  ],
  // Wan 3.0 and 3.0 Prime: first_frame_url "≤ 20MB", last_frame_url "Same format limits",
  // reference_image_urls "the same as `first_frame_url`" (wan/3-0-video:111-140,
  // wan/3-0-video-prime:111-140).
  'wan/3-0-video': WAN_3_LIMITS,
  'wan/3-0-video-prime': WAN_3_LIMITS,

  // ── 30 MB a picture ──
  // Nano Banana 2, 2 Lite and Pro: "Max size: 30.0MB" (google/nanobanana2:123-128,
  // google/nano-banana-2-lite:95-109, google/pro-image-to-image:117-122).
  'nano-banana-2': [limit('image_input', 'reference', 30)],
  'nano-banana-2-lite': [limit('image_urls', 'reference', 30)],
  'nano-banana-pro': [limit('image_input', 'reference', 30)],
  // Seedream 5 Pro, Lite and Flash: image_urls "Max size: 30.0MB"
  // (seedream/5-pro-image-to-image:126-130, seedream-5-lite-image-to-image:114-118,
  // seedream/5-flash-image-to-image:120-124).
  'seedream/5-pro-image-to-image': [limit('image_urls', 'reference', 30)],
  'seedream/5-lite-image-to-image': [limit('image_urls', 'reference', 30)],
  'seedream/5-flash-image-to-image': [limit('image_urls', 'reference', 30)],
  // Seedance 2, Fast, Mini and 2.5: reference_image_urls "Size: Single image less than 30
  // MB" (bytedance/seedance-2:179-196, -2-fast:179-196, -2-mini:179-196, -2-5:184-201).
  // Seedance 1.5 Pro (delisted on Kie's site 2026-10-20; its API still runs it): input_urls
  // "Max File Size: 10MB", from the captured page (docs/model-api-references/bytedance/
  // seedance-1.5-pro.md:80-84), the last one Kie published. It is the guided first video.
  'bytedance/seedance-1.5-pro': [limit('input_urls', 'frame', 10)],
  'bytedance/seedance-2': SEEDANCE_2_LIMITS,
  'bytedance/seedance-2-fast': SEEDANCE_2_LIMITS,
  'bytedance/seedance-2-mini': SEEDANCE_2_LIMITS,
  'bytedance/seedance-2-5': SEEDANCE_2_LIMITS,
  // MiniMax H3: each frame "single image size not exceeding 30 MB"
  // (minimax-h3/image-to-video:98-104, :111-114); each reference "cannot exceed 30 MB"
  // (minimax-h3/reference-to-video:109-115).
  'minimax-h3/image-to-video': [
    limit('first_frame_url', 'frame', 30),
    limit('last_frame_url', 'frame', 30),
  ],
  'minimax-h3/reference-to-video': [limit('reference_image_urls', 'reference', 30)],
  // Qwen Image 2.1: image_urls "up to 30MB and 25MP each" (qwen2-1/image-to-image:84-89).
  'qwen2-1/image-to-image': [limit('image_urls', 'reference', 30)],

  // ── 50 MB a picture ──
  // Kling O3: image_urls "each file must not exceed 50 MB", frames
  // (kling/v3-omni-image-to-video:128-135, :444-452) and references
  // (kling/v3-omni-reference-to-video:129-143, :530-541).
  'kling-3.0-omni/image-to-video': [limit('image_urls', 'frame', 50)],
  'kling-3.0-omni/reference-to-video': [limit('image_urls', 'reference', 50)],
};

/** The picture fields of a Kie endpoint that have a documented size limit. */
export function providerImageFieldLimits(providerModelId: string): readonly ProviderImageFieldLimit[] {
  const key = providerModelId.trim();
  return Object.hasOwn(PROVIDER_IMAGE_LIMITS, key) ? PROVIDER_IMAGE_LIMITS[key] : [];
}

export type ProviderRequestImage = {
  /** The link the provider is sent, as the request carries it. */
  url: string;
  /** How a refusal names it: "Reference 2", "the start frame". */
  label: string;
  limit: ProviderImageFieldLimit;
};

export type MeasuredProviderImage = ProviderRequestImage & {
  /** Its size in bytes, or null when it could not be learned. */
  sizeBytes: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function links(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function labelFor(fieldLimit: ProviderImageFieldLimit, index: number, count: number): string {
  switch (fieldLimit.role) {
    case 'frame':
      return /last/.test(fieldLimit.field) || index > 0 ? 'the end frame' : 'the start frame';
    case 'character':
      return count === 1 ? 'the character image' : `Character image ${index + 1}`;
    case 'image':
      return `Image ${index + 1}`;
    default:
      return `Reference ${index + 1}`;
  }
}

/**
 * The pictures a provider request (`{ model, input }`, as createTask is sent it) carries in
 * fields whose size Kie limits, in the order the request lists them, each with its limit.
 * A request to an endpoint with no documented limit carries none here.
 */
export function providerRequestImages(request: unknown): ProviderRequestImage[] {
  if (!isRecord(request) || typeof request.model !== 'string' || !isRecord(request.input)) return [];
  const input = request.input;
  return providerImageFieldLimits(request.model).flatMap((fieldLimit): ProviderRequestImage[] => {
    if (fieldLimit.field === 'kling_elements') {
      const elements = Array.isArray(input.kling_elements) ? input.kling_elements : [];
      return elements.flatMap((element, elementIndex) => {
        if (!isRecord(element)) return [];
        const urls = links(element.element_input_urls);
        // An element is 2–4 pictures or one clip; a clip is not a picture.
        if (urls.length < 2) return [];
        const name = typeof element.name === 'string' && element.name.trim()
          ? `@${element.name.trim()}`
          : `element ${elementIndex + 1}`;
        return urls.map((url, index) => ({ url, label: `image ${index + 1} of ${name}`, limit: fieldLimit }));
      });
    }
    const urls = links(input[fieldLimit.field]);
    return urls.map((url, index) => ({ url, label: labelFor(fieldLimit, index, urls.length), limit: fieldLimit }));
  });
}

const ROLE_NOUNS: Readonly<Record<ProviderImageRole, string>> = {
  reference: 'reference images',
  frame: 'frames',
  image: 'images',
  character: 'character images',
  element: 'element images',
};

/** The name the creators show for a model, so a refusal says which model it is. */
function modelDisplayName(modelId: string): string {
  for (const models of [IMAGE_MODELS, VIDEO_MODELS, MOTION_MODELS] as const) {
    if (Object.hasOwn(models, modelId)) {
      return (models as Record<string, { displayName: string }>)[modelId].displayName;
    }
  }
  return modelId;
}

/** Rounded up to a tenth, so a picture refused for its size never reads as within the limit. */
function megabytes(bytes: number): string {
  // Dividing by a power of two is exact, so the rounding carries no error of its own.
  return `${(Math.ceil((bytes * 10) / MEGABYTE) / 10).toFixed(1)} MB`;
}

function knownSize(image: MeasuredProviderImage): number | null {
  return typeof image.sizeBytes === 'number' && Number.isFinite(image.sizeBytes) && image.sizeBytes >= 0
    ? image.sizeBytes
    : null;
}

/**
 * Why Kie would refuse a request's pictures for their size, in words for the creator that
 * name the model, the limit and the picture, or null when every size known is within it.
 * A picture whose size is unknown is never the reason: a limit on the pictures together
 * refuses only when the ones known already pass it.
 */
export function providerImageSizeViolation(
  modelId: string,
  images: readonly MeasuredProviderImage[],
): string | null {
  const name = modelDisplayName(modelId);
  const totals = new Map<ProviderImageFieldLimit, number>();
  for (const image of images) {
    const size = knownSize(image);
    if (size === null) continue;
    if (image.limit.total) {
      totals.set(image.limit, (totals.get(image.limit) ?? 0) + size);
      continue;
    }
    if (size > image.limit.maxMegabytes * MEGABYTE) {
      return `${name} takes ${ROLE_NOUNS[image.limit.role]} up to ${image.limit.maxMegabytes} MB; ${image.label} is ${megabytes(size)}.`;
    }
  }
  for (const [fieldLimit, total] of totals) {
    if (total > fieldLimit.maxMegabytes * MEGABYTE) {
      return `${name} takes up to ${fieldLimit.maxMegabytes} MB of ${ROLE_NOUNS[fieldLimit.role]} in total; yours come to ${megabytes(total)}.`;
    }
  }
  return null;
}
