import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import {
  AudioLines,
  ChevronRight,
  Image as ImageIcon,
  Layers,
  Play,
  Sparkles,
  Trash2,
  Video,
  Wand2,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MediaPreview } from '@/components/media-preview';
import { useAuth } from '@/lib/auth';
import { getGenerationOutput, pollGenerationStatus } from '@/lib/generation';
import {
  applyModelDefaults,
  buildGenerationPayload,
  buildPromptEnhancementRequest,
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
  defaultVideoMode,
  getCreditEstimate,
  getDefaultVideoDuration,
  getImageResolutionOptions,
  getMotionDuration,
  getVideoElementSupport,
  IMAGE_MODELS,
  isSeedance2Family,
  MOTION_MODELS,
  type CreationDraft,
  type ImageCreationDraft,
  type ImageModelId,
  type MediaDraft,
  type MotionCreationDraft,
  type MotionModelId,
  type VideoCreationDraft,
  type VideoModelId,
  VIDEO_MODELS,
  validateCreationDraft,
} from '@/lib/media-creation-view-model';
import { pickAudioDocument, pickMedia, pickMediaList, uploadPickedMedia } from '@/lib/media';
import { resolvedBottomInset, resolvedTopInset } from '@/lib/safe-area';
import { getMagicTabBarMetrics } from '@/lib/tab-bar-layout';
import { accentColor, appTheme, type ToolAccent } from '@/lib/theme';
import type { CreatorToolId, GenerationStartResponse, GenerationStatusResponse } from '@/lib/types';

const TOOL_META: Record<CreatorToolId, { title: string; accent: ToolAccent; Icon: typeof ImageIcon; subtitle: string }> = {
  image: {
    title: 'Image',
    accent: 'image',
    Icon: ImageIcon,
    subtitle: 'Reference-aware image generation',
  },
  video: {
    title: 'Video',
    accent: 'video',
    Icon: Video,
    subtitle: 'Frames, elements, sound, and shots',
  },
  motion: {
    title: 'Motion',
    accent: 'motion',
    Icon: Sparkles,
    subtitle: 'Character image plus motion video',
  },
};

function isTool(value: unknown): value is CreatorToolId {
  return value === 'image' || value === 'video' || value === 'motion';
}

function appendHandle(prompt: string, handle: string) {
  if (prompt.includes(handle)) return prompt;
  return `${prompt.trim()} ${handle}`.trim();
}

function assetDurationSeconds(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value > 1000 ? value / 1000 : value;
}

function mediaSummary(media: MediaDraft) {
  const bits = [media.fileName];
  if (typeof media.durationSeconds === 'number') {
    bits.push(`${Math.ceil(media.durationSeconds)}s`);
  }
  return bits.join(' • ');
}

