import * as Haptics from 'expo-haptics';
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
import {
  AppText,
  ChoiceChip,
  DisclosureSection,
  MetricCard,
  PrimaryButton,
  ReadinessRow,
  SecondaryButton,
  SurfaceSection,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { getGenerationOutput, pollGenerationStatus } from '@/lib/generation';
import {
  applyModelDefaults,
  buildGenerationPayload,
  buildPromptEnhancementRequest,
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
  defaultVideoMode,
  getCreationReadiness,
  getCreationSectionSummary,
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

const TOOL_META: Record<CreatorToolId, { title: string; accent: ToolAccent; subtitle: string }> = {
  image: {
    title: 'Image',
    accent: 'image',
    subtitle: 'Reference-aware image generation',
  },
  video: {
    title: 'Video',
    accent: 'video',
    subtitle: 'Frames, elements, sound, and shots',
  },
  motion: {
    title: 'Motion',
    accent: 'motion',
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
  const [lastGenerationId, setLastGenerationId] = useState<string | null>(null);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const currentDraft: CreationDraft = activeTool === 'image' ? imageDraft : activeTool === 'video' ? videoDraft : motionDraft;
  const validation = useMemo(() => validateCreationDraft(currentDraft, { credits }), [currentDraft, credits]);
  const sectionSummary = useMemo(() => getCreationSectionSummary(currentDraft), [currentDraft]);
  const readiness = useMemo(() => getCreationReadiness(currentDraft, validation), [currentDraft, validation]);
  const outputUrl = useMemo(() => (status ? getGenerationOutput(status) : null), [status]);
  const topInset = resolvedTopInset(insets.top);
  const bottomInset = resolvedBottomInset(insets.bottom);
  const tabBarMetrics = getMagicTabBarMetrics(width, bottomInset);
  const isCompact = width < 380;
  const meta = TOOL_META[activeTool];

  const changeTool = (tool: CreatorToolId) => {
    setActiveTool(tool);
    setAdvancedExpanded(false);
    setMessage(null);
  };

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
    setLastGenerationId(null);
    setIsGenerating(true);
    try {
      let started: GenerationStartResponse;
      if (currentDraft.tool === 'image') {
        started = await api.startImageGeneration(buildGenerationPayload(currentDraft));
        setLastGenerationId(started.generationId ?? null);
        if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
        setStatus(await pollGenerationStatus(() => api.getImageGeneration(started.predictionId), { onTick: setStatus }));
      } else if (currentDraft.tool === 'video') {
        started = await api.startVideoGeneration(buildGenerationPayload(currentDraft));
        setLastGenerationId(started.generationId ?? null);
        if (typeof started.remainingCredits === 'number') updateCredits(started.remainingCredits);
        setStatus(await pollGenerationStatus(() => api.getVideoGeneration(started.predictionId), { onTick: setStatus }));
      } else {
        started = await api.startMotionGeneration(buildGenerationPayload(currentDraft));
        setLastGenerationId(started.generationId ?? null);
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
    <View style={{ flex: 1, backgroundColor: appTheme.colors.background }}>
      <View style={{ position: 'absolute', inset: 0, backgroundColor: appTheme.colors.background }} />
      <View style={{ position: 'absolute', top: -120, right: -120, width: 260, height: 260, borderRadius: 130, backgroundColor: 'rgba(217,70,239,0.16)' }} />
      <View style={{ position: 'absolute', bottom: 80, left: -120, width: 250, height: 250, borderRadius: 125, backgroundColor: 'rgba(56,189,248,0.11)' }} />
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: topInset, backgroundColor: appTheme.colors.background, zIndex: 3 }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: topInset + 14,
          paddingHorizontal: isCompact ? 16 : 20,
          paddingBottom: insideTab ? tabBarMetrics.contentBottomOverlapPadding : bottomInset + 36,
          gap: 18,
        }}
      >
        <SurfaceSection
          eyebrow="Magic Booklet"
          title="Create"
          body={`${meta.title} generation · ${meta.subtitle}`}
          accent={meta.accent}
        >
          <ToolSwitcher value={activeTool} onChange={changeTool} />
          <View style={{ flexDirection: 'row', gap: appTheme.spacing.gap }}>
            <MetricCard
              label="Credits"
              value={String(credits ?? 0)}
              body="available"
              accent="amber"
              compact
              onPress={() => router.push('/(tabs)/pricing')}
            />
            <MetricCard
              label="Cost"
              value={String(validation.cost)}
              body={`${meta.title.toLowerCase()} run`}
              accent={meta.accent}
              compact
            />
          </View>
        </SurfaceSection>

        <PromptPanel
          draft={currentDraft}
          isEnhancing={isEnhancing}
          onPromptChange={updatePrompt}
          onEnhance={enhancePrompt}
        />

        <SurfaceSection
          eyebrow="Step 1"
          title="Essentials"
          body={sectionSummary.essentials}
          accent={meta.accent}
        >
          <CreationEssentials
            activeTool={activeTool}
            imageDraft={imageDraft}
            videoDraft={videoDraft}
            motionDraft={motionDraft}
            onChange={replaceDraft}
          />
        </SurfaceSection>

        <SurfaceSection
          eyebrow="Step 2"
          title="References"
          body={sectionSummary.references}
          accent={activeTool === 'image' ? 'image' : activeTool === 'video' ? 'video' : 'motion'}
        >
          <CreationReferences
            activeTool={activeTool}
            imageDraft={imageDraft}
            videoDraft={videoDraft}
            motionDraft={motionDraft}
            onImageChange={setImageDraft}
            onVideoChange={setVideoDraft}
            onMotionChange={setMotionDraft}
            onUploadImageReferences={() => uploadImageReferences('image')}
            onUploadVideoReferences={() => uploadImageReferences('video')}
            onUploadStart={() => uploadSingleImage('start')}
            onUploadEnd={() => uploadSingleImage('end')}
            onUploadCharacter={() => uploadSingleImage('character')}
            onUploadMotionReference={() => uploadReferenceVideo('motion')}
            onUseImageHandle={(handle) => setImageDraft((draft) => ({ ...draft, prompt: appendHandle(draft.prompt, handle) }))}
            onUseVideoHandle={(handle) => setVideoDraft((draft) => ({ ...draft, prompt: appendHandle(draft.prompt, handle), referenceMode: 'elements' }))}
            isUploading={isUploading}
          />
        </SurfaceSection>

        <DisclosureSection
          title="Advanced"
          body={sectionSummary.advanced}
          accent={meta.accent}
          expanded={advancedExpanded}
          onToggle={() => setAdvancedExpanded((expanded) => !expanded)}
        >
          <CreationAdvanced
            activeTool={activeTool}
            imageDraft={imageDraft}
            videoDraft={videoDraft}
            motionDraft={motionDraft}
            onChange={replaceDraft}
            onVideoChange={setVideoDraft}
            onUploadVideo={() => uploadReferenceVideo('video')}
            onUploadAudio={uploadReferenceAudio}
            onRemoveReferenceVideo={(id) => setVideoDraft((draft) => ({ ...draft, referenceVideos: draft.referenceVideos.filter((media) => media.id !== id) }))}
            onRemoveReferenceAudio={(id) => setVideoDraft((draft) => ({ ...draft, referenceAudios: draft.referenceAudios.filter((media) => media.id !== id) }))}
            isUploading={isUploading}
          />
        </DisclosureSection>

        <SurfaceSection
          eyebrow="Ready check"
          title="Generate"
          body="Review cost and blockers before starting the run."
          accent={meta.accent}
        >
          {readiness.map((item) => (
            <ReadinessRow key={item.id} label={item.label} body={item.body} state={item.state} />
          ))}
          <ValidationPanel validation={validation} message={message} />
          <PrimaryButton
            label={isGenerating ? 'Generating...' : `Generate ${meta.title}`}
            accent={meta.accent}
            disabled={isGenerating || isUploading || validation.errors.length > 0}
            loading={isGenerating}
            onPress={generate}
          />
        </SurfaceSection>

        {status && status.status !== 'succeeded' ? (
          <SurfaceSection
            eyebrow="Progress"
            title={`Generation ${status.status}`}
            body="You can leave this screen and watch Alerts if it takes longer."
            accent={meta.accent}
          />
        ) : null}

        {outputUrl ? (
          <ResultPanel
            outputUrl={outputUrl}
            kind={activeTool === 'image' ? 'image' : 'video'}
            generationId={lastGenerationId}
            accent={meta.accent}
            onPost={() => {
              if (!lastGenerationId) return;
              router.push({
                pathname: '/post/new',
                params: { generationId: lastGenerationId },
              } as never);
            }}
            onOpenAlerts={() => router.push('/(tabs)/studio')}
            onCreateAnother={() => {
              setStatus(null);
              setLastGenerationId(null);
              setMessage(null);
            }}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function ToolSwitcher({ value, onChange }: { value: CreatorToolId; onChange: (tool: CreatorToolId) => void }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: appTheme.colors.surfaceInset, borderRadius: appTheme.radii.pill, padding: 4, gap: 4 }}>
      {(['image', 'video', 'motion'] as const).map((tool) => {
        const active = value === tool;
        const meta = TOOL_META[tool];
        return (
          <ChoiceChip
            key={tool}
            label={meta.title}
            active={active}
            onPress={() => onChange(tool)}
            accent={meta.accent}
            grow
          />
        );
      })}
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
    <SurfaceSection
      eyebrow="Prompt"
      title="Prompt"
      body={draft.tool === 'video' && draft.isMultiShot ? 'Shot prompts below drive multi-shot mode.' : 'Use @handles after adding named references.'}
      accent={draft.tool === 'image' ? 'image' : draft.tool === 'video' ? 'video' : 'motion'}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="label" color="muted">{optional ? 'Optional for motion' : 'Required'}</AppText>
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
    </SurfaceSection>
  );
}

function CreationEssentials({
  activeTool,
  imageDraft,
  videoDraft,
  motionDraft,
  onChange,
}: {
  activeTool: CreatorToolId;
  imageDraft: ImageCreationDraft;
  videoDraft: VideoCreationDraft;
  motionDraft: MotionCreationDraft;
  onChange: (draft: CreationDraft) => void;
}) {
  if (activeTool === 'image') {
    const model = IMAGE_MODELS[imageDraft.model];
    const resolutionOptions = getImageResolutionOptions(imageDraft.model, imageDraft.aspectRatio);
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        <SectionLabel title="Model" icon={<ImageIcon size={17} color={accentColor('image')} />} />
        <ModelPicker
          items={Object.values(IMAGE_MODELS)}
          value={imageDraft.model}
          accent="image"
          onChange={(modelId) => onChange({ ...imageDraft, model: modelId as ImageModelId })}
        />
        <OptionRow title="Aspect ratio">
          {model.aspectRatios.map((ratio) => (
            <Chip key={ratio} label={ratio} active={imageDraft.aspectRatio === ratio} onPress={() => onChange({ ...imageDraft, aspectRatio: ratio })} />
          ))}
        </OptionRow>
        <OptionRow title="Resolution">
          {resolutionOptions.map((resolution) => (
            <Chip key={resolution} label={resolution} active={imageDraft.resolution === resolution} onPress={() => onChange({ ...imageDraft, resolution })} />
          ))}
        </OptionRow>
      </View>
    );
  }

  if (activeTool === 'video') {
    const model = VIDEO_MODELS[videoDraft.model];
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        <SectionLabel title="Model" icon={<Video size={17} color={accentColor('video')} />} />
        <ModelPicker
          items={Object.values(VIDEO_MODELS)}
          value={videoDraft.model}
          accent="video"
          onChange={(modelId) => {
            const nextModel = modelId as VideoModelId;
            onChange({
              ...videoDraft,
              model: nextModel,
              mode: defaultVideoMode(nextModel),
              duration: getDefaultVideoDuration(nextModel),
            });
          }}
        />
        <OptionRow title="Aspect ratio">
          {model.aspectRatios.map((ratio) => (
            <Chip key={ratio} label={ratio} active={videoDraft.aspectRatio === ratio} onPress={() => onChange({ ...videoDraft, aspectRatio: ratio })} />
          ))}
        </OptionRow>
        {model.resolutions.length > 0 ? (
          <OptionRow title="Resolution">
            {model.resolutions.map((resolution) => (
              <Chip key={resolution} label={resolution} active={videoDraft.resolution === resolution} onPress={() => onChange({ ...videoDraft, resolution })} />
            ))}
          </OptionRow>
        ) : null}
        {model.provider !== 'veo' && !videoDraft.isMultiShot ? (
          <OptionRow title="Duration">
            {model.durations.map((duration) => (
              <Chip key={duration} label={`${duration}s`} active={videoDraft.duration === duration} onPress={() => onChange({ ...videoDraft, duration })} />
            ))}
          </OptionRow>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <SectionLabel title="Model" icon={<Sparkles size={17} color={accentColor('motion')} />} />
      <ModelPicker
        items={Object.values(MOTION_MODELS)}
        value={motionDraft.model}
        accent="motion"
        onChange={(modelId) => onChange({ ...motionDraft, model: modelId as MotionModelId })}
      />
    </View>
  );
}

function CreationReferences({
  activeTool,
  imageDraft,
  videoDraft,
  motionDraft,
  onImageChange,
  onVideoChange,
  onMotionChange,
  onUploadImageReferences,
  onUploadVideoReferences,
  onUploadStart,
  onUploadEnd,
  onUploadCharacter,
  onUploadMotionReference,
  onUseImageHandle,
  onUseVideoHandle,
  isUploading,
}: {
  activeTool: CreatorToolId;
  imageDraft: ImageCreationDraft;
  videoDraft: VideoCreationDraft;
  motionDraft: MotionCreationDraft;
  onImageChange: (updater: (draft: ImageCreationDraft) => ImageCreationDraft) => void;
  onVideoChange: (updater: (draft: VideoCreationDraft) => VideoCreationDraft) => void;
  onMotionChange: (updater: (draft: MotionCreationDraft) => MotionCreationDraft) => void;
  onUploadImageReferences: () => void;
  onUploadVideoReferences: () => void;
  onUploadStart: () => void;
  onUploadEnd: () => void;
  onUploadCharacter: () => void;
  onUploadMotionReference: () => void;
  onUseImageHandle: (handle: string) => void;
  onUseVideoHandle: (handle: string) => void;
  isUploading: boolean;
}) {
  if (activeTool === 'image') {
    const model = IMAGE_MODELS[imageDraft.model];
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        <UploadBlock
          title={`Reference images (${imageDraft.references.length}/${model.maxImages})`}
          actionLabel="Add images"
          onPress={onUploadImageReferences}
          disabled={isUploading}
        />
        <MediaList
          items={imageDraft.references}
          onRemove={(id) => onImageChange((draft) => ({ ...draft, references: draft.references.filter((media) => media.id !== id) }))}
          onUseHandle={onUseImageHandle}
        />
      </View>
    );
  }

  if (activeTool === 'video') {
    const elementSupport = getVideoElementSupport(videoDraft.model, { mode: videoDraft.mode, isMultiShot: videoDraft.isMultiShot });
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        <OptionRow title="Reference mode">
          <Chip label="Frames" active={videoDraft.referenceMode === 'frames'} onPress={() => onVideoChange((draft) => ({ ...draft, referenceMode: 'frames' }))} />
          <Chip label="Elements" active={videoDraft.referenceMode === 'elements'} onPress={() => onVideoChange((draft) => ({ ...draft, referenceMode: 'elements' }))} />
        </OptionRow>
        {videoDraft.referenceMode === 'frames' ? (
          <View style={{ gap: 10 }}>
            <UploadBlock title="Start frame" actionLabel={videoDraft.startFrame ? 'Replace start' : 'Add start'} onPress={onUploadStart} disabled={isUploading} />
            {videoDraft.startFrame ? <MediaList items={[videoDraft.startFrame]} onRemove={() => onVideoChange((draft) => ({ ...draft, startFrame: null }))} /> : null}
            <UploadBlock title="End frame" actionLabel={videoDraft.endFrame ? 'Replace end' : 'Add end'} onPress={onUploadEnd} disabled={isUploading || videoDraft.isMultiShot} />
            {videoDraft.endFrame ? <MediaList items={[videoDraft.endFrame]} onRemove={() => onVideoChange((draft) => ({ ...draft, endFrame: null }))} /> : null}
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <UploadBlock
              title={`Named image elements (${videoDraft.references.length}/${elementSupport.maxElements})`}
              actionLabel={elementSupport.enabled ? 'Add elements' : 'Unavailable'}
              onPress={onUploadVideoReferences}
              disabled={isUploading || !elementSupport.enabled}
            />
            {elementSupport.reason ? <AppText variant="bodySm" color="muted">{elementSupport.reason}</AppText> : null}
            <MediaList
              items={videoDraft.references}
              onRemove={(id) => onVideoChange((draft) => ({ ...draft, references: draft.references.filter((media) => media.id !== id) }))}
              onUseHandle={onUseVideoHandle}
            />
          </View>
        )}
      </View>
    );
  }

  const duration = getMotionDuration(motionDraft);
  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <UploadBlock title="Character image" actionLabel={motionDraft.characterImage ? 'Replace image' : 'Add image'} onPress={onUploadCharacter} disabled={isUploading} />
      {motionDraft.characterImage ? <MediaList items={[motionDraft.characterImage]} onRemove={() => onMotionChange((draft) => ({ ...draft, characterImage: null }))} /> : null}
      <UploadBlock title={`Reference motion video${duration ? ` • ${duration}s` : ''}`} actionLabel={motionDraft.referenceVideo ? 'Replace video' : 'Add video'} onPress={onUploadMotionReference} disabled={isUploading} />
      {motionDraft.referenceVideo ? <MediaList items={[motionDraft.referenceVideo]} onRemove={() => onMotionChange((draft) => ({ ...draft, referenceVideo: null }))} /> : null}
    </View>
  );
}

