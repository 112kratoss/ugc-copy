import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getImageCost,
  getMotionCost,
  getSoundEffectCost,
  getVideoCost,
  isValidVideoDuration,
  getVoiceoverCost,
  IMAGE_MODELS,
  MOTION_MODELS,
  SOUND_EFFECT_MODELS,
  VIDEO_MODELS,
  VOICEOVER_MODELS,
  isAudioModel,
  isImageModel,
  type ImageModelId,
  type MotionModelId,
  type SoundEffectModelId,
  type VideoModelId,
  type VoiceoverModelId,
} from '@/lib/models';

const KIE_API_KEY = process.env.KIE_AI_API_KEY;

interface StartGenerationResult {
  predictionId: string;
  remainingCredits: number;
  cost: number;
  generationId?: string;
}

interface DialogueTurnInput {
  text: string;
  voice: string;
}

interface SyncableGenerationRecord {
  id: string;
  user_id: string;
  prediction_id: string | null;
  status: string;
  output_url: string | null;
  model: string;
  category: string | null;
  workflow_settings: Record<string, unknown> | null;
}

function requireApiKey(): string {
  if (!KIE_API_KEY) {
    throw new Error('Server configuration error: API key missing');
  }
  return KIE_API_KEY;
}

async function deductCreditsOrThrow(supabase: SupabaseClient, userId: string, cost: number): Promise<number> {
  const { data: remainingCredits, error } = await supabase.rpc('deduct_credits', {
    p_user_id: userId,
    p_cost: cost,
  });

  if (error) {
    throw new Error(error.message || 'Failed to verify credits');
  }

  if (remainingCredits === -1) {
    throw new Error(`Insufficient credits. This action costs ${cost} credits.`);
  }

  return remainingCredits;
}

async function refundCreditsQuietly(supabase: SupabaseClient, userId: string, amount: number) {
  try {
    await supabase.rpc('refund_credits', { p_user_id: userId, p_amount: amount });
  } catch (error) {
    console.error('Failed to refund credits:', error);
  }
}

async function createKieTask(body: Record<string, unknown>, endpoint = 'https://api.kie.ai/api/v1/jobs/createTask') {
  requireApiKey();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok || data.code !== 200) {
    throw new Error(data.msg || 'Provider rejected the request');
  }

  return data.data.taskId as string;
}

function trimPrompt(prompt: string, errorMessage: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error(errorMessage);
  }

  return trimmed;
}

function normalizeDialogueTurns(dialogueTurns: DialogueTurnInput[] | undefined): DialogueTurnInput[] {
  return (dialogueTurns || [])
    .map((turn) => ({
      text: turn.text.trim(),
      voice: turn.voice.trim(),
    }))
    .filter((turn) => turn.text && turn.voice);
}

function buildVoicePromptPreview(model: VoiceoverModelId, text: string | undefined, dialogueTurns: DialogueTurnInput[]): string {
  if (model === 'text-to-dialogue-v3') {
    return dialogueTurns.map((turn) => `${turn.voice}: ${turn.text}`).join('\n');
  }

  return text?.trim() || '';
}

function getStoredWorkflowModel(workflowSettings: Record<string, unknown> | null, fallbackModel: string): string {
  const model = workflowSettings?.model;
  return typeof model === 'string' ? model : fallbackModel;
}

function getFirstResultUrl(value: unknown): string | null {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : null;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return getFirstResultUrl(parsed);
    } catch {
      return value;
    }
  }

  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    return getFirstResultUrl(candidate.resultUrls)
      || getFirstResultUrl(candidate.originUrls)
      || getFirstResultUrl(candidate.resultUrl)
      || getFirstResultUrl(candidate.url);
  }

  return null;
}

function inferOutputExtension(tempUrl: string, contentType: string, category: string | null): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (contentType.includes('wav') || contentType.includes('wave')) return 'wav';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3';
  if (contentType.includes('ogg')) return 'ogg';
  if (contentType.includes('flac')) return 'flac';
  if (contentType.includes('mp4')) return 'mp4';

  try {
    const pathname = new URL(tempUrl).pathname;
    const ext = pathname.split('.').pop();
    if (ext) return ext.toLowerCase();
  } catch {
    // Ignore URL parsing failures and fall back below.
  }

  if (category === 'image') return 'jpg';
  if (category === 'audio') return 'mp3';
  return 'mp4';
}