export function MediaCreationScreen({
  initialTool = 'image',
  insideTab = false,
}: {
  initialTool?: CreatorToolId;
  insideTab?: boolean;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user, api, credits, updateCredits } = useAuth();
  const [activeTool, setActiveTool] = useState<CreatorToolId>(isTool(initialTool) ? initialTool : 'image');
  const [imageDraft, setImageDraft] = useState<ImageCreationDraft>(() => createDefaultCreationDraft('image'));
  const [videoDraft, setVideoDraft] = useState<VideoCreationDraft>(() => createDefaultCreationDraft('video'));
  const [motionDraft, setMotionDraft] = useState<MotionCreationDraft>(() => createDefaultCreationDraft('motion'));
  const [isUploading, setIsUploading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [status, setStatus] = useState<GenerationStatusResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const currentDraft: CreationDraft = activeTool === 'image' ? imageDraft : activeTool === 'video' ? videoDraft : motionDraft;
  const validation = useMemo(() => validateCreationDraft(currentDraft, { credits }), [currentDraft, credits]);
  const outputUrl = useMemo(() => (status ? getGenerationOutput(status) : null), [status]);
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const isCompact = width < 380;
  const meta = TOOL_META[activeTool];

  const replaceDraft = (draft: CreationDraft) => {
    const normalized = applyModelDefaults(draft);
    if (normalized.tool === 'image') setImageDraft(normalized);
    if (normalized.tool === 'video') setVideoDraft(normalized);
    if (normalized.tool === 'motion') setMotionDraft(normalized);
  };

  const updatePrompt = (prompt: string) => {
    if (activeTool === 'image') setImageDraft((draft) => ({ ...draft, prompt }));
    if (activeTool === 'video') setVideoDraft((draft) => ({ ...draft, prompt }));
    if (activeTool === 'motion') setMotionDraft((draft) => ({ ...draft, prompt }));
  };

  const uploadImageReferences = async (tool: 'image' | 'video') => {
    setMessage(null);
    setIsUploading(true);
    try {
      const picked = await pickMediaList('image', { allowsMultipleSelection: true });
      if (picked.length === 0) return;
      const uploaded: MediaDraft[] = [];
      for (const asset of picked) {
        const media = await uploadPickedMedia(asset.uri, {
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          kind: 'image',
          sizeBytes: asset.fileSize ?? null,
        });
        uploaded.push(createMediaDraftFromUpload(media));
      }
      if (tool === 'image') {
        setImageDraft((draft) => applyModelDefaults({ ...draft, references: [...draft.references, ...uploaded] }) as ImageCreationDraft);
      } else {
        setVideoDraft((draft) => applyModelDefaults({ ...draft, references: [...draft.references, ...uploaded], referenceMode: 'elements' }) as VideoCreationDraft);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const uploadSingleImage = async (role: 'start' | 'end' | 'character') => {
    setMessage(null);
    setIsUploading(true);
    try {
      const picked = await pickMedia('image');
      if (!picked) return;
      const uploaded = await uploadPickedMedia(picked.uri, {
        fileName: picked.fileName,
        mimeType: picked.mimeType,
        kind: 'image',
        sizeBytes: picked.fileSize ?? null,
      });
      const draft = createMediaDraftFromUpload(uploaded, {
        displayName: role === 'start' ? 'Start Frame' : role === 'end' ? 'End Frame' : 'Character Image',
      });
      if (role === 'character') {
        setMotionDraft((current) => ({ ...current, characterImage: draft }));
      } else {
        setVideoDraft((current) => ({ ...current, referenceMode: 'frames', [role === 'start' ? 'startFrame' : 'endFrame']: draft }));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const uploadReferenceVideo = async (target: 'video' | 'motion') => {
    setMessage(null);
    setIsUploading(true);
    try {
      const picked = await pickMedia('video');
      if (!picked) return;
      const uploaded = await uploadPickedMedia(picked.uri, {
        fileName: picked.fileName,
        mimeType: picked.mimeType,
        kind: 'video',
        durationSeconds: assetDurationSeconds(picked.duration),
        sizeBytes: picked.fileSize ?? null,
      });
      const media = createMediaDraftFromUpload(uploaded, {
        displayName: target === 'motion' ? 'Reference Motion' : 'Reference Video',
      });
      if (target === 'motion') {
        setMotionDraft((draft) => ({ ...draft, referenceVideo: media, duration: Math.ceil(media.durationSeconds ?? draft.duration) }));
      } else {
        setVideoDraft((draft) => applyModelDefaults({ ...draft, referenceVideos: [...draft.referenceVideos, media] }) as VideoCreationDraft);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const uploadReferenceAudio = async () => {
    setMessage(null);
    setIsUploading(true);
    try {
      const picked = await pickAudioDocument();
      if (!picked) return;
      const uploaded = await uploadPickedMedia(picked.uri, {
        fileName: picked.name,
        mimeType: picked.mimeType,
        kind: 'audio',
        sizeBytes: picked.size ?? null,
      });
      const media = createMediaDraftFromUpload(uploaded, { displayName: 'Reference Audio' });
      setVideoDraft((draft) => applyModelDefaults({ ...draft, referenceAudios: [...draft.referenceAudios, media] }) as VideoCreationDraft);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  const enhancePrompt = async () => {
    if (!currentDraft.prompt.trim()) {
      setMessage('Add a prompt before enhancing.');
      return;
    }
    if (!user) {
      router.push('/auth');
      return;
    }
    setMessage(null);
    setIsEnhancing(true);
    try {
      const result = await api.enhancePrompt(buildPromptEnhancementRequest(currentDraft));
      updatePrompt(result.enhancedPrompt);
      if (typeof result.remainingCredits === 'number') updateCredits(result.remainingCredits);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Prompt enhancement failed.');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsEnhancing(false);
    }
  };

  const generate = async () => {
    if (!user) {
      router.push('/auth');
      return;
    }
    const nextValidation = validateCreationDraft(currentDraft, { credits });
    if (nextValidation.errors.length > 0) {
      setMessage(nextValidation.errors[0]);
      return;
    }
    setMessage(null);
    setStatus(null);
    setIsGenerating(true);
    try {
      let started: GenerationStartResponse;
      if (currentDraft.tool === 'image') {
        started = await api.startImageGeneration(buildGenerationPayload(currentDraft));
        if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
        setStatus(await pollGenerationStatus(() => api.getImageGeneration(started.predictionId), { onTick: setStatus }));
      } else if (currentDraft.tool === 'video') {
        started = await api.startVideoGeneration(buildGenerationPayload(currentDraft));
        if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
        setStatus(await pollGenerationStatus(() => api.getVideoGeneration(started.predictionId), { onTick: setStatus }));
      } else {
        started = await api.startMotionGeneration(buildGenerationPayload(currentDraft));
        if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
        setStatus(await pollGenerationStatus(() => api.getMotionGeneration(started.predictionId), { onTick: setStatus }));
      }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Generation failed.');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#03040d' }}>
      <View style={{ position: 'absolute', inset: 0, backgroundColor: '#03040d' }} />
      <View style={{ position: 'absolute', top: -120, right: -120, width: 260, height: 260, borderRadius: 130, backgroundColor: 'rgba(217,70,239,0.16)' }} />
      <View style={{ position: 'absolute', bottom: 80, left: -120, width: 250, height: 250, borderRadius: 125, backgroundColor: 'rgba(56,189,248,0.11)' }} />
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topInset, backgroundColor: '#03040d', zIndex: 3 }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: topInset + 14,
          paddingHorizontal: isCompact ? 16 : 20,
          paddingBottom: insideTab ? tabBarMetrics.contentBottomPadding : bottomInset + 36,
          gap: 18,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: appTheme.colors.muted, fontSize: 13, fontWeight: '700' }}>Magic Booklet</Text>
            <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: '#ffffff', fontSize: isCompact ? 30 : 34, fontWeight: '900' }}>
              Create
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/(tabs)/pricing')}
            style={{
              minHeight: 44,
              borderRadius: appTheme.radii.pill,
              borderWidth: 1,
              borderColor: 'rgba(168,85,247,0.42)',
              backgroundColor: 'rgba(25,18,46,0.92)',
              paddingHorizontal: 14,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: '#ffffff', fontSize: 14, fontWeight: '900' }}>{credits ?? 0} credits</Text>
          </Pressable>
        </View>

        <LinearGradient
          colors={['rgba(217,70,239,0.18)', 'rgba(56,189,248,0.09)', 'rgba(6,8,24,0.96)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{
            borderRadius: 30,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.12)',
            padding: 16,
            gap: 14,
            overflow: 'hidden',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: `${accentColor(meta.accent)}22` }}>
              <meta.Icon size={26} color={accentColor(meta.accent)} strokeWidth={2.4} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: '#ffffff', fontSize: 21, fontWeight: '900' }}>{meta.title} generation</Text>
              <Text style={{ color: appTheme.colors.muted, fontSize: 13, lineHeight: 18 }}>{meta.subtitle}</Text>
            </View>
            <View style={{ borderRadius: appTheme.radii.pill, backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 10, paddingVertical: 6 }}>
              <Text style={{ color: '#ffffff', fontWeight: '900' }}>{validation.cost}</Text>
            </View>
          </View>
          <ToolSwitcher value={activeTool} onChange={setActiveTool} />
        </LinearGradient>

        <PromptPanel
          draft={currentDraft}
          isEnhancing={isEnhancing}
          onPromptChange={updatePrompt}
          onEnhance={enhancePrompt}
        />

        {activeTool === 'image' ? (
          <ImageControls
            draft={imageDraft}
            onChange={(draft) => replaceDraft(draft)}
            onUploadReferences={() => uploadImageReferences('image')}
            onRemoveReference={(id) => setImageDraft((draft) => ({ ...draft, references: draft.references.filter((media) => media.id !== id) }))}
            onUseHandle={(handle) => setImageDraft((draft) => ({ ...draft, prompt: appendHandle(draft.prompt, handle) }))}
            isUploading={isUploading}
          />
        ) : activeTool === 'video' ? (
          <VideoControls
            draft={videoDraft}
            onChange={(draft) => replaceDraft(draft)}
            onUploadReferences={() => uploadImageReferences('video')}
            onUploadStart={() => uploadSingleImage('start')}
            onUploadEnd={() => uploadSingleImage('end')}
            onUploadVideo={() => uploadReferenceVideo('video')}
            onUploadAudio={uploadReferenceAudio}
            onUseHandle={(handle) => setVideoDraft((draft) => ({ ...draft, prompt: appendHandle(draft.prompt, handle), referenceMode: 'elements' }))}
            onRemoveReference={(id) => setVideoDraft((draft) => ({ ...draft, references: draft.references.filter((media) => media.id !== id) }))}
            onRemoveReferenceVideo={(id) => setVideoDraft((draft) => ({ ...draft, referenceVideos: draft.referenceVideos.filter((media) => media.id !== id) }))}
            onRemoveReferenceAudio={(id) => setVideoDraft((draft) => ({ ...draft, referenceAudios: draft.referenceAudios.filter((media) => media.id !== id) }))}
            isUploading={isUploading}
          />
        ) : (
          <MotionControls
            draft={motionDraft}
            onChange={(draft) => replaceDraft(draft)}
            onUploadCharacter={() => uploadSingleImage('character')}
            onUploadReference={() => uploadReferenceVideo('motion')}
            isUploading={isUploading}
          />
        )}

        <ValidationPanel validation={validation} message={message} />

        <GenerateAction
          label={isGenerating ? 'Generating...' : `Generate ${meta.title}`}
          accent={meta.accent}
          disabled={isGenerating || isUploading || validation.errors.length > 0}
          loading={isGenerating}
          onPress={generate}
        />

        {status && status.status !== 'succeeded' ? (
          <GlassPanel>
            <Text style={{ color: '#ffffff', fontSize: 16, fontWeight: '900' }}>Generation {status.status}</Text>
            <Text style={{ color: appTheme.colors.muted, lineHeight: 20 }}>You can leave this screen and watch Notifications if it takes longer.</Text>
          </GlassPanel>
        ) : null}

        {outputUrl ? (
          <GlassPanel>
            <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '900' }}>Result</Text>
            <MediaPreview url={outputUrl} kind={activeTool === 'image' ? 'image' : 'video'} />
            <SecondaryAction label="Open Notifications" onPress={() => router.push('/(tabs)/studio')} />
          </GlassPanel>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ToolSwitcher({ value, onChange }: { value: CreatorToolId; onChange: (tool: CreatorToolId) => void }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: 'rgba(3,4,13,0.68)', borderRadius: appTheme.radii.pill, padding: 4, gap: 4 }}>
      {(['image', 'video', 'motion'] as const).map((tool) => {
        const active = value === tool;
        const meta = TOOL_META[tool];
        const Icon = meta.Icon;
        return (
          <Pressable
            key={tool}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tool)}
            style={{
              flex: 1,
              minHeight: 42,
              borderRadius: appTheme.radii.pill,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: 7,
              backgroundColor: active ? `${accentColor(meta.accent)}30` : 'transparent',
            }}
          >
            <Icon size={18} color={active ? accentColor(meta.accent) : appTheme.colors.muted} strokeWidth={2.4} />
            <Text style={{ color: active ? '#ffffff' : appTheme.colors.muted, fontWeight: '900', fontSize: 13 }}>{meta.title}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function GlassPanel({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        gap: 14,
        borderRadius: 26,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.12)',
        backgroundColor: 'rgba(9,10,24,0.86)',
        padding: 16,
      }}
    >
      {children}
    </View>
  );
}

function PromptPanel({
  draft,
  isEnhancing,
  onPromptChange,
  onEnhance,
}: {
  draft: CreationDraft;
  isEnhancing: boolean;
  onPromptChange: (value: string) => void;
  onEnhance: () => void;
}) {
  const optional = draft.tool === 'motion';
  return (
    <GlassPanel>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: '900' }}>{optional ? 'Prompt (optional)' : 'Prompt'}</Text>
          <Text numberOfLines={2} style={{ color: appTheme.colors.muted, fontSize: 12 }}>{draft.tool === 'video' && draft.isMultiShot ? 'Shot prompts below drive multi-shot mode.' : 'Use @handles after adding named references.'}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onEnhance}
          disabled={isEnhancing}
          style={{
            minHeight: 38,
            borderRadius: appTheme.radii.pill,
            borderWidth: 1,
            borderColor: 'rgba(217,70,239,0.34)',
            paddingHorizontal: 12,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 7,
            flexShrink: 0,
            opacity: isEnhancing ? 0.6 : 1,
          }}
        >
          {isEnhancing ? <ActivityIndicator color="#ffffff" size="small" /> : <Wand2 size={16} color="#f0abfc" />}
          <Text style={{ color: '#ffffff', fontWeight: '900', fontSize: 12 }}>Enhance</Text>
        </Pressable>
      </View>
      <TextInput
        value={draft.prompt}
        onChangeText={onPromptChange}
        multiline
        textAlignVertical="top"
        placeholder={draft.tool === 'image' ? 'Describe the final image...' : draft.tool === 'video' ? 'Describe action, camera, lighting, sound...' : 'Optional motion direction...'}
        placeholderTextColor="rgba(255,255,255,0.34)"
        style={{
          minHeight: 132,
          borderRadius: 22,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.12)',
          backgroundColor: 'rgba(0,0,0,0.28)',
          color: '#ffffff',
          fontSize: 15,
          lineHeight: 22,
          paddingHorizontal: 14,
          paddingVertical: 14,
        }}
      />
    </GlassPanel>
  );
}

