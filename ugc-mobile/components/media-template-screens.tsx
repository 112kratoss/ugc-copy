import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, Stack } from 'expo-router';
import {
  ArrowRight,
  Check,
  CircleDollarSign,
  CircleUserRound,
  Download,
  Image as ImageIcon,
  Play,
  RefreshCw,
  ShieldCheck,
  Upload,
  Video,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Pressable,
  Share,
  View,
} from 'react-native';

import { MediaPreview } from '@/components/media-preview';
import {
  AppText,
  Card,
  Kicker,
  Pill,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionHeader,
  StatusBlock,
} from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import {
  hasAllTemplateInputs,
  canAffordTemplateCredits,
  canPublishTemplateRunResult,
  canRetryTemplateRunStep,
  createTemplateRunIdempotencyKey,
  isSafeTemplateResultUrl,
  isTemplateRunPolling,
  isTemplateRunStepAwaitingApproval,
  isTemplateRunStepFailed,
  isTemplateRunStepSuccessful,
  isTemplateRunTerminal,
  prioritizeTemplateRunSteps,
  templateRunStepNeedsReplacementInput,
  templateRunProgress,
  templateRunStageLabel,
  totalTemplateEstimate,
} from '@/lib/media-templates';
import { pickMedia, uploadTemplateRunInput } from '@/lib/media';
import {
  clearActiveTemplateRun,
  loadActiveTemplateRunId,
  rememberActiveTemplateRun,
} from '@/lib/template-run-resume';
import { appTheme } from '@/lib/theme';
import type {
  MediaTemplateDetail,
  MediaTemplateInputSlot,
  MediaTemplateSummary,
  TemplateRun,
  TemplateRunResponse,
  TemplateRunStep,
} from '@/lib/types';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function creatorName(template: Pick<MediaTemplateSummary, 'creator'>) {
  return template.creator?.displayName || template.creator?.username || 'Magicbooklet creator';
}

function creditLabel(value: number | null) {
  return typeof value === 'number' ? `${value} credits` : 'Shown before generation';
}

function inputSummary(template: Pick<MediaTemplateSummary, 'inputSlots'>) {
  const images = template.inputSlots.filter((slot) => slot.kind === 'image').length;
  const videos = template.inputSlots.length - images;
  return [
    images ? `${images} image${images === 1 ? '' : 's'}` : '',
    videos ? `${videos} video${videos === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' + ') || 'No uploads';
}

export function MediaTemplateCatalogScreen() {
  const { api, user } = useAuth();
  const templatesQuery = useQuery({
    queryKey: ['media-templates'],
    queryFn: () => api.listMediaTemplates(),
  });
  const templates = templatesQuery.data?.templates ?? [];
  const activeRunQuery = useQuery({
    queryKey: ['active-media-template-run', user?.id],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const userId = user?.id;
      if (!userId) return null;
      const runId = await loadActiveTemplateRunId(userId);
      if (!runId) return null;
      try {
        const { run } = await api.getTemplateRun(runId);
        if (isTemplateRunTerminal(run.status)) {
          await clearActiveTemplateRun(userId, run.id);
          return null;
        }
        return run;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          await clearActiveTemplateRun(userId, runId);
          return null;
        }
        throw error;
      }
    },
  });
  const activeRun = activeRunQuery.data;

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Templates' }} />
      <SectionHeader
        eyebrow="Create faster"
        title="Workflow templates"
        body="Choose a format, add its required media, and review each generated step on the way to your result."
      />

      {activeRun ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Resume ${activeRun.templateTitle}`}
          accessibilityHint="Returns to your unfinished template creation"
          onPress={() => router.push(`/template-runs/${encodeURIComponent(activeRun.id)}` as never)}
          style={({ pressed }) => ({
            minHeight: 82,
            borderRadius: appTheme.radii.xl,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: 'rgba(255,122,89,0.4)',
            backgroundColor: appTheme.colors.surfaceInset,
            padding: 15,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            opacity: pressed ? 0.82 : 1,
          })}
        >
          <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: appTheme.colors.pressed }}>
            <RefreshCw size={20} color={appTheme.colors.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <AppText variant="label">Resume creation</AppText>
            <AppText variant="caption" color="muted" numberOfLines={1}>
              {templateRunStageLabel(activeRun)} · {activeRun.templateTitle}
            </AppText>
          </View>
          <ArrowRight size={20} color={appTheme.colors.primary} />
        </Pressable>
      ) : null}

      {templatesQuery.isLoading ? (
        <LoadingState label="Loading templates" />
      ) : templatesQuery.isError ? (
        <View style={{ gap: 12 }}>
          <StatusBlock title="Templates are unavailable" body={errorMessage(templatesQuery.error, 'Check your connection and try again.')} tone="danger" />
          <SecondaryButton label="Try again" onPress={() => void templatesQuery.refetch()} />
        </View>
      ) : templates.length === 0 ? (
        <StatusBlock title="No templates yet" body="Published creator templates will appear here." tone="neutral" />
      ) : (
        <View style={{ gap: 22 }}>
          {templates.map((template) => <TemplatePoster key={template.id} template={template} />)}
        </View>
      )}
    </Screen>
  );
}