function CreationAdvanced({
  activeTool,
  imageDraft,
  videoDraft,
  motionDraft,
  onChange,
  onVideoChange,
  onUploadVideo,
  onUploadAudio,
  onRemoveReferenceVideo,
  onRemoveReferenceAudio,
  isUploading,
}: {
  activeTool: CreatorToolId;
  imageDraft: ImageCreationDraft;
  videoDraft: VideoCreationDraft;
  motionDraft: MotionCreationDraft;
  onChange: (draft: CreationDraft) => void;
  onVideoChange: (updater: (draft: VideoCreationDraft) => VideoCreationDraft) => void;
  onUploadVideo: () => void;
  onUploadAudio: () => void;
  onRemoveReferenceVideo: (id: string) => void;
  onRemoveReferenceAudio: (id: string) => void;
  isUploading: boolean;
}) {
  if (activeTool === 'image') {
    const model = IMAGE_MODELS[imageDraft.model];
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        {model.supportsOutputFormat ? (
          <OptionRow title="Output format">
            {model.outputFormats.map((format) => (
              <Chip key={format} label={format.toUpperCase()} active={imageDraft.outputFormat === format} onPress={() => onChange({ ...imageDraft, outputFormat: format })} />
            ))}
          </OptionRow>
        ) : null}
        {imageDraft.model === 'grok-imagine-image' ? (
          <OptionRow title="Quality">
            <Chip label="Standard" active={imageDraft.qualityMode === 'standard'} onPress={() => onChange({ ...imageDraft, qualityMode: 'standard' })} />
            <Chip label="Quality" active={imageDraft.qualityMode === 'quality'} onPress={() => onChange({ ...imageDraft, qualityMode: 'quality' })} />
          </OptionRow>
        ) : null}
        {model.supportsGoogleSearch ? (
          <ToggleRow title="Google Search" value={imageDraft.googleSearch} onValueChange={(googleSearch) => onChange({ ...imageDraft, googleSearch })} />
        ) : null}
      </View>
    );
  }

  if (activeTool === 'video') {
    const model = VIDEO_MODELS[videoDraft.model];
    return (
      <View style={{ gap: appTheme.spacing.gap }}>
        {model.supportsMultiShot ? (
          <ToggleRow title="Multi-shot" value={videoDraft.isMultiShot} onValueChange={(isMultiShot) => onChange({ ...videoDraft, isMultiShot })} />
        ) : null}
        {videoDraft.isMultiShot ? <ShotEditor draft={videoDraft} onChange={(draft) => onChange(draft)} /> : null}
        {model.modeOptions.length > 0 ? (
          <OptionRow title="Mode">
            {model.modeOptions.map((option) => (
              <Chip key={option.value} label={option.label} active={videoDraft.mode === option.value} onPress={() => onChange({ ...videoDraft, mode: option.value })} />
            ))}
          </OptionRow>
        ) : null}
        {model.supportsSound ? <ToggleRow title="Generate sound" value={videoDraft.sound} onValueChange={(sound) => onChange({ ...videoDraft, sound })} /> : null}
        {model.supportsFixedLens ? <ToggleRow title="Fixed lens" value={videoDraft.fixedLens} onValueChange={(fixedLens) => onChange({ ...videoDraft, fixedLens })} /> : null}
        {isSeedance2Family(videoDraft.model) ? (
          <View style={{ gap: 10 }}>
            <UploadBlock title={`Reference videos (${videoDraft.referenceVideos.length}/3)`} actionLabel="Add video" onPress={onUploadVideo} disabled={isUploading} />
            <MediaList items={videoDraft.referenceVideos} onRemove={onRemoveReferenceVideo} />
            <UploadBlock title="Reference audio" actionLabel="Add audio" onPress={onUploadAudio} disabled={isUploading} />
            <MediaList items={videoDraft.referenceAudios} onRemove={onRemoveReferenceAudio} />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: appTheme.spacing.gap }}>
      <OptionRow title="Resolution">
        {MOTION_MODELS[motionDraft.model].resolutions.map((resolution) => (
          <Chip key={resolution} label={resolution} active={motionDraft.mode === resolution} onPress={() => onChange({ ...motionDraft, mode: resolution })} />
        ))}
      </OptionRow>
      <OptionRow title="Orientation">
        <Chip label="Video" active={motionDraft.characterOrientation === 'video'} onPress={() => onChange({ ...motionDraft, characterOrientation: 'video' })} />
        <Chip label="Image" active={motionDraft.characterOrientation === 'image'} onPress={() => onChange({ ...motionDraft, characterOrientation: 'image' })} />
      </OptionRow>
    </View>
  );
}