function ImageControls({
  draft,
  onChange,
  onUploadReferences,
  onRemoveReference,
  onUseHandle,
  isUploading,
}: {
  draft: ImageCreationDraft;
  onChange: (draft: ImageCreationDraft) => void;
  onUploadReferences: () => void;
  onRemoveReference: (id: string) => void;
  onUseHandle: (handle: string) => void;
  isUploading: boolean;
}) {
  const model = IMAGE_MODELS[draft.model];
  const resolutionOptions = getImageResolutionOptions(draft.model, draft.aspectRatio);
  return (
    <GlassPanel>
      <SectionLabel title="Image Model" icon={<ImageIcon size={17} color={accentColor('image')} />} />
      <ModelPicker
        items={Object.values(IMAGE_MODELS)}
        value={draft.model}
        accent="image"
        onChange={(modelId) => onChange({ ...draft, model: modelId as ImageModelId })}
      />
      <OptionRow title="Aspect Ratio">
        {model.aspectRatios.map((ratio) => (
          <Chip key={ratio} label={ratio} active={draft.aspectRatio === ratio} onPress={() => onChange({ ...draft, aspectRatio: ratio })} />
        ))}
      </OptionRow>
      <OptionRow title="Resolution">
        {resolutionOptions.map((resolution) => (
          <Chip key={resolution} label={resolution} active={draft.resolution === resolution} onPress={() => onChange({ ...draft, resolution })} />
        ))}
      </OptionRow>
      {model.supportsOutputFormat ? (
        <OptionRow title="Output">
          {model.outputFormats.map((format) => (
            <Chip key={format} label={format.toUpperCase()} active={draft.outputFormat === format} onPress={() => onChange({ ...draft, outputFormat: format })} />
          ))}
        </OptionRow>
      ) : null}
      {draft.model === 'grok-imagine-image' ? (
        <OptionRow title="Quality">
          <Chip label="Standard" active={draft.qualityMode === 'standard'} onPress={() => onChange({ ...draft, qualityMode: 'standard' })} />
          <Chip label="Quality" active={draft.qualityMode === 'quality'} onPress={() => onChange({ ...draft, qualityMode: 'quality' })} />
        </OptionRow>
      ) : null}
      {model.supportsGoogleSearch ? (
        <ToggleRow title="Google Search" value={draft.googleSearch} onValueChange={(googleSearch) => onChange({ ...draft, googleSearch })} />
      ) : null}
      <UploadBlock
        title={`Reference images (${draft.references.length}/${model.maxImages})`}
        actionLabel="Add images"
        onPress={onUploadReferences}
        disabled={isUploading}
      />
      <MediaList items={draft.references} onRemove={onRemoveReference} onUseHandle={onUseHandle} />
    </GlassPanel>
  );
}