function TemplatePoster({ template }: { template: MediaTemplateSummary }) {
  const OutputIcon = template.outputKind === 'video' ? Video : ImageIcon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${template.name}. Use template by ${creatorName(template)}`}
      accessibilityHint="Opens template details"
      onPress={() => router.push(`/templates/${encodeURIComponent(template.slug)}` as never)}
      style={({ pressed }) => ({ gap: 11, opacity: pressed ? 0.82 : 1 })}
    >
      <View style={{ minHeight: 280, aspectRatio: 4 / 5, overflow: 'hidden', borderRadius: appTheme.radii.xl, borderCurve: 'continuous', backgroundColor: appTheme.colors.surfaceInset }}>
        {template.thumbnailUrl ? (
          <Image source={{ uri: template.thumbnailUrl }} contentFit="cover" transition={160} style={{ position: 'absolute', inset: 0 }} />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <OutputIcon size={42} color={appTheme.colors.faint} />
          </View>
        )}
        <LinearGradient
          colors={['rgba(8,8,10,0.03)', 'rgba(8,8,10,0.18)', 'rgba(8,8,10,0.94)']}
          locations={[0.35, 0.58, 1]}
          style={{ position: 'absolute', inset: 0, justifyContent: 'flex-end', padding: 18, gap: 6 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.14)' }}>
              <Play size={16} fill={appTheme.colors.text} color={appTheme.colors.text} />
            </View>
            <Kicker color={appTheme.colors.primary}>{template.outputKind} template</Kicker>
          </View>
          <AppText variant="sectionTitle" numberOfLines={2}>{template.name}</AppText>
          <AppText variant="caption" color={appTheme.colors.textSecondary} numberOfLines={1}>by {creatorName(template)}</AppText>
        </LinearGradient>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText variant="bodySm" color="muted" style={{ flex: 1 }}>
          {inputSummary(template)}
          {template.estimatedTotalCredits === null ? '' : ` · about ${template.estimatedTotalCredits} credits`}
        </AppText>
        <ArrowRight size={20} color={appTheme.colors.primary} />
      </View>
    </Pressable>
  );
}

export function MediaTemplateDetailScreen({ slug }: { slug: string }) {
  const { api, user } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const createRunKeyRef = useRef<string | null>(null);
  const templateQuery = useQuery({
    queryKey: ['media-template', slug],
    enabled: Boolean(slug),
    queryFn: () => api.getMediaTemplate(slug),
  });
  const createRun = useMutation({
    mutationFn: (templateId: string) => {
      createRunKeyRef.current ??= createTemplateRunIdempotencyKey();
      return api.createMediaTemplateRun(templateId, createRunKeyRef.current);
    },
    onSuccess: ({ run }) => {
      createRunKeyRef.current = null;
      if (user?.id) void rememberActiveTemplateRun(user.id, run.id);
      router.push(`/template-runs/${encodeURIComponent(run.id)}` as never);
    },
    onError: (error) => setMessage(errorMessage(error, 'Could not start this template.')),
  });
  const template = templateQuery.data?.template;

  const useTemplate = () => {
    if (!template) return;
    if (!user) {
      router.push({ pathname: '/auth', params: { returnTo: `/templates/${encodeURIComponent(slug)}` } } as never);
      return;
    }
    setMessage(null);
    createRun.mutate(template.id);
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: template?.name ?? 'Template' }} />
      {templateQuery.isLoading ? (
        <LoadingState label="Loading template" />
      ) : templateQuery.isError || !template ? (
        <View style={{ gap: 12 }}>
          <StatusBlock title="Template unavailable" body={errorMessage(templateQuery.error, 'This template may have been removed.')} tone="danger" />
          <SecondaryButton label="Try again" onPress={() => void templateQuery.refetch()} />
        </View>
      ) : (
        <TemplateDetailContent template={template} message={message} starting={createRun.isPending} onUse={useTemplate} />
      )}
    </Screen>
  );
}

function TemplateDetailContent({
  template,
  message,
  starting,
  onUse,
}: {
  template: MediaTemplateDetail;
  message: string | null;
  starting: boolean;
  onUse: () => void;
}) {
  return (
    <>
      <View style={{ gap: 8 }}>
        <Kicker color={appTheme.colors.primary}>{template.category}</Kicker>
        <AppText variant="pageTitle">{template.name}</AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <CircleUserRound size={17} color={appTheme.colors.muted} />
          <AppText variant="bodySm" color="muted">by {creatorName(template)}</AppText>
          {template.useCount > 0 ? <AppText variant="caption" color="faint">· {template.useCount} uses</AppText> : null}
        </View>
      </View>

      <MediaPreview url={template.videoUrl ?? template.thumbnailUrl} kind={template.videoUrl ? 'video' : 'image'} height={430} />
      {template.description ? <AppText variant="body" color="textSecondary">{template.description}</AppText> : null}

      <View style={{ gap: 12 }}>
        <AppText variant="cardTitle">What you’ll add</AppText>
        {template.inputSlots.length ? template.inputSlots.map((slot, index) => {
          const SlotIcon = slot.kind === 'video' ? Video : ImageIcon;
          return (
            <View key={slot.key} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
              <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: appTheme.colors.pressed, alignItems: 'center', justifyContent: 'center' }}>
                <SlotIcon size={16} color={appTheme.colors.primary} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <AppText variant="label">{index + 1}. {slot.label}</AppText>
                {slot.description ? <AppText variant="caption" color="muted">{slot.description}</AppText> : null}
                <AppText variant="caption" color="faint">{slot.kind} · {slot.required ? 'Required' : 'Optional'}</AppText>
              </View>
            </View>
          );
        }) : <AppText variant="bodySm" color="muted">No uploads are required.</AppText>}
      </View>

      <Card variant="inset" padding="sm">
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ gap: 4, flex: 1 }}>
            <AppText variant="label">Estimated workflow total</AppText>
            <AppText variant="caption" color="muted">Retries show their own cost before confirmation.</AppText>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <CircleDollarSign size={20} color={appTheme.colors.primary} />
            <AppText variant="label">{creditLabel(totalTemplateEstimate(template))}</AppText>
          </View>
        </View>
      </Card>

      {message ? <StatusBlock title="Could not start" body={message} tone="danger" /> : null}
      <PrimaryButton label="Use this template" loading={starting} onPress={onUse} />
    </>
  );
}

export function MediaTemplateRunScreen({ runId }: { runId: string }) {
  const { api, user, credits, isLoading: isAuthLoading, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({});
  const previousRunStatusRef = useRef<TemplateRun['status'] | null>(null);
  const runQueryKey = useMemo(() => ['media-template-run', runId] as const, [runId]);
  const runQuery = useQuery({
    queryKey: runQueryKey,
    enabled: Boolean(runId && user),
    queryFn: () => api.getTemplateRun(runId),
    refetchInterval: (query) => isTemplateRunPolling(query.state.data?.run.status ?? 'needs_attention') ? 2500 : false,
  });
  const run = runQuery.data?.run;
  const templateQuery = useQuery({
    queryKey: ['media-template', run?.templateId],
    enabled: Boolean(run?.templateId),
    queryFn: () => api.getMediaTemplate(run?.templateId ?? ''),
  });
  const template = templateQuery.data?.template;

  useEffect(() => {
    if (!user?.id || !run) return;
    if (isTemplateRunTerminal(run.status)) void clearActiveTemplateRun(user.id, run.id);
    else void rememberActiveTemplateRun(user.id, run.id);
  }, [run, user?.id]);

  useEffect(() => {
    const nextStatus = run?.status ?? null;
    const previousStatus = previousRunStatusRef.current;
    previousRunStatusRef.current = nextStatus;
    if (previousStatus && isTemplateRunPolling(previousStatus) && nextStatus && !isTemplateRunPolling(nextStatus)) void refreshProfile();
  }, [refreshProfile, run?.status]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && runId && user) void runQuery.refetch();
    });
    return () => subscription.remove();
  }, [runId, user?.id]);

  const applyRun = (response: TemplateRunResponse) => {
    queryClient.setQueryData(runQueryKey, response);
    setMessage(null);
  };

  const startMutation = useMutation({
    mutationFn: () => api.startTemplateRun(runId),
    onSuccess: (response) => { applyRun(response); void refreshProfile(); },
    onError: (error) => setMessage(errorMessage(error, 'Could not start this workflow.')),
  });
  const retryMutation = useMutation({
    mutationFn: (stepId: string) => api.retryTemplateRunStep(runId, stepId),
    onSuccess: (response) => { applyRun(response); void refreshProfile(); },
    onError: (error) => setMessage(errorMessage(error, 'Could not retry this step.')),
  });
  const approvalMutation = useMutation({
    mutationFn: (stepId: string) => api.approveTemplateRunStep(runId, stepId),
    onSuccess: (response) => { applyRun(response); void refreshProfile(); },
    onError: (error) => setMessage(errorMessage(error, 'Could not approve this step.')),
  });
  const cancelMutation = useMutation({
    mutationFn: () => api.cancelTemplateRun(runId),
    onSuccess: applyRun,
    onError: (error) => setMessage(errorMessage(error, 'Could not cancel this creation.')),
  });

  const uploadSlot = async (slot: MediaTemplateInputSlot) => {
    const asset = await pickMedia(slot.kind);
    if (!asset) return;
    setUploadingSlot(slot.key);
    setMessage(null);
    setLocalPreviews((current) => ({ ...current, [slot.key]: asset.uri }));
    try {
      const response = await uploadTemplateRunInput(asset.uri, {
        api,
        runId,
        slotKey: slot.key,
        kind: slot.kind,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        sizeBytes: asset.fileSize,
      });
      applyRun(response);
    } catch (error) {
      setLocalPreviews((current) => {
        const next = { ...current };
        delete next[slot.key];
        return next;
      });
      setMessage(errorMessage(error, `Could not upload ${slot.label}.`));
    } finally {
      setUploadingSlot(null);
    }
  };

  if (isAuthLoading) {
    return <Screen><Stack.Screen options={{ title: 'Template creation' }} /><LoadingState label="Restoring your account" /></Screen>;
  }
  if (!user) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Template creation' }} />
        <StatusBlock title="Sign in to continue" body="Your template run is saved to your account." tone="neutral" />
        <PrimaryButton label="Sign in" onPress={() => router.replace({ pathname: '/auth', params: { returnTo: `/template-runs/${encodeURIComponent(runId)}` } } as never)} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: template?.name ?? run?.templateTitle ?? 'Template creation' }} />
      {runQuery.isLoading ? (
        <LoadingState label="Restoring your creation" />
      ) : runQuery.isError || !run ? (
        <View style={{ gap: 12 }}>
          <StatusBlock title="Could not restore this creation" body={errorMessage(runQuery.error, 'Check your connection and try again.')} tone="danger" />
          <SecondaryButton label="Try again" onPress={() => void runQuery.refetch()} />
        </View>
      ) : (
        <>
          <RunHeader run={run} template={template} />
          {run.status === 'collecting_inputs' ? (
            <InputStage
              run={run}
              previews={localPreviews}
              uploadingSlot={uploadingSlot}
              onUpload={(slot) => void uploadSlot(slot)}
              onStart={() => startMutation.mutate()}
              starting={startMutation.isPending}
              credits={credits}
              estimatedTotalCredits={run.estimatedTotalCredits ?? template?.estimatedTotalCredits ?? null}
            />
          ) : run.result ? (
            <ResultStage run={run} api={api} userId={user.id} />
          ) : (
            <RunSteps
              run={run}
              credits={credits}
              busy={retryMutation.isPending || approvalMutation.isPending}
              retryingStepId={retryMutation.isPending ? retryMutation.variables ?? null : null}
              approvingStepId={approvalMutation.isPending ? approvalMutation.variables ?? null : null}
              restartTemplateId={template?.slug ?? run.templateId}
              onRetry={(stepId) => retryMutation.mutate(stepId)}
              onApprove={(stepId) => approvalMutation.mutate(stepId)}
            />
          )}

          {run.status === 'failed' && !run.result ? (
            <View style={{ gap: 10 }}>
              <StatusBlock title="Creation failed" body={run.errorMessage ?? 'This run has ended. Start again from the template when you’re ready.'} tone="danger" />
              <SecondaryButton
                label="Start a new run"
                onPress={() => router.push(`/templates/${encodeURIComponent(template?.slug ?? run.templateId)}` as never)}
              />
            </View>
          ) : null}
          {run.status === 'cancelled' && !run.result ? (
            <View style={{ gap: 10 }}>
              <StatusBlock title="Creation cancelled" body="This run is closed. Start again from the template when you’re ready." tone="neutral" />
              <SecondaryButton
                label="Return to template"
                onPress={() => router.push(`/templates/${encodeURIComponent(template?.slug ?? run.templateId)}` as never)}
              />
            </View>
          ) : null}
          {message ? <StatusBlock title="Action needed" body={message} tone="danger" /> : null}
          {!isTemplateRunTerminal(run.status) ? (
            <SecondaryButton
              label="Cancel creation"
              disabled={cancelMutation.isPending}
              onPress={() => Alert.alert('Cancel this creation?', 'Completed steps remain in your creation history.', [
                { text: 'Keep creating', style: 'cancel' },
                { text: 'Cancel creation', style: 'destructive', onPress: () => cancelMutation.mutate() },
              ])}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function RunHeader({ run, template }: { run: TemplateRun; template?: MediaTemplateSummary }) {
  const progress = templateRunProgress(run);
  const activeLabel = prioritizeTemplateRunSteps(run.steps)
    .find((step) => !isTemplateRunStepSuccessful(step))?.label;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 5 }}>
        <Kicker color={appTheme.colors.primary}>{progress.complete} of {progress.total} complete</Kicker>
        <AppText variant="pageTitle">{templateRunStageLabel(run)}</AppText>
        <AppText variant="bodySm" color="muted">{activeLabel ?? template?.name ?? run.templateTitle}</AppText>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Template progress"
        accessibilityValue={{ min: 0, max: progress.total, now: progress.complete }}
        style={{ flexDirection: 'row', gap: 6 }}
      >
        {Array.from({ length: Math.max(progress.total, 1) }, (_, index) => (
          <View key={index} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: index < progress.complete ? appTheme.colors.success : index === progress.complete ? appTheme.colors.primary : appTheme.colors.borderStrong }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {run.creditsUsed > 0 ? <Pill label={`${run.creditsUsed} used`} /> : null}
        {run.estimatedRemainingCredits !== null && !isTemplateRunTerminal(run.status) ? <Pill label={`~${run.estimatedRemainingCredits} remaining`} accent="amber" /> : null}
      </View>
    </View>
  );
}

function InputStage({
  run,
  previews,
  uploadingSlot,
  onUpload,
  onStart,
  starting,
  credits,
  estimatedTotalCredits,
}: {
  run: TemplateRun;
  previews: Record<string, string>;
  uploadingSlot: string | null;
  onUpload: (slot: MediaTemplateInputSlot) => void;
  onStart: () => void;
  starting: boolean;
  credits: number | null;
  estimatedTotalCredits: number | null;
}) {
  const uploadedBySlot = new Map(run.inputs.map((input) => [input.slotKey, input]));
  const ready = hasAllTemplateInputs(run);
  const canAfford = canAffordTemplateCredits(credits, estimatedTotalCredits);
  const startLabel = estimatedTotalCredits === null
    ? 'Start workflow'
    : `Start workflow · ~${estimatedTotalCredits} credits`;
  return (
    <View style={{ gap: 18 }}>
      {run.inputSlots.length ? run.inputSlots.map((slot) => {
        const input = uploadedBySlot.get(slot.key);
        const preview = previews[slot.key] ?? input?.previewUrl ?? null;
        const uploaded = Boolean(input && input.status !== 'missing');
        const SlotIcon = slot.kind === 'video' ? Video : ImageIcon;
        return (
          <View key={slot.key} style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <View style={{ flex: 1, gap: 3 }}>
                <AppText variant="cardTitle">{slot.label}</AppText>
                {slot.description ? <AppText variant="caption" color="muted">{slot.description}</AppText> : null}
              </View>
              {uploaded ? <Pill label="Uploaded" accent="workflow" /> : <Pill label={slot.required ? 'Required' : 'Optional'} />}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${uploaded ? 'Replace' : 'Upload'} ${slot.label}`}
              disabled={uploadingSlot !== null}
              onPress={() => onUpload(slot)}
              style={({ pressed }) => ({
                minHeight: 210,
                overflow: 'hidden',
                borderRadius: appTheme.radii.xl,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderStyle: preview ? 'solid' : 'dashed',
                borderColor: uploaded ? appTheme.colors.success : appTheme.colors.borderStrong,
                backgroundColor: appTheme.colors.surfaceInset,
                opacity: pressed ? 0.82 : 1,
                alignItems: 'center',
                justifyContent: 'center',
              })}
            >
              {preview ? <MediaPreview url={preview} kind={slot.kind} height={210} /> : <SlotIcon size={34} color={appTheme.colors.faint} />}
              <View style={{ position: preview ? 'absolute' : 'relative', bottom: preview ? 14 : undefined, minWidth: 132, minHeight: 48, borderRadius: 24, paddingHorizontal: 16, backgroundColor: 'rgba(8,8,10,0.82)', flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
                {uploadingSlot === slot.key ? <ActivityIndicator color={appTheme.colors.primary} /> : <Upload size={18} color={appTheme.colors.primary} />}
                <AppText variant="label">{uploadingSlot === slot.key ? 'Uploading...' : uploaded ? `Replace ${slot.kind}` : `Choose ${slot.kind}`}</AppText>
              </View>
            </Pressable>
          </View>
        );
      }) : <StatusBlock title="No uploads needed" body="This template is ready to start with its saved workflow settings." tone="neutral" />}

      <Card variant="inset" padding="sm">
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ gap: 2 }}>
            <AppText variant="label">Estimated workflow total</AppText>
            <AppText variant="caption" color="muted">{creditLabel(estimatedTotalCredits)}</AppText>
          </View>
          <AppText variant="caption" color="muted">{credits === null ? 'Balance loading…' : `${credits} available`}</AppText>
        </View>
      </Card>
      {!canAfford ? (
        <View style={{ gap: 10 }}>
          <StatusBlock
            title="More credits needed"
            body={`This workflow is estimated at ${estimatedTotalCredits} credits, and your current balance is ${credits}.`}
            tone="neutral"
          />
          <SecondaryButton label="Get credits" onPress={() => router.push('/pricing' as never)} />
        </View>
      ) : null}
      <PrimaryButton
        label={startLabel}
        disabled={!ready || uploadingSlot !== null || !canAfford}
        loading={starting}
        onPress={onStart}
      />
    </View>
  );
}