function getStorageBucket(category: string | null, model: string): 'generated_images' | 'generated_videos' | 'generated_audio' {
  if (category === 'audio' || isAudioModel(model)) {
    return 'generated_audio';
  }

  if (category === 'image' || isImageModel(model)) {
    return 'generated_images';
  }

  return 'generated_videos';
}

async function persistGeneratedOutput(
  supabase: SupabaseClient,
  generation: SyncableGenerationRecord,
  tempUrl: string
) {
  const bucket = getStorageBucket(generation.category, generation.model);

  try {
    const mediaResponse = await fetch(tempUrl);
    if (!mediaResponse.ok) {
      throw new Error('Failed to download generated media from KIE');
    }

    const mediaBlob = await mediaResponse.blob();
    const extension = inferOutputExtension(tempUrl, mediaBlob.type, generation.category);
    const fileName = `${generation.user_id}/generated_${generation.prediction_id}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(fileName, mediaBlob, {
        contentType: mediaBlob.type || undefined,
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload to Supabase Storage failed:', uploadError);
      await supabase
        .from('generations')
        .update({ status: 'succeeded', output_url: tempUrl })
        .eq('id', generation.id);
      return;
    }

    const storagePath = `${bucket}/${fileName}`;
    await supabase
      .from('generations')
      .update({ status: 'succeeded', output_url: storagePath })
      .eq('id', generation.id);
  } catch (error) {
    console.error('Error persisting generated output:', error);
    await supabase
      .from('generations')
      .update({ status: 'succeeded', output_url: tempUrl })
      .eq('id', generation.id);
  }
}

async function markGenerationFailed(supabase: SupabaseClient, generation: SyncableGenerationRecord) {
  await supabase
    .from('generations')
    .update({ status: 'failed' })
    .eq('id', generation.id);
  await supabase.rpc('refund_generation', { p_prediction_id: generation.prediction_id });
}

function isVeoGeneration(generation: SyncableGenerationRecord): boolean {
  const workflowModel = getStoredWorkflowModel(generation.workflow_settings, generation.model);
  return workflowModel === 'veo-3.1' || generation.model === 'veo3' || generation.model === 'veo3_fast';
}

async function syncSingleGenerationStatus(supabase: SupabaseClient, generation: SyncableGenerationRecord) {
  if (!generation.prediction_id || generation.status !== 'processing') {
    return;
  }

  if (isVeoGeneration(generation)) {
    const response = await fetch(`https://api.kie.ai/api/v1/veo/record-info?taskId=${generation.prediction_id}`, {
      headers: { Authorization: `Bearer ${KIE_API_KEY}` },
    });
    const data = await response.json();

    if (!response.ok || data.code !== 200) {
      throw new Error(data.msg || 'Failed to check Veo status');
    }

    const successFlag = data.data?.successFlag;
    const responseData = data.data?.response;
    if (successFlag === 1) {
      const tempUrl = getFirstResultUrl(responseData?.resultUrls) || getFirstResultUrl(responseData?.originUrls);
      if (tempUrl) {
        await persistGeneratedOutput(supabase, generation, tempUrl);
      } else {
        await supabase.from('generations').update({ status: 'succeeded' }).eq('id', generation.id);
      }
      return;
    }

    if (successFlag === 2 || successFlag === 3) {
      await markGenerationFailed(supabase, generation);
    }

    return;
  }

  const response = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${generation.prediction_id}`, {
    headers: { Authorization: `Bearer ${KIE_API_KEY}` },
  });
  const data = await response.json();

  if (!response.ok || data.code !== 200) {
    throw new Error(data.msg || 'Failed to check generation status');
  }

  const state = data.data?.state;
  if (state === 'success') {
    let tempUrl: string | null = null;

    try {
      const result = typeof data.data?.resultJson === 'string'
        ? JSON.parse(data.data.resultJson)
        : data.data?.resultJson;
      tempUrl = getFirstResultUrl(result);
    } catch (error) {
      console.error('Error parsing generation result JSON:', error);
    }

    if (tempUrl) {
      await persistGeneratedOutput(supabase, generation, tempUrl);
    } else {
      await supabase.from('generations').update({ status: 'succeeded' }).eq('id', generation.id);
    }
    return;
  }

  if (state === 'fail') {
    await markGenerationFailed(supabase, generation);
  }
}

export async function syncGenerationStatuses(params: {
  supabase: SupabaseClient;
  generationIds: string[];
}) {
  requireApiKey();

  const generationIds = Array.from(new Set(params.generationIds.filter(Boolean)));
  if (generationIds.length === 0) {
    return;
  }

  const { data: generations } = await params.supabase
    .from('generations')
    .select('id, user_id, prediction_id, status, output_url, model, category, workflow_settings')
    .in('id', generationIds);

  for (const generation of (generations || []) as SyncableGenerationRecord[]) {
    try {
      await syncSingleGenerationStatus(params.supabase, generation);
    } catch (error) {
      console.error(`Failed to sync generation ${generation.id}:`, error);
    }
  }
}

export async function startImageGeneration(params: {
  supabase: SupabaseClient;
  userId: string;
  prompt: string;
  model: ImageModelId;
  imageUrls?: string[];
  aspectRatio?: string;
  resolution?: '1K' | '2K' | '4K';
  outputFormat?: 'jpg' | 'png';
  googleSearch?: boolean;
}): Promise<StartGenerationResult> {
  requireApiKey();
  const {
    supabase,
    userId,
    prompt,
    model,
    imageUrls = [],
    aspectRatio = 'auto',
    resolution = '1K',
    outputFormat = 'jpg',
    googleSearch = false,
  } = params;

  const trimmedPrompt = trimPrompt(prompt, 'A prompt is required to generate an image.');
  const modelConfig = IMAGE_MODELS[model];
  if (!modelConfig) {
    throw new Error(`Unsupported image model: ${model}`);
  }

  const cost = getImageCost(model, resolution);
  const remainingCredits = await deductCreditsOrThrow(supabase, userId, cost);

  try {
    const input: Record<string, unknown> = {
      prompt: trimmedPrompt,
      aspect_ratio: aspectRatio,
      resolution,
      output_format: outputFormat,
    };

    if (modelConfig.supportsGoogleSearch) {
      input.google_search = googleSearch;
    }

    if (imageUrls.length > 0) {
      input.image_input = imageUrls.slice(0, modelConfig.maxImages);
    }

    const predictionId = await createKieTask({ model, input });
    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model,
        cost,
        prediction_id: predictionId,
        status: 'processing',
        prompt: trimmedPrompt,
        category: 'image',
        workflow_settings: {
          model,
          aspectRatio,
          resolution,
          outputFormat,
          googleSearch,
        },
      })
      .select('id')
      .single();

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(supabase, userId, cost);
    throw error;
  }
}

export async function startVideoGeneration(params: {
  supabase: SupabaseClient;
  userId: string;
  prompt: string;
  model: VideoModelId;
  imageUrls?: string[];
  mode?: string;
  aspectRatio?: string;
  sound?: boolean;
  duration?: number;
  resolution?: string;
  fixedLens?: boolean;
}): Promise<StartGenerationResult> {
  requireApiKey();
  const {
    supabase,
    userId,
    prompt,
    model,
    imageUrls = [],
    mode = 'std',
    aspectRatio = '9:16',
    sound = false,
    duration = 5,
    resolution = '720p',
    fixedLens = false,
  } = params;

  const trimmedPrompt = trimPrompt(prompt, 'A prompt is required to generate a video.');
  const selectedModel = VIDEO_MODELS[model];
  if (!selectedModel) {
    throw new Error(`Unsupported video model: ${model}`);
  }

  const soundEnabled = selectedModel.supportsSound ? sound : false;
  if (selectedModel.provider !== 'veo' && !isValidVideoDuration(model, duration)) {
    throw new Error(`Unsupported duration for ${selectedModel.displayName}`);
  }
  const totalDuration = selectedModel.provider === 'veo' ? selectedModel.durations[0] : duration;
  const cost = getVideoCost(model, {
    mode,
    sound: soundEnabled,
    durationSeconds: totalDuration,
    resolution,
  });
  const remainingCredits = await deductCreditsOrThrow(supabase, userId, cost);

  try {
    let endpoint = 'https://api.kie.ai/api/v1/jobs/createTask';
    let body: Record<string, unknown>;
    let providerModelId = selectedModel.apiModelId || mode;

    if (selectedModel.provider === 'kling') {
      body = {
        model: selectedModel.apiModelId,
        input: {
          prompt: trimmedPrompt,
          mode,
          aspect_ratio: aspectRatio,
          sound: soundEnabled,
          multi_shots: false,
          duration: String(totalDuration),
          ...(imageUrls.length > 0 ? { image_urls: imageUrls } : {}),
        },
      };
    } else if (selectedModel.provider === 'seedance') {
      body = {
        model: selectedModel.apiModelId,
        input: {
          prompt: trimmedPrompt,
          aspect_ratio: aspectRatio,
          resolution,
          duration: String(duration),
          fixed_lens: fixedLens,
          generate_audio: soundEnabled,
          ...(imageUrls.length > 0 ? { input_urls: imageUrls } : {}),
        },
      };
    } else {
      endpoint = 'https://api.kie.ai/api/v1/veo/generate';
      providerModelId = mode === 'veo3' ? 'veo3' : 'veo3_fast';
      body = {
        prompt: trimmedPrompt,
        model: providerModelId,
        aspectRatio,
        generationType: imageUrls.length > 0 ? 'FIRST_AND_LAST_FRAMES_2_VIDEO' : 'TEXT_2_VIDEO',
        ...(imageUrls.length > 0 ? { imageUrls } : {}),
      };
    }

    const predictionId = await createKieTask(body, endpoint);
    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model: providerModelId,
        cost,
        duration: totalDuration,
        prediction_id: predictionId,
        status: 'processing',
        prompt: trimmedPrompt,
        category: 'video',
        workflow_settings: {
          model,
          mode,
          aspectRatio,
          sound: soundEnabled,
          duration: totalDuration,
          resolution,
          fixedLens,
        },
      })
      .select('id')
      .single();

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(supabase, userId, cost);
    throw error;
  }
}

export async function startMotionGeneration(params: {
  supabase: SupabaseClient;
  userId: string;
  prompt: string;
  model: MotionModelId;
  referenceVideoUrl: string;
  characterImageUrl: string;
  duration: number;
  characterOrientation?: 'video' | 'image';
  mode?: '720p' | '1080p';
}): Promise<StartGenerationResult> {
  requireApiKey();
  const {
    supabase,
    userId,
    prompt,
    model,
    referenceVideoUrl,
    characterImageUrl,
    duration,
    characterOrientation = 'video',
    mode = '720p',
  } = params;

  if (!referenceVideoUrl || !characterImageUrl) {
    throw new Error('Motion generation requires both a reference video and a character image.');
  }

  const selectedModel = MOTION_MODELS[model];
  if (!selectedModel) {
    throw new Error(`Unsupported motion model: ${model}`);
  }

  const cost = getMotionCost(model, mode, duration);
  const remainingCredits = await deductCreditsOrThrow(supabase, userId, cost);
  const webhookSecret = process.env.WEBHOOK_SECRET ?? 'kd92mxp4n7qbt1ej';
  const callbackUrl = `https://ildfmhozpibwiopeavfg.supabase.co/functions/v1/kie-webhook?secret=${webhookSecret}`;

  try {
    const predictionId = await createKieTask({
      model: selectedModel.apiModelId,
      callBackUrl: callbackUrl,
      input: {
        prompt: prompt.trim() || 'The character follows the reference performance naturally.',
        input_urls: [characterImageUrl],
        video_urls: [referenceVideoUrl],
        character_orientation: characterOrientation,
        mode,
      },
    });

    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model: selectedModel.apiModelId,
        duration,
        cost,
        prediction_id: predictionId,
        status: 'processing',
        prompt: prompt.trim(),
        category: 'motion',
        workflow_settings: {
          model,
          characterOrientation,
          mode,
          duration,
        },
      })
      .select('id')
      .single();

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(supabase, userId, cost);
    throw error;
  }
}