function VideoControls({
  draft,
  onChange,
  onUploadReferences,
  onUploadStart,
  onUploadEnd,
  onUploadVideo,
  onUploadAudio,
  onUseHandle,
  onRemoveReference,
  onRemoveReferenceVideo,
  onRemoveReferenceAudio,
  isUploading,
}: {
  draft: VideoCreationDraft;
  onChange: (draft: VideoCreationDraft) => void;
  onUploadReferences: () => void;
  onUploadStart: () => void;
  onUploadEnd: () => void;
  onUploadVideo: () => void;
  onUploadAudio: () => void;
  onUseHandle: (handle: string) => void;
  onRemoveReference: (id: string) => void;
  onRemoveReferenceVideo: (id: string) => void;
  onRemoveReferenceAudio: (id: string) => void;
  isUploading: boolean;
}) {
  const model = VIDEO_MODELS[draft.model];
  const elementSupport = getVideoElementSupport(draft.model, { mode: draft.mode, isMultiShot: draft.isMultiShot });
  return (
    <GlassPanel>
      <SectionLabel title="Video Model" icon={<Video size={17} color={accentColor('video')} />} />
      <ModelPicker
        items={Object.values(VIDEO_MODELS)}
        value={draft.model}
        accent="video"
        onChange={(modelId) => {
          const nextModel = modelId as VideoModelId;
          onChange({
            ...draft,
            model: nextModel,
            mode: defaultVideoMode(nextModel),
            duration: getDefaultVideoDuration(nextModel),
          });
        }}
      />
      {model.supportsMultiShot ? (
        <ToggleRow title="Multi-shot" value={draft.isMultiShot} onValueChange={(isMultiShot) => onChange({ ...draft, isMultiShot })} />
      ) : null}
      {draft.isMultiShot ? <ShotEditor draft={draft} onChange={onChange} /> : null}
      <OptionRow title="Aspect Ratio">
        {model.aspectRatios.map((ratio) => (
          <Chip key={ratio} label={ratio} active={draft.aspectRatio === ratio} onPress={() => onChange({ ...draft, aspectRatio: ratio })} />
        ))}
      </OptionRow>
      {model.modeOptions.length > 0 ? (
        <OptionRow title="Mode">
          {model.modeOptions.map((option) => (
            <Chip key={option.value} label={option.label} active={draft.mode === option.value} onPress={() => onChange({ ...draft, mode: option.value })} />
          ))}
        </OptionRow>
      ) : null}
      {model.resolutions.length > 0 ? (
        <OptionRow title="Resolution">
          {model.resolutions.map((resolution) => (
            <Chip key={resolution} label={resolution} active={draft.resolution === resolution} onPress={() => onChange({ ...draft, resolution })} />
          ))}
        </OptionRow>
      ) : null}
      {model.provider !== 'veo' && !draft.isMultiShot ? (
        <OptionRow title="Duration">
          {model.durations.map((duration) => (
            <Chip key={duration} label={`${duration}s`} active={draft.duration === duration} onPress={() => onChange({ ...draft, duration })} />
          ))}
        </OptionRow>
      ) : null}
      {model.supportsSound ? <ToggleRow title="Generate sound" value={draft.sound} onValueChange={(sound) => onChange({ ...draft, sound })} /> : null}
      {model.supportsFixedLens ? <ToggleRow title="Fixed lens" value={draft.fixedLens} onValueChange={(fixedLens) => onChange({ ...draft, fixedLens })} /> : null}
      <OptionRow title="Reference Mode">
        <Chip label="Frames" active={draft.referenceMode === 'frames'} onPress={() => onChange({ ...draft, referenceMode: 'frames' })} />
        <Chip label="Elements" active={draft.referenceMode === 'elements'} onPress={() => onChange({ ...draft, referenceMode: 'elements' })} />
      </OptionRow>
      {draft.referenceMode === 'frames' ? (
        <View style={{ gap: 10 }}>
          <UploadBlock title="Start frame" actionLabel={draft.startFrame ? 'Replace start' : 'Add start'} onPress={onUploadStart} disabled={isUploading} />
          {draft.startFrame ? <MediaList items={[draft.startFrame]} onRemove={() => onChange({ ...draft, startFrame: null })} /> : null}
          <UploadBlock title="End frame" actionLabel={draft.endFrame ? 'Replace end' : 'Add end'} onPress={onUploadEnd} disabled={isUploading || draft.isMultiShot} />
          {draft.endFrame ? <MediaList items={[draft.endFrame]} onRemove={() => onChange({ ...draft, endFrame: null })} /> : null}
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <UploadBlock
            title={`Named image elements (${draft.references.length}/${elementSupport.maxElements})`}
            actionLabel={elementSupport.enabled ? 'Add elements' : 'Unavailable'}
            onPress={onUploadReferences}
            disabled={isUploading || !elementSupport.enabled}
          />
          {elementSupport.reason ? <Text style={{ color: appTheme.colors.muted, lineHeight: 19 }}>{elementSupport.reason}</Text> : null}
          <MediaList items={draft.references} onRemove={onRemoveReference} onUseHandle={onUseHandle} />
        </View>
      )}
      {isSeedance2Family(draft.model) ? (
        <View style={{ gap: 10 }}>
          <UploadBlock title={`Reference videos (${draft.referenceVideos.length}/3)`} actionLabel="Add video" onPress={onUploadVideo} disabled={isUploading} />
          <MediaList items={draft.referenceVideos} onRemove={onRemoveReferenceVideo} />
          <UploadBlock title="Reference audio" actionLabel="Add audio" onPress={onUploadAudio} disabled={isUploading} />
          <MediaList items={draft.referenceAudios} onRemove={onRemoveReferenceAudio} />
        </View>
      ) : null}
    </GlassPanel>
  );
}

