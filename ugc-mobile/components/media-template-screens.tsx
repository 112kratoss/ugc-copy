import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  ImageOff,
  Play,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Upload,
  Video,
  VideoOff,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, Pressable, Share, View } from 'react-native';

import { MediaPreview } from '@/components/media-preview';
import {
  AppText,
  Card,
  IconButton,
  Kicker,
  Pill,
  PrimaryButton,
  Screen,
  SecondaryButton,
  SectionHeader,
  StatusBlock,
} from '@/components/ui';
import { showConfirmDialog } from '@/lib/dialog';
import { withAiDataConsent } from '@/lib/ai-data-consent';
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
  isTemplateRunStepFailed,
  isTemplateRunStepStalled,
  isTemplateRunStepSuccessful,
  isTemplateRunTerminal,
  prioritizeTemplateRunSteps,
  templateRunActionErrorMessage,
  templateRunLinkedPost,
  templateRunStepNeedsNewRun,
  templateRunStepNeedsReplacementInput,
  templateRunStepOutcome,
  templateRunStepPlaceholderLabel,
  templateRunStepPlaceholderMark,
  templateRunStepStatusLabel,
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
import { env } from '@/lib/env';
import { isSignedMediaUrlExpiring, preserveStableTemplateRunMedia } from '@/lib/template-run-stable-media';
import { buildShareUrl } from '@/lib/viewer-actions';
import { CREDIT_BALANCE_LOADING_LABEL, formatCreditAmount } from '@/lib/pricing';
import { hexWithAlpha } from '@/lib/eased-fade';
import { appTheme, mediaColors, themes } from '@/lib/theme';
import { useAppTheme } from '@/lib/theme-context';
import { invalidateActiveGenerations } from '@/lib/active-generations';
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

/** A read of the run that replaces the one on screen, keeping the media addresses it already shows. */
function withStableRunMedia(previous: TemplateRunResponse | undefined, next: TemplateRunResponse): TemplateRunResponse {
  return { ...next, run: preserveStableTemplateRunMedia(previous?.run, next.run) };
}

// A run that is not there, or is another account's, reads the same way on every try.
function isMissingRunError(error: unknown) {
  return error instanceof ApiError && error.status === 404;
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
  const theme = useAppTheme();
  const { api, user } = useAuth();
  // Paged like the web catalog: the server stops at 48, and one request
  // could never show template 49 or later.
  const templatesQuery = useInfiniteQuery({
    queryKey: ['media-templates'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.listMediaTemplates(pageParam ? { cursor: pageParam } : undefined),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const templates = templatesQuery.data?.pages.flatMap((page) => page.templates) ?? [];
  const [failedPreviewAt, setFailedPreviewAt] = useState<number | null>(null);
  const hasFailedPreview = failedPreviewAt === templatesQuery.dataUpdatedAt;
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

      {hasFailedPreview ? (
        <View style={{ gap: 12 }}>
          <AppText variant="bodySm" color="muted">Some previews could not load. You can still open a template.</AppText>
          <SecondaryButton
            label={templatesQuery.isFetching ? 'Reloading previews…' : 'Reload previews'}
            disabled={templatesQuery.isFetching}
            onPress={() => void templatesQuery.refetch()}
          />
        </View>
      ) : null}
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
            borderColor: `${theme.colors.primary}66`,
            backgroundColor: theme.colors.surfaceInset,
            padding: 15,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            opacity: pressed ? appTheme.opacity.pressed : 1,
          })}
        >
          <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.pressed }}>
            <RefreshCw size={20} color={theme.colors.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <AppText variant="label">Resume creation</AppText>
            <AppText variant="caption" color="muted" numberOfLines={1}>
              {templateRunStageLabel(activeRun)} · {activeRun.templateTitle}
            </AppText>
          </View>
          <ArrowRight size={20} color={theme.colors.primary} />
        </Pressable>
      ) : null}

      {templatesQuery.isLoading ? (
        <LoadingState label="Loading templates" />
      ) : templatesQuery.isError && templates.length === 0 ? (
        <View style={{ gap: 12 }}>
          <StatusBlock title="Templates are unavailable" body={errorMessage(templatesQuery.error, 'Check your connection and try again.')} tone="danger" />
          <SecondaryButton label="Try again" onPress={() => void templatesQuery.refetch()} />
        </View>
      ) : templates.length === 0 ? (
        <StatusBlock title="No templates yet" body="Published creator templates will appear here." tone="neutral" />
      ) : (
        <View style={{ gap: 22 }}>
          {templates.map((template) => (
            <TemplatePoster
              key={template.id}
              template={template}
              previewAttempt={templatesQuery.dataUpdatedAt}
              onPreviewError={() => setFailedPreviewAt(templatesQuery.dataUpdatedAt)}
            />
          ))}
          {templatesQuery.hasNextPage ? (
            <SecondaryButton
              label={templatesQuery.isFetchingNextPage ? 'Loading more templates…' : templatesQuery.isFetchNextPageError ? 'Try again' : 'Load more templates'}
              disabled={templatesQuery.isFetchingNextPage}
              onPress={() => void templatesQuery.fetchNextPage()}
            />
          ) : null}
        </View>
      )}
    </Screen>
  );
}