export async function startVoiceoverGeneration(params: {
  supabase: SupabaseClient;
  userId: string;
  model: VoiceoverModelId;
  text?: string;
  voice?: string;
  languageCode?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  timestamps?: boolean;
  dialogueTurns?: DialogueTurnInput[];
}): Promise<StartGenerationResult> {
  requireApiKey();
  const {
    supabase,
    userId,
    model,
    text,
    voice = 'Rachel',
    languageCode = 'en',
    stability = 0.4,
    similarityBoost = 0.8,
    style = 0,
    speed = 1,
    timestamps = false,
    dialogueTurns,
  } = params;

  const selectedModel = VOICEOVER_MODELS[model];
  if (!selectedModel) {
    throw new Error(`Unsupported voiceover model: ${model}`);
  }

  const normalizedDialogueTurns = normalizeDialogueTurns(dialogueTurns);
  const trimmedText = text?.trim() || '';
  if (model === 'text-to-dialogue-v3') {
    if (normalizedDialogueTurns.length === 0) {
      throw new Error('Dialogue generation requires at least one dialogue turn.');
    }
  } else if (!trimmedText) {
    throw new Error('Voiceover generation requires a prompt input.');
  }

  const cost = getVoiceoverCost(model, {
    text: trimmedText,
    dialogueTurns: normalizedDialogueTurns,
  });
  const remainingCredits = await deductCreditsOrThrow(supabase, userId, cost);

  try {
    let input: Record<string, unknown>;
    if (model === 'text-to-dialogue-v3') {
      input = {
        dialogue: normalizedDialogueTurns,
        stability,
      };

      if (languageCode.trim()) {
        input.language_code = languageCode.trim();
      }
    } else {
      input = {
        text: trimmedText,
        voice: voice.trim() || 'Rachel',
        stability,
        similarity_boost: similarityBoost,
        style,
        speed,
        timestamps,
      };

      if (languageCode.trim()) {
        input.language_code = languageCode.trim();
      }
    }

    const predictionId = await createKieTask({
      model: selectedModel.apiModelId,
      input,
    });

    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model: selectedModel.apiModelId,
        cost,
        prediction_id: predictionId,
        status: 'processing',
        prompt: buildVoicePromptPreview(model, trimmedText, normalizedDialogueTurns),
        category: 'audio',
        workflow_settings: {
          model,
          voice,
          languageCode,
          stability,
          similarityBoost,
          style,
          speed,
          timestamps,
          dialogueTurns: normalizedDialogueTurns,
        },
      })
      .select('id')
      .single();

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(supabase, userId, cost);
    throw error;
  }
}