function MotionControls({
  draft,
  onChange,
  onUploadCharacter,
  onUploadReference,
  isUploading,
}: {
  draft: MotionCreationDraft;
  onChange: (draft: MotionCreationDraft) => void;
  onUploadCharacter: () => void;
  onUploadReference: () => void;
  isUploading: boolean;
}) {
  const duration = getMotionDuration(draft);
  return (
    <GlassPanel>
      <SectionLabel title="Motion Model" icon={<Sparkles size={17} color={accentColor('motion')} />} />
      <ModelPicker
        items={Object.values(MOTION_MODELS)}
        value={draft.model}
        accent="motion"
        onChange={(modelId) => onChange({ ...draft, model: modelId as MotionModelId })}
      />
      <OptionRow title="Resolution">
        {MOTION_MODELS[draft.model].resolutions.map((resolution) => (
          <Chip key={resolution} label={resolution} active={draft.mode === resolution} onPress={() => onChange({ ...draft, mode: resolution })} />
        ))}
      </OptionRow>
      <OptionRow title="Orientation">
        <Chip label="Video" active={draft.characterOrientation === 'video'} onPress={() => onChange({ ...draft, characterOrientation: 'video' })} />
        <Chip label="Image" active={draft.characterOrientation === 'image'} onPress={() => onChange({ ...draft, characterOrientation: 'image' })} />
      </OptionRow>
      <UploadBlock title="Character image" actionLabel={draft.characterImage ? 'Replace image' : 'Add image'} onPress={onUploadCharacter} disabled={isUploading} />
      {draft.characterImage ? <MediaList items={[draft.characterImage]} onRemove={() => onChange({ ...draft, characterImage: null })} /> : null}
      <UploadBlock title={`Reference motion video${duration ? ` • ${duration}s` : ''}`} actionLabel={draft.referenceVideo ? 'Replace video' : 'Add video'} onPress={onUploadReference} disabled={isUploading} />
      {draft.referenceVideo ? <MediaList items={[draft.referenceVideo]} onRemove={() => onChange({ ...draft, referenceVideo: null })} /> : null}
    </GlassPanel>
  );
}