function RunSteps({
  run,
  credits,
  busy,
  retryingStepId,
  approvingStepId,
  restartTemplateId,
  onRetry,
  onApprove,
}: {
  run: TemplateRun;
  credits: number | null;
  busy: boolean;
  retryingStepId: string | null;
  approvingStepId: string | null;
  restartTemplateId: string;
  onRetry: (stepId: string) => void;
  onApprove: (stepId: string) => void;
}) {
  if (run.steps.length === 0 && isTemplateRunPolling(run.status)) {
    return <LoadingState label="Preparing the first workflow step" />;
  }
  if (run.steps.length === 0 && run.status === 'needs_attention') {
    return (
      <View style={{ gap: 10 }}>
        <StatusBlock
          title="This run cannot continue"
          body={run.errorMessage ?? 'Return to the template and start again.'}
          tone="danger"
        />
        <SecondaryButton
          label="Return to template"
          onPress={() => router.push(`/templates/${encodeURIComponent(restartTemplateId)}` as never)}
        />
      </View>
    );
  }
  const orderedSteps = prioritizeTemplateRunSteps(run.steps);
  return (
    <View style={{ gap: 22 }}>
      {orderedSteps.map((step) => (
        <RunStepCard
          key={step.id}
          step={step}
          credits={credits}
          disabled={busy}
          retrying={retryingStepId === step.id}
          approving={approvingStepId === step.id}
          restartTemplateId={restartTemplateId}
          runStatus={run.status}
          onRetry={() => onRetry(step.id)}
          onApprove={() => onApprove(step.id)}
        />
      ))}
      {isTemplateRunPolling(run.status) ? (
        <AppText variant="bodySm" color="muted" style={{ textAlign: 'center' }}>
          This run keeps working if you leave. Resume it from Templates at any time.
        </AppText>
      ) : null}
    </View>
  );
}