export async function startSoundEffectGeneration(params: {
  supabase: SupabaseClient;
  userId: string;
  prompt: string;
  model?: SoundEffectModelId;
  duration?: number;
  loop?: boolean;
  promptInfluence?: number;
  outputFormat?: 'mp3' | 'wav';
}): Promise<StartGenerationResult> {
  requireApiKey();
  const {
    supabase,
    userId,
    prompt,
    model = 'sound-effect-v2',
    duration = 5,
    loop = false,
    promptInfluence = 0.3,
    outputFormat = 'mp3',
  } = params;

  const trimmedPrompt = trimPrompt(prompt, 'Sound-effect generation requires a prompt input.');
  const selectedModel = SOUND_EFFECT_MODELS[model];
  if (!selectedModel) {
    throw new Error(`Unsupported sound-effect model: ${model}`);
  }

  const cost = getSoundEffectCost(model, duration);
  const remainingCredits = await deductCreditsOrThrow(supabase, userId, cost);

  try {
    const predictionId = await createKieTask({
      model: selectedModel.apiModelId,
      input: {
        text: trimmedPrompt,
        loop,
        duration_seconds: duration,
        prompt_influence: promptInfluence,
        output_format: outputFormat,
      },
    });

    const insert = await supabase
      .from('generations')
      .insert({
        user_id: userId,
        model: selectedModel.apiModelId,
        cost,
        duration,
        prediction_id: predictionId,
        status: 'processing',
        prompt: trimmedPrompt,
        category: 'audio',
        workflow_settings: {
          model,
          duration,
          loop,
          promptInfluence,
          outputFormat,
        },
      })
      .select('id')
      .single();

    return {
      predictionId,
      remainingCredits,
      cost,
      generationId: insert.data?.id,
    };
  } catch (error) {
    await refundCreditsQuietly(supabase, userId, cost);
    throw error;
  }
}