function ModelPicker({
  items,
  value,
  accent,
  onChange,
}: {
  items: Array<{ id: string; displayName: string; description: string; badge?: string }>;
  value: string;
  accent: ToolAccent;
  onChange: (id: string) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingRight: 10 }}>
      {items.map((item) => {
        const active = item.id === value;
        return (
          <Pressable
            key={item.id}
            onPress={() => onChange(item.id)}
            style={{
              width: 208,
              minHeight: 116,
              borderRadius: 22,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: active ? `${accentColor(accent)}AA` : 'rgba(255,255,255,0.12)',
              backgroundColor: active ? `${accentColor(accent)}18` : 'rgba(255,255,255,0.05)',
              padding: 14,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text numberOfLines={2} style={{ flex: 1, color: '#ffffff', fontSize: 16, fontWeight: '900' }}>{item.displayName}</Text>
              {item.badge ? (
                <Text style={{ color: accentColor(accent), fontSize: 10, fontWeight: '900' }}>{item.badge}</Text>
              ) : null}
            </View>
            <Text numberOfLines={3} style={{ color: appTheme.colors.muted, lineHeight: 18, fontSize: 12 }}>{item.description}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ShotEditor({ draft, onChange }: { draft: VideoCreationDraft; onChange: (draft: VideoCreationDraft) => void }) {
  const updateShot = (id: string, patch: Partial<{ prompt: string; duration: number }>) => {
    onChange({
      ...draft,
      multiPrompts: draft.multiPrompts.map((shot) => (shot.id === id ? { ...shot, ...patch } : shot)),
    });
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <Text style={{ color: '#ffffff', fontWeight: '900' }}>Shots</Text>
        <SecondaryAction
          label="Add shot"
          compact
          onPress={() => onChange({
            ...draft,
            multiPrompts: [...draft.multiPrompts, { id: `shot-${draft.multiPrompts.length + 1}`, prompt: '', duration: 5 }],
          })}
        />
      </View>
      {draft.multiPrompts.map((shot, index) => (
        <View
          key={shot.id}
          style={{
            borderRadius: 18,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.1)',
            backgroundColor: 'rgba(255,255,255,0.04)',
            padding: 12,
            gap: 10,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <Text style={{ color: '#ffffff', fontWeight: '900' }}>Shot {index + 1}</Text>
            <Pressable
              disabled={draft.multiPrompts.length <= 1}
              onPress={() => onChange({ ...draft, multiPrompts: draft.multiPrompts.filter((item) => item.id !== shot.id) })}
              style={{ opacity: draft.multiPrompts.length <= 1 ? 0.35 : 1 }}
            >
              <Trash2 size={16} color={appTheme.colors.muted} />
            </Pressable>
          </View>
          <TextInput
            value={shot.prompt}
            onChangeText={(prompt) => updateShot(shot.id, { prompt })}
            multiline
            textAlignVertical="top"
            placeholder="Describe this shot..."
            placeholderTextColor="rgba(255,255,255,0.32)"
            style={{
              minHeight: 78,
              color: '#ffffff',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.1)',
              borderRadius: 16,
              padding: 12,
              backgroundColor: 'rgba(0,0,0,0.22)',
            }}
          />
          <OptionRow title="Duration">
            {[3, 4, 5, 6, 8, 10, 12].map((duration) => (
              <Chip key={duration} label={`${duration}s`} active={shot.duration === duration} onPress={() => updateShot(shot.id, { duration })} />
            ))}
          </OptionRow>
        </View>
      ))}
    </View>
  );
}

function SectionLabel({ title, icon }: { title: string; icon: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {icon}
      <Text style={{ color: '#ffffff', fontSize: 17, fontWeight: '900' }}>{title}</Text>
    </View>
  );
}

function OptionRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: appTheme.colors.muted, fontSize: 12, fontWeight: '800', textTransform: 'uppercase' }}>{title}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        minHeight: 36,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: active ? 'rgba(217,70,239,0.7)' : 'rgba(255,255,255,0.12)',
        backgroundColor: active ? 'rgba(168,85,247,0.28)' : 'rgba(255,255,255,0.05)',
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text numberOfLines={1} style={{ color: active ? '#ffffff' : appTheme.colors.muted, fontSize: 12, fontWeight: '900' }}>{label}</Text>
    </Pressable>
  );
}

function ToggleRow({ title, value, onValueChange }: { title: string; value: boolean; onValueChange: (value: boolean) => void }) {
  return (
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ color: '#ffffff', fontSize: 15, fontWeight: '800' }}>{title}</Text>
      <Switch value={value} onValueChange={onValueChange} thumbColor={value ? '#ffffff' : '#d4d4d8'} trackColor={{ false: 'rgba(255,255,255,0.18)', true: 'rgba(217,70,239,0.62)' }} />
    </View>
  );
}