function RunStepCard({
  step,
  credits,
  disabled,
  retrying,
  approving,
  restartTemplateId,
  runStatus,
  onRetry,
  onApprove,
}: {
  step: TemplateRunStep;
  credits: number | null;
  disabled: boolean;
  retrying: boolean;
  approving: boolean;
  restartTemplateId: string;
  runStatus: TemplateRun['status'];
  onRetry: () => void;
  onApprove: () => void;
}) {
  const successful = isTemplateRunStepSuccessful(step);
  const failed = isTemplateRunStepFailed(step);
  const awaitingApproval = isTemplateRunStepAwaitingApproval(step);
  const needsReplacementInput = templateRunStepNeedsReplacementInput(step);
  const serviceMisconfigured = failed && step.failureCode === 'service_misconfigured';
  const canRetry = canRetryTemplateRunStep(runStatus, step);
  const confirmRetry = () => {
    const cost = step.estimatedRetryCredits === null ? 'the current generation rate' : `${step.estimatedRetryCredits} credits`;
    const balance = credits === null ? '' : ` You currently have ${credits} credits.`;
    if (
      credits !== null
      && step.estimatedRetryCredits !== null
      && credits < step.estimatedRetryCredits
    ) {
      Alert.alert(
        'More credits needed',
        `This retry costs ${step.estimatedRetryCredits} credits and your balance is ${credits}.`,
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Get credits', onPress: () => router.push('/pricing' as never) },
        ],
      );
      return;
    }
    Alert.alert(`Retry ${step.label.toLowerCase()}?`, `This regenerates only this branch at ${cost}.${balance}`, [
      { text: 'Keep this result', style: 'cancel' },
      { text: 'Retry', onPress: onRetry },
    ]);
  };
  const statusLabel = successful ? (step.kind === 'approval' ? 'Approved' : 'Complete')
    : awaitingApproval ? 'Review'
      : failed ? 'Needs attention'
        : step.status.replaceAll('_', ' ');
  const statusAccent = successful ? 'workflow' : awaitingApproval || failed ? 'amber' : undefined;

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, flexDirection: 'row', gap: 9, alignItems: 'center' }}>
          {step.kind === 'approval' ? <ShieldCheck size={19} color={appTheme.colors.primary} /> : step.mediaKind === 'video' ? <Video size={19} color={appTheme.colors.video} /> : <ImageIcon size={19} color={appTheme.colors.image} />}
          <AppText variant="cardTitle">{step.label}</AppText>
        </View>
        <Pill label={statusLabel} accent={statusAccent} />
      </View>
      {step.outputUrl ? (
        <MediaPreview url={step.outputUrl} kind={step.mediaKind} height={step.mediaKind === 'video' ? 300 : 390} />
      ) : (
        <View style={{ minHeight: 220, borderRadius: appTheme.radii.xl, borderCurve: 'continuous', backgroundColor: appTheme.colors.surfaceInset, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          {failed ? <RefreshCw size={30} color={appTheme.colors.danger} /> : <ActivityIndicator size="large" color={appTheme.colors.primary} />}
          <AppText variant="bodySm" color="muted">
            {needsReplacementInput
              ? 'This upload needs to be replaced'
              : serviceMisconfigured
                ? 'Service setup must be completed first'
                : failed
                  ? 'This step can be retried'
                  : 'Waiting for output'}
          </AppText>
        </View>
      )}
      {step.errorMessage ? <AppText variant="caption" color="danger">{step.errorMessage}</AppText> : null}
      {needsReplacementInput ? (
        <StatusBlock
          title="A new upload is required"
          body="This file cannot be reused. Start a new run and choose a clear replacement."
          tone="neutral"
        />
      ) : null}
      {serviceMisconfigured ? (
        <StatusBlock
          title="Generation setup needs attention"
          body="Your uploads are safe. Retry after an administrator finishes the service setup."
          tone="neutral"
        />
      ) : null}
      {awaitingApproval ? <PrimaryButton label={approving ? 'Approving...' : 'Approve & continue'} loading={approving} disabled={disabled && !approving} onPress={onApprove} /> : null}
      {canRetry ? (
        <SecondaryButton
          label={retrying
            ? 'Retrying...'
            : serviceMisconfigured
              ? step.estimatedRetryCredits === null
                ? 'Retry after setup'
                : `Retry after setup · ${step.estimatedRetryCredits} credits`
              : step.estimatedRetryCredits === null
                ? 'Retry step'
                : `Retry · ${step.estimatedRetryCredits} credits`}
          disabled={disabled}
          onPress={confirmRetry}
        />
      ) : null}
      {needsReplacementInput ? (
        <SecondaryButton
          label="Start with new inputs"
          onPress={() => router.push(`/templates/${encodeURIComponent(restartTemplateId)}` as never)}
        />
      ) : null}
    </View>
  );
}