function ResultPanel({
  outputUrl,
  kind,
  generationId,
  accent,
  onPost,
  onOpenAlerts,
  onCreateAnother,
}: {
  outputUrl: string;
  kind: 'image' | 'video';
  generationId: string | null;
  accent: ToolAccent;
  onPost: () => void;
  onOpenAlerts: () => void;
  onCreateAnother: () => void;
}) {
  return (
    <SurfaceSection
      eyebrow="Result"
      title="Your generation is ready"
      body="Continue into post setup to choose caption, visibility, references, and optional resources."
      accent={accent}
    >
      <MediaPreview url={outputUrl} kind={kind} />
      <View style={{ gap: appTheme.spacing.gap }}>
        {generationId ? (
          <>
            <ReadinessRow
              label="Post setup next"
              body="Post this opens the composer first. Nothing publishes until you review the post."
              state="ready"
            />
            <PrimaryButton label="Post this" onPress={onPost} accent="workflow" />
          </>
        ) : null}
        <View style={{ flexDirection: 'row', gap: appTheme.spacing.gap }}>
          <View style={{ flex: 1 }}>
            <SecondaryButton label="Open Alerts" onPress={onOpenAlerts} />
          </View>
          <View style={{ flex: 1 }}>
            <SecondaryButton label="Create another" onPress={onCreateAnother} />
          </View>
        </View>
      </View>
    </SurfaceSection>
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
    <ChoiceChip
      label={label}
      active={active}
      onPress={onPress}
      accent="motion"
      compact
    />
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
    <SurfaceSection
      eyebrow="Needs attention"
      title="Generation checks"
      accent="danger"
    >
      {message ? <Text selectable style={{ color: appTheme.colors.danger, fontWeight: '900', lineHeight: 20 }}>{message}</Text> : null}
      {validation.errors.map((error) => (
        <Text selectable key={error} style={{ color: appTheme.colors.danger, lineHeight: 20 }}>{error}</Text>
      ))}
      {validation.warnings.map((warning) => (
        <Text selectable key={`${warning.code}-${warning.message}`} style={{ color: warning.severity === 'blocking' ? appTheme.colors.danger : appTheme.colors.amber, lineHeight: 20 }}>
          {warning.message}
        </Text>
      ))}
    </SurfaceSection>
  );
}