function UploadBlock({
  title,
  actionLabel,
  onPress,
  disabled,
}: {
  title: string;
  actionLabel: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View
      style={{
        minHeight: 70,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(255,255,255,0.04)',
        padding: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(168,85,247,0.18)' }}>
        <Layers size={20} color="#d946ef" />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ color: '#ffffff', fontWeight: '900' }}>{title}</Text>
        <Text style={{ color: appTheme.colors.muted, fontSize: 12 }}>Upload from your phone</Text>
      </View>
      <Pressable
        disabled={disabled}
        onPress={onPress}
        style={{
          minHeight: 38,
          borderRadius: appTheme.radii.pill,
          paddingHorizontal: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.09)',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text style={{ color: '#ffffff', fontWeight: '900', fontSize: 12 }}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

function MediaList({
  items,
  onRemove,
  onUseHandle,
}: {
  items: MediaDraft[];
  onRemove: (id: string) => void;
  onUseHandle?: (handle: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <View style={{ gap: 8 }}>
      {items.map((media) => (
        <View
          key={media.id}
          style={{
            minHeight: 52,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.08)',
            backgroundColor: 'rgba(0,0,0,0.2)',
            paddingHorizontal: 12,
            paddingVertical: 9,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          {media.kind === 'audio' ? <AudioLines size={18} color="#f0abfc" /> : media.kind === 'video' ? <Play size={18} color="#fda4af" /> : <ImageIcon size={18} color="#7dd3fc" />}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: '#ffffff', fontSize: 13, fontWeight: '900' }}>{media.displayName}</Text>
            <Text numberOfLines={1} style={{ color: appTheme.colors.muted, fontSize: 11 }}>{mediaSummary(media)}</Text>
          </View>
          {media.handle && onUseHandle ? (
            <Pressable onPress={() => onUseHandle(media.handle!)} style={{ borderRadius: appTheme.radii.pill, backgroundColor: 'rgba(56,189,248,0.12)', paddingHorizontal: 9, paddingVertical: 6 }}>
              <Text style={{ color: '#7dd3fc', fontSize: 11, fontWeight: '900' }}>{media.handle}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => onRemove(media.id)} hitSlop={8}>
            <Trash2 size={17} color={appTheme.colors.muted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function SecondaryAction({
  label,
  onPress,
  compact,
}: {
  label: string;
  onPress: () => void;
  compact?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        minHeight: compact ? 34 : 46,
        borderRadius: appTheme.radii.pill,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.16)',
        paddingHorizontal: compact ? 12 : 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 6,
      }}
    >
      <Text style={{ color: '#ffffff', fontWeight: '900', fontSize: compact ? 12 : 14 }}>{label}</Text>
      <ChevronRight size={compact ? 14 : 16} color="#ffffff" />
    </Pressable>
  );
}

function GenerateAction({
  label,
  accent,
  disabled,
  loading,
  onPress,
}: {
  label: string;
  accent: ToolAccent;
  disabled?: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 58,
        borderRadius: appTheme.radii.pill,
        overflow: 'hidden',
        opacity: pressed ? 0.88 : disabled || loading ? 0.58 : 1,
        boxShadow: disabled ? 'none' : `0 16px 42px ${accentColor(accent)}44`,
      })}
    >
      <LinearGradient
        colors={['#f032d0', '#8b3dff', '#38bdf8']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ minHeight: 58, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10 }}
      >
        {loading ? <ActivityIndicator color="#ffffff" /> : <Sparkles size={22} color="#ffffff" strokeWidth={2.5} />}
        <Text style={{ color: '#ffffff', fontSize: 17, fontWeight: '900' }}>{label}</Text>
      </LinearGradient>
    </Pressable>
  );
}

function ValidationPanel({
  validation,
  message,
}: {
  validation: ReturnType<typeof validateCreationDraft>;
  message: string | null;
}) {
  if (!message && validation.errors.length === 0 && validation.warnings.length === 0) {
    return (
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingHorizontal: 2 }}>
        <Sparkles size={15} color={appTheme.colors.success} />
        <Text style={{ color: appTheme.colors.success, fontWeight: '800' }}>Ready • {validation.cost} credits</Text>
      </View>
    );
  }

  return (
    <GlassPanel>
      {message ? <Text selectable style={{ color: appTheme.colors.danger, fontWeight: '900', lineHeight: 20 }}>{message}</Text> : null}
      {validation.errors.map((error) => (
        <Text selectable key={error} style={{ color: appTheme.colors.danger, lineHeight: 20 }}>{error}</Text>
      ))}
      {validation.warnings.map((warning) => (
        <Text selectable key={`${warning.code}-${warning.message}`} style={{ color: warning.severity === 'blocking' ? appTheme.colors.danger : appTheme.colors.amber, lineHeight: 20 }}>
          {warning.message}
        </Text>
      ))}
    </GlassPanel>
  );
}