function ResultStage({
  run,
  api,
  userId,
}: {
  run: TemplateRun;
  api: ReturnType<typeof useAuth>['api'];
  userId: string;
}) {
  const queryClient = useQueryClient();
  const [startingAnother, setStartingAnother] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const createRunKeyRef = useRef<string | null>(null);
  const result = run.result;
  const canPublish = canPublishTemplateRunResult(run);
  const safeResultUrl = isSafeTemplateResultUrl(result?.url) ? result?.url ?? null : null;

  const createAnother = async () => {
    setStartingAnother(true);
    setMessage(null);
    try {
      createRunKeyRef.current ??= createTemplateRunIdempotencyKey();
      const response = await api.createMediaTemplateRun(run.templateId, createRunKeyRef.current);
      await rememberActiveTemplateRun(userId, response.run.id);
      queryClient.setQueryData(['media-template-run', response.run.id], response);
      createRunKeyRef.current = null;
      router.replace(`/template-runs/${encodeURIComponent(response.run.id)}` as never);
    } catch (error) {
      setMessage(errorMessage(error, 'Could not start another version.'));
    } finally {
      setStartingAnother(false);
    }
  };

  const openOriginal = async () => {
    if (!safeResultUrl) {
      setMessage('The full-quality file link is unavailable. Refresh this creation and try again.');
      return;
    }
    try {
      const supported = await Linking.canOpenURL(safeResultUrl);
      if (!supported) throw new Error('Unsupported result URL.');
      await Linking.openURL(safeResultUrl);
    } catch {
      setMessage('Could not open the full-quality file. Refresh this creation and try again.');
    }
  };

  const shareResult = async () => {
    if (!safeResultUrl) {
      setMessage('The share link is unavailable. Refresh this creation and try again.');
      return;
    }
    try {
      await Share.share({ message: safeResultUrl, url: safeResultUrl });
    } catch {
      setMessage('Could not open the share sheet. Please try again.');
    }
  };

  const publishResult = () => {
    const generationId = result?.generationId?.trim();
    if (!canPublish || !generationId) return;
    router.push({ pathname: '/post/new', params: { generationId } } as never);
  };

  if (!result) return null;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: appTheme.semantic.success.background, alignItems: 'center', justifyContent: 'center' }}>
          <Check size={18} color={appTheme.colors.success} />
        </View>
        <AppText variant="cardTitle">Final {result.kind}</AppText>
      </View>
      <MediaPreview url={result.url} kind={result.kind} height={440} />
      {!safeResultUrl ? (
        <StatusBlock
          title="Result link unavailable"
          body="Refresh this creation to request a new secure media link."
          tone="danger"
        />
      ) : null}
      {message ? <StatusBlock title="Could not continue" body={message} tone="danger" /> : null}
      {canPublish ? (
        <PrimaryButton label="Publish to Showcase" onPress={publishResult} />
      ) : (
        <PrimaryButton label={`Open full-quality ${result.kind}`} disabled={!safeResultUrl} onPress={() => void openOriginal()} />
      )}
      {canPublish ? (
        <SecondaryButton label={`Open full-quality ${result.kind}`} disabled={!safeResultUrl} onPress={() => void openOriginal()} />
      ) : null}
      <SecondaryButton label={`Share ${result.kind}`} disabled={!safeResultUrl} onPress={() => void shareResult()} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <Download size={15} color={appTheme.colors.muted} />
        <AppText variant="caption" color="muted">The original full-quality file opens outside the app.</AppText>
      </View>
      <SecondaryButton label={startingAnother ? 'Starting...' : 'Create another version'} disabled={startingAnother} onPress={() => void createAnother()} />
    </View>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <View accessibilityLiveRegion="polite" style={{ minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <ActivityIndicator size="large" color={appTheme.colors.primary} />
      <AppText variant="bodySm" color="muted">{label}</AppText>
    </View>
  );
}