function TemplatePoster({ template, previewAttempt, onPreviewError }: {
  template: MediaTemplateSummary;
  previewAttempt: number;
  onPreviewError: () => void;
}) {
  const theme = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${template.name}. Use template by ${creatorName(template)}`}
      accessibilityHint="Opens template details"
      onPress={() => router.push(`/templates/${encodeURIComponent(template.slug)}` as never)}
      style={({ pressed }) => ({ gap: 11, opacity: pressed ? appTheme.opacity.pressed : 1 })}
    >
      <View style={{ minHeight: 280, aspectRatio: 4 / 5, overflow: 'hidden', borderRadius: appTheme.radii.xl, borderCurve: 'continuous', backgroundColor: theme.colors.surfaceInset }}>
        <TemplatePosterImage key={`${template.thumbnailUrl}:${previewAttempt}`} template={template} onError={onPreviewError} />
        <LinearGradient
          colors={[hexWithAlpha(mediaColors.mediaGround, 0.03), hexWithAlpha(mediaColors.mediaGround, 0.18), hexWithAlpha(mediaColors.mediaGround, 0.94)]}
          locations={[0.35, 0.58, 1]}
          style={{ position: 'absolute', inset: 0, justifyContent: 'flex-end', padding: 18, gap: 6 }}
        >
          {/* On the gradient's black foot, so the dark palette in both schemes. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: hexWithAlpha(mediaColors.onMedia, 0.14) }}>
              <Play size={16} fill={themes.dark.colors.text} color={themes.dark.colors.text} />
            </View>
            <Kicker color={themes.dark.colors.primary}>{template.outputKind} template</Kicker>
          </View>
          <AppText variant="sectionTitle" color={themes.dark.colors.text} numberOfLines={2}>{template.name}</AppText>
          <AppText variant="caption" color={themes.dark.colors.textSecondary} numberOfLines={1}>by {creatorName(template)}</AppText>
        </LinearGradient>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <AppText variant="bodySm" color="muted" style={{ flex: 1 }}>
          {inputSummary(template)}
          {template.estimatedTotalCredits === null ? '' : ` · about ${template.estimatedTotalCredits} credits`}
        </AppText>
        <ArrowRight size={20} color={theme.colors.primary} />
      </View>
    </Pressable>
  );
}

function TemplatePosterImage({ template, onError }: { template: MediaTemplateSummary; onError: () => void }) {
  const theme = useAppTheme();
  const [failed, setFailed] = useState(false);
  const OutputIcon = template.outputKind === 'video' ? Video : ImageIcon;
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <OutputIcon size={appTheme.icon.hero} color={theme.colors.faint} />
      {template.thumbnailUrl && !failed ? (
        <Image
          source={{ uri: template.thumbnailUrl }}
          contentFit="cover"
          transition={160}
          style={{ position: 'absolute', inset: 0 }}
          onError={() => { setFailed(true); onError(); }}
        />
      ) : null}
    </View>
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
      <Stack.Screen options={{ title: 'Template' }} />
      {templateQuery.isLoading ? (
        <LoadingState label="Loading template" />
      ) : templateQuery.isError || !template ? (
        <View style={{ gap: 12 }}>
          <StatusBlock title="Template unavailable" body={errorMessage(templateQuery.error, 'This template may have been removed.')} tone="danger" />
          <SecondaryButton label="Try again" onPress={() => void templateQuery.refetch()} />
        </View>
      ) : (
        <TemplateDetailContent template={template} resolveVideoRetry={async () => {
          const fresh = await api.getMediaTemplate(template.id);
          if (fresh.template.id !== template.id || !fresh.template.videoUrl) throw new Error('Demo unavailable');
          return fresh.template.videoUrl;
        }} message={message} starting={createRun.isPending} onUse={useTemplate} />
      )}
    </Screen>
  );
}

function TemplateDetailContent({
  template,
  resolveVideoRetry,
  message,
  starting,
  onUse,
}: {
  template: MediaTemplateDetail;
  resolveVideoRetry: () => Promise<string>;
  message: string | null;
  starting: boolean;
  onUse: () => void;
}) {
  const theme = useAppTheme();
  return (
    <>
      <View style={{ gap: 8 }}>
        <Kicker color={theme.colors.primary}>{template.category}</Kicker>
        <AppText variant="pageTitle">{template.name}</AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <CircleUserRound size={appTheme.icon.sm} color={theme.colors.muted} />
          <AppText variant="bodySm" color="muted">by {creatorName(template)}</AppText>
          {template.useCount > 0 ? <AppText variant="caption" color="faint">· {template.useCount} uses</AppText> : null}
        </View>
      </View>

      {/* The demo clip, or the poster of a template without one, in the same
          frame: whole, and centred on black bands. */}
      {template.videoUrl
        ? <MediaPreview url={template.videoUrl} kind="video" height={430} letterbox resolveRetryUrl={resolveVideoRetry} />
        : <MediaPreview url={template.thumbnailUrl} kind="image" height={430} letterbox />}
      {template.description ? <AppText variant="body" color="textSecondary">{template.description}</AppText> : null}

      <View style={{ gap: 12 }}>
        <AppText variant="cardTitle">What you’ll add</AppText>
        {template.inputSlots.length ? template.inputSlots.map((slot, index) => {
          const SlotIcon = slot.kind === 'video' ? Video : ImageIcon;
          return (
            <View key={slot.key} style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
              <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: theme.colors.pressed, alignItems: 'center', justifyContent: 'center' }}>
                <SlotIcon size={16} color={theme.colors.primary} />
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
            <CircleDollarSign size={20} color={theme.colors.primary} />
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
  const { api, user, identityUserId, credits, isLoading: isAuthLoading, refreshProfile } = useAuth();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);
  const [localPreviews, setLocalPreviews] = useState<Record<string, string>>({});
  const previousRunStatusRef = useRef<TemplateRun['status'] | null>(null);
  const runQueryKey = useMemo(() => ['media-template-run', runId] as const, [runId]);
  const runQuery = useQuery({
    queryKey: runQueryKey,
    enabled: Boolean(runId && user),
    // Every read signs the media again; keeping the addresses already on screen
    // is what stops each poll reloading every finished step. The cache is read
    // after the response, so an action's answer that landed meanwhile is the one kept.
    queryFn: async () => {
      const response = await api.getTemplateRun(runId);
      return withStableRunMedia(queryClient.getQueryData<TemplateRunResponse>(runQueryKey), response);
    },
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
    queryClient.setQueryData<TemplateRunResponse>(runQueryKey, (previous) => withStableRunMedia(previous, response));
    setMessage(null);
  };

  // A run can move on without this screen (approved on the web, ended by the
  // worker), and nothing polls one that waits on the person: it is read again,
  // so the button that was refused is not left there to fail the same way.
  const showRefusal = (error: unknown, fallback: string) => {
    void runQuery.refetch();
    setMessage(templateRunActionErrorMessage(errorMessage(error, fallback), error instanceof ApiError ? error.code : null));
  };

  /** The run as the server has it now, or null when it could not be read. */
  const readRunAgain = async () => {
    const refreshed = await runQuery.refetch();
    return refreshed.isError ? null : refreshed.data?.run ?? null;
  };

  const startMutation = useMutation({
    mutationFn: () => api.startTemplateRun(runId),
    onSuccess: (response) => {
      applyRun(response);
      void refreshProfile();
      // A workflow run spends the same generation pipeline, so the create ring
      // should light for it too. Its poll is off at a count of zero.
      invalidateActiveGenerations(queryClient, identityUserId);
    },
    onError: (error) => showRefusal(error, 'Could not start this workflow.'),
  });
  const retryMutation = useMutation({
    mutationFn: (stepId: string) => api.retryTemplateRunStep(runId, stepId),
    onSuccess: (response) => { applyRun(response); void refreshProfile(); },
    onError: (error) => showRefusal(error, 'Could not retry this step.'),
  });
  const approvalMutation = useMutation({
    mutationFn: (stepId: string) => api.approveTemplateRunStep(runId, stepId),
    onSuccess: (response) => { applyRun(response); void refreshProfile(); },
    onError: (error) => showRefusal(error, 'Could not approve this step.'),
  });
  const cancelMutation = useMutation({
    mutationFn: () => api.cancelTemplateRun(runId),
    // Cancelling settles what finished, which can move the balance.
    onSuccess: (response) => { applyRun(response); void refreshProfile(); },
    onError: (error) => showRefusal(error, 'Could not cancel this creation.'),
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
      showRefusal(error, `Could not upload ${slot.label}.`);
    } finally {
      setUploadingSlot(null);
    }
  };

  if (isAuthLoading) {
    return <Screen><Stack.Screen options={{ title: 'Template Run' }} /><LoadingState label="Restoring your account" /></Screen>;
  }
  if (!user) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Template Run' }} />
        <StatusBlock title="Sign in to continue" body="Your template run is saved to your account." tone="neutral" />
        <PrimaryButton label="Sign in" onPress={() => router.replace({ pathname: '/auth', params: { returnTo: `/template-runs/${encodeURIComponent(runId)}` } } as never)} />
      </Screen>
    );
  }

  // A creator's test run is finished on the web canvas: a consumer run of its
  // template is not the revision it tests, and a draft template has none.
  const restartTemplateId = run && !run.isTest ? template?.slug ?? run.templateId : null;

  return (
    <Screen>
      {/* The template's own name is unbounded catalog text; Toolbars caps a view
          title at ~15 characters, and RunHeader already names the template in the
          body, so the bar says what the view is instead of what it contains. */}
      <Stack.Screen options={{ title: 'Template Run' }} />
      {runQuery.isLoading ? (
        <LoadingState label="Restoring your creation" />
      ) : !run ? (
        // Only with no run to show: a refresh that fails leaves the run on screen.
        <View style={{ gap: 12 }}>
          <StatusBlock title="Could not restore this creation" body={errorMessage(runQuery.error, 'Check your connection and try again.')} tone="danger" />
          {isMissingRunError(runQuery.error) ? null : <SecondaryButton label="Try again" onPress={() => void runQuery.refetch()} />}
        </View>
      ) : (
        <>
          <RunHeader
            run={run}
            template={template}
            refreshing={runQuery.isFetching}
            // A polled run reads itself every few seconds.
            onRefresh={isTemplateRunPolling(run.status) ? undefined : () => void runQuery.refetch()}
          />
          {runQuery.isError ? (
            <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <AppText variant="caption" color="muted" style={{ flex: 1 }}>Couldn’t refresh. Showing the last update.</AppText>
              <SecondaryButton label="Try again" disabled={runQuery.isFetching} onPress={() => void runQuery.refetch()} />
            </View>
          ) : null}
          {run.isTest ? <StatusBlock title="Creator test — finish it on the web canvas" tone="info" /> : null}
          {run.status === 'collecting_inputs' ? (
            <InputStage
              run={run}
              previews={localPreviews}
              uploadingSlot={uploadingSlot}
              onUpload={(slot) => void uploadSlot(slot)}
              // Starting, retrying and approving each send inputs on to the models.
              onStart={() => void withAiDataConsent(() => startMutation.mutate())}
              starting={startMutation.isPending}
              credits={credits}
              estimatedTotalCredits={run.estimatedTotalCredits ?? template?.estimatedTotalCredits ?? null}
            />
          ) : run.result ? (
            <ResultStage run={run} api={api} userId={user.id} readRunAgain={readRunAgain} />
          ) : (
            <RunSteps
              run={run}
              credits={credits}
              busy={retryMutation.isPending || approvalMutation.isPending}
              retryingStepId={retryMutation.isPending ? retryMutation.variables ?? null : null}
              approvingStepId={approvalMutation.isPending ? approvalMutation.variables ?? null : null}
              restartTemplateId={restartTemplateId}
              onRetry={(stepId) => void withAiDataConsent(() => retryMutation.mutate(stepId))}
              onApprove={(stepId) => void withAiDataConsent(() => approvalMutation.mutate(stepId))}
            />
          )}

          {run.status === 'failed' && !run.result ? (
            <View style={{ gap: 10 }}>
              <StatusBlock title="Creation failed" body={run.errorMessage ?? 'This run has ended. Start again from the template when you’re ready.'} tone="danger" />
              {restartTemplateId ? (
                <SecondaryButton
                  label="Start a new run"
                  onPress={() => router.push(`/templates/${encodeURIComponent(restartTemplateId)}` as never)}
                />
              ) : null}
            </View>
          ) : null}
          {run.status === 'cancelled' && !run.result ? (
            <View style={{ gap: 10 }}>
              <StatusBlock title="Creation cancelled" body="This run is closed. Start again from the template when you’re ready." tone="neutral" />
              {restartTemplateId ? (
                <SecondaryButton
                  label="Return to template"
                  onPress={() => router.push(`/templates/${encodeURIComponent(restartTemplateId)}` as never)}
                />
              ) : null}
            </View>
          ) : null}
          {message ? <StatusBlock title="Action needed" body={message} tone="danger" /> : null}
          {!isTemplateRunTerminal(run.status) ? (
            <SecondaryButton
              label="Cancel creation"
              disabled={cancelMutation.isPending}
              onPress={() => {
                void showConfirmDialog({
                  title: 'Cancel this creation?',
                  message: 'Finished steps stay in your library. A step that is already generating keeps its credits.',
                  // The control that opened this is itself named Cancel, so a
                  // Cancel meaning *stay* would reverse itself (ledger DV8).
                  cancelLabel: 'Keep creating',
                  confirmLabel: 'Cancel creation',
                  destructive: true,
                }).then((cancel) => {
                  if (cancel) cancelMutation.mutate();
                });
              }}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function RunHeader({
  run,
  template,
  refreshing,
  onRefresh,
}: {
  run: TemplateRun;
  template?: MediaTemplateSummary;
  refreshing: boolean;
  onRefresh?: () => void;
}) {
  const theme = useAppTheme();
  const progress = templateRunProgress(run);
  const activeLabel = prioritizeTemplateRunSteps(run.steps, run.status)
    .find((step) => !isTemplateRunStepSuccessful(step))?.label;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1, gap: 5 }}>
          <Kicker color={theme.colors.primary}>{progress.complete} of {progress.total} complete</Kicker>
          <AppText variant="pageTitle">{templateRunStageLabel(run)}</AppText>
          <AppText variant="bodySm" color="muted">{activeLabel ?? template?.name ?? run.templateTitle}</AppText>
        </View>
        {onRefresh ? <IconButton icon={RefreshCw} label="Refresh" disabled={refreshing} onPress={onRefresh} /> : null}
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Template progress"
        accessibilityValue={{ min: 0, max: progress.total, now: progress.complete }}
        style={{ flexDirection: 'row', gap: 6 }}
      >
        {Array.from({ length: Math.max(progress.total, 1) }, (_, index) => (
          <View key={index} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: index < progress.complete ? theme.colors.success : index === progress.complete ? theme.colors.primary : theme.colors.borderStrong }} />
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
  const theme = useAppTheme();
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
              // A run's inputs are fixed once Start is sent; a pick then is refused.
              disabled={uploadingSlot !== null || starting}
              onPress={() => onUpload(slot)}
              style={({ pressed }) => ({
                minHeight: 210,
                overflow: 'hidden',
                borderRadius: appTheme.radii.xl,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderStyle: preview ? 'solid' : 'dashed',
                borderColor: uploaded ? theme.colors.success : theme.colors.borderStrong,
                backgroundColor: theme.colors.surfaceInset,
                opacity: pressed ? appTheme.opacity.pressed : 1,
                alignItems: 'center',
                justifyContent: 'center',
              })}
            >
              {/* The whole upload, because it is what the workflow is given. A clip
                  gets no player controls: the slot is one button, so a tap on
                  them opened the picker as well. */}
              {preview ? <MediaPreview url={preview} kind={slot.kind} height={210} letterbox nativeControls={false} /> : <SlotIcon size={appTheme.icon.hero} color={theme.colors.faint} />}
              <View style={{ position: preview ? 'absolute' : 'relative', bottom: preview ? 14 : undefined, minWidth: 132, minHeight: 48, borderRadius: 24, paddingHorizontal: 16, backgroundColor: hexWithAlpha(theme.colors.panel, 0.9), flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
                {uploadingSlot === slot.key ? <ActivityIndicator color={theme.colors.primary} /> : <Upload size={18} color={theme.colors.primary} />}
                <AppText variant="label">{uploadingSlot === slot.key ? 'Uploading…' : uploaded ? `Replace ${slot.kind}` : `Choose ${slot.kind}`}</AppText>
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
          <AppText variant="caption" color="muted">{credits === null ? CREDIT_BALANCE_LOADING_LABEL : `${formatCreditAmount(credits)} available`}</AppText>
        </View>
      </Card>
      {!canAfford ? (
        <View style={{ gap: 10 }}>
          <StatusBlock
            title="More credits needed"
            body={`This workflow is estimated at ${estimatedTotalCredits} credits, and your current balance is ${formatCreditAmount(credits)}.`}
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
  /** Where a run that cannot go on is started again; null when it is not started from the app. */
  restartTemplateId: string | null;
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
        {restartTemplateId ? (
          <SecondaryButton
            label="Return to template"
            onPress={() => router.push(`/templates/${encodeURIComponent(restartTemplateId)}` as never)}
          />
        ) : null}
      </View>
    );
  }
  const orderedSteps = prioritizeTemplateRunSteps(run.steps, run.status);
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
  restartTemplateId: string | null;
  runStatus: TemplateRun['status'];
  onRetry: () => void;
  onApprove: () => void;
}) {
  const theme = useAppTheme();
  const outcome = templateRunStepOutcome(runStatus, step);
  const successful = outcome === 'complete';
  const failed = isTemplateRunStepFailed(step);
  // The run ended before this step did. It is not an error, and is not drawn as one.
  const notFinished = outcome === 'not_finished';
  const awaitingApproval = outcome === 'review';
  const needsReplacementInput = templateRunStepNeedsReplacementInput(step);
  const canRetry = canRetryTemplateRunStep(runStatus, step);
  // A retry that never started: nothing but this step's Retry sets the run going.
  const stalled = isTemplateRunStepStalled(runStatus, step);
  // Its advice is to retry, which only a failed step that can be retried can follow.
  const serviceMisconfigured = outcome === 'needs_attention' && canRetry && step.failureCode === 'service_misconfigured';
  // The step failed for good while its run can still continue: the card's one way on is the template.
  const needsNewRun = templateRunStepNeedsNewRun(runStatus, step);
  const mark = templateRunStepPlaceholderMark(runStatus, step);
  const confirmRetry = () => {
    const cost = step.estimatedRetryCredits === null ? 'the current generation rate' : `${step.estimatedRetryCredits} credits`;
    const balance = credits === null ? '' : ` You currently have ${formatCreditAmount(credits)} credits.`;
    if (
      credits !== null
      && step.estimatedRetryCredits !== null
      && credits < step.estimatedRetryCredits
    ) {
      void showConfirmDialog({
        title: 'More credits needed',
        message: `This retry costs ${step.estimatedRetryCredits} credits and your balance is ${formatCreditAmount(credits)}.`,
        cancelLabel: 'Not now',
        confirmLabel: 'Get credits',
      }).then((topUp) => {
        if (topUp) router.push('/pricing' as never);
      });
      return;
    }
    void showConfirmDialog({
      title: `Retry ${step.label.toLowerCase()}?`,
      message: `This regenerates only this branch at ${cost}.${balance}`,
      cancelLabel: 'Keep this result',
      confirmLabel: 'Retry',
    }).then((retry) => {
      if (retry) onRetry();
    });
  };
  const statusAccent = successful ? 'workflow' : awaitingApproval || (failed && !notFinished) || stalled ? 'amber' : undefined;
  const NotFinishedIcon = step.mediaKind === 'video' ? VideoOff : ImageOff;

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, flexDirection: 'row', gap: 9, alignItems: 'center' }}>
          {step.kind === 'approval' ? <ShieldCheck size={appTheme.icon.default} color={theme.colors.primary} /> : step.mediaKind === 'video' ? <Video size={appTheme.icon.default} color={theme.colors.video} /> : <ImageIcon size={appTheme.icon.default} color={theme.colors.image} />}
          <AppText variant="cardTitle">{step.label}</AppText>
        </View>
        <Pill label={templateRunStepStatusLabel(runStatus, step)} accent={statusAccent} />
      </View>
      {step.outputUrl ? (
        // The whole output: a step can be waiting for it to be approved.
        <MediaPreview url={step.mediaKind === 'video' ? step.renditionUrl || step.outputUrl : step.outputUrl} kind={step.mediaKind} height={step.mediaKind === 'video' ? 300 : 390} letterbox />
      ) : (
        <View style={{ minHeight: 220, borderRadius: appTheme.radii.xl, borderCurve: 'continuous', backgroundColor: theme.colors.surfaceInset, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          {mark === 'no_output' ? <NotFinishedIcon size={appTheme.icon.hero} color={theme.colors.muted} />
            : mark === 'warning' ? <TriangleAlert size={appTheme.icon.hero} color={theme.colors.danger} />
              : mark === 'retry' ? <RefreshCw size={appTheme.icon.hero} color={theme.colors.danger} />
                : <ActivityIndicator size="large" color={theme.colors.primary} />}
          <AppText variant="bodySm" color="muted">{templateRunStepPlaceholderLabel(runStatus, step)}</AppText>
        </View>
      )}
      {step.errorMessage ? <AppText variant="caption" color={notFinished ? 'muted' : 'danger'}>{step.errorMessage}</AppText> : null}
      {stalled ? <AppText variant="caption" color="muted">Retry it to continue. Earlier completed steps are safe.</AppText> : null}
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
      {awaitingApproval ? <PrimaryButton label={approving ? 'Approving…' : 'Approve & continue'} loading={approving} disabled={disabled && !approving} onPress={onApprove} /> : null}
      {canRetry ? (
        <SecondaryButton
          label={retrying
            ? 'Retrying…'
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
      {restartTemplateId && (needsReplacementInput || needsNewRun) ? (
        <SecondaryButton
          label={needsReplacementInput ? 'Start with new inputs' : 'Return to template'}
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
  readRunAgain,
}: {
  run: TemplateRun;
  api: ReturnType<typeof useAuth>['api'];
  userId: string;
  /** The run as the server has it now, or null when it could not be read. */
  readRunAgain: () => Promise<TemplateRun | null>;
}) {
  const theme = useAppTheme();
  const queryClient = useQueryClient();
  const [startingAnother, setStartingAnother] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const createRunKeyRef = useRef<string | null>(null);
  const result = run.result;
  const linkedPost = templateRunLinkedPost(result);
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
    let url = safeResultUrl;
    // Each link is signed for an hour at the read that brought it, and this
    // screen can stay open under another one for longer than that.
    if (url && isSignedMediaUrlExpiring(url)) {
      const renewedUrl = (await readRunAgain())?.result?.url;
      url = renewedUrl && isSafeTemplateResultUrl(renewedUrl) ? renewedUrl : null;
    }
    if (!url) {
      setMessage('The full-quality file link is unavailable. Refresh this creation and try again.');
      return;
    }
    try {
      const supported = await Linking.canOpenURL(url);
      if (!supported) throw new Error('Unsupported result URL.');
      await Linking.openURL(url);
    } catch {
      setMessage('Could not open the full-quality file. Refresh this creation and try again.');
    }
  };

  const publishResult = (options: { shareAfterPublish?: boolean } = {}) => {
    const generationId = result?.generationId?.trim();
    if (!canPublish || !generationId) return;
    router.push({
      pathname: '/post/new',
      params: {
        generationId,
        ...(options.shareAfterPublish ? { shareAfterPublish: '1' } : {}),
      },
    } as never);
  };

  // The post's own page is what is shared, never the file.
  const shareLinkedPost = async () => {
    if (!linkedPost) return;
    const title = run.templateTitle;
    const url = buildShareUrl(env.siteUrl, `/showcase/${encodeURIComponent(linkedPost.id)}`, 'my-creations');
    // A dismissed share sheet is not an error worth surfacing.
    const shared = await Share.share({ title, message: `${title}\n${url}`, url }).catch(() => null);
    // Android's share intent cannot report a dismissal (it answers "shared" either way), so only iOS counts a share.
    if (Platform.OS !== 'ios' || shared?.action !== Share.sharedAction) return;
    await api.shareShowcasePost(linkedPost.id, { sourceSurface: 'my-creations' }).catch(() => null);
  };

  if (!result) return null;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: theme.semantic.success.background, alignItems: 'center', justifyContent: 'center' }}>
          <Check size={18} color={theme.colors.success} />
        </View>
        <AppText variant="cardTitle">Final {result.kind}</AppText>
      </View>
      <MediaPreview url={result.kind === 'video' ? result.renditionUrl || result.url : result.url} kind={result.kind} height={440} letterbox />
      {!safeResultUrl ? (
        <StatusBlock
          title="Result link unavailable"
          body="Refresh this creation to request a new secure media link."
          tone="danger"
        />
      ) : null}
      {message ? <StatusBlock title="Could not continue" body={message} tone="danger" /> : null}
      {linkedPost ? (
        <>
          {/* Already posted, so never published again: that would write over the post. */}
          <PrimaryButton
            label={linkedPost.visibility === 'private' ? 'Open post' : 'View post'}
            onPress={() => router.push(`/post/${encodeURIComponent(linkedPost.id)}` as never)}
          />
          {linkedPost.visibility === 'private' ? null : <SecondaryButton label="Share" onPress={() => void shareLinkedPost()} />}
          <SecondaryButton label={`Open full-quality ${result.kind}`} disabled={!safeResultUrl} onPress={() => void openOriginal()} />
        </>
      ) : canPublish ? (
        <>
          <PrimaryButton label="Publish to Explore" onPress={() => publishResult()} />
          <SecondaryButton label={`Open full-quality ${result.kind}`} disabled={!safeResultUrl} onPress={() => void openOriginal()} />
          {/* Sharing used to send the raw storage URL, which reaches non-users with
              no landing page, no attribution, no remix path, and unmetered egress.
              Publishing first is what turns a share into a product surface — so the
              control only exists when there is something publishable. */}
          <SecondaryButton label="Publish & share" onPress={() => publishResult({ shareAfterPublish: true })} />
        </>
      ) : (
        <PrimaryButton label={`Open full-quality ${result.kind}`} disabled={!safeResultUrl} onPress={() => void openOriginal()} />
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <Download size={appTheme.icon.xs} color={theme.colors.muted} />
        <AppText variant="caption" color="muted">The original full-quality file opens outside the app.</AppText>
      </View>
      {run.isTest ? null : <SecondaryButton label={startingAnother ? 'Starting…' : 'Create another version'} disabled={startingAnother} onPress={() => void createAnother()} />}
    </View>
  );
}

function LoadingState({ label }: { label: string }) {
  const theme = useAppTheme();
  return (
    <View accessibilityLiveRegion="polite" style={{ minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
      <AppText variant="bodySm" color="muted">{label}</AppText>
    </View>
  );
}
