'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleDollarSign,
  Download,
  Image as ImageIcon,
  Loader2,
  LockKeyhole,
  LogIn,
  RotateCcw,
  Share2,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';
import {
  Button,
  Kicker,
  MediaFrame,
  Pill,
  StatusCallout,
  Surface,
  Text,
} from '@/app/components/DesignSystem';

import {
  approveTemplateRunStep,
  cancelTemplateRun,
  createClientIdempotencyKey,
  finalizeTemplateInputs,
  getTemplate,
  getTemplateRun,
  retryTemplateRunStep,
  signTemplateInput,
  startTemplateRun,
} from './api';
import {
  TemplatePageShell,
  TemplateRunStepCard,
  TemplateRunStepper,
  TemplateSlotUpload,
} from './TemplatePrimitives';
import type {
  MediaTemplate,
  TemplateInputSlot,
  TemplateMediaKind,
  TemplateRun,
  TemplateRunStep,
} from './types';
import {
  isRunTerminal,
  isStepAwaitingApproval,
  isStepFailed,
  shouldPollTemplateRun,
} from './types';

const POLL_INTERVAL_MS = 3_000;
const MAX_TEMPLATE_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_TEMPLATE_VIDEO_BYTES = 100 * 1024 * 1024;
const MIN_TEMPLATE_IMAGE_DIMENSION = 256;
const TEMPLATE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const TEMPLATE_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

export function validateTemplateInputFileMetadata(file: File, kind: TemplateMediaKind): string | null {
  const supportedTypes = kind === 'image' ? TEMPLATE_IMAGE_MIME_TYPES : TEMPLATE_VIDEO_MIME_TYPES;
  if (!supportedTypes.has(file.type.toLowerCase())) {
    return kind === 'image'
      ? 'Choose a JPEG, PNG, or WebP image.'
      : 'Choose an MP4, WebM, or MOV video.';
  }
  if (file.size <= 0) return 'This file is empty. Choose another file.';
  const maxBytes = kind === 'image' ? MAX_TEMPLATE_IMAGE_BYTES : MAX_TEMPLATE_VIDEO_BYTES;
  if (file.size > maxBytes) {
    return kind === 'image' ? 'Choose an image up to 30 MB.' : 'Choose a video up to 100 MB.';
  }
  return null;
}

export function getTemplateImageDimensionError(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'We could not read this image. Export it as JPEG, PNG, or WebP and try again.';
  }
  if (width < MIN_TEMPLATE_IMAGE_DIMENSION || height < MIN_TEMPLATE_IMAGE_DIMENSION) {
    return `This image is ${Math.round(width)} × ${Math.round(height)} px. Choose one that is at least 256 × 256 px so generation can use it reliably.`;
  }
  return null;
}

async function validateTemplateInputFile(file: File, kind: TemplateMediaKind): Promise<string | null> {
  const metadataError = validateTemplateInputFileMetadata(file, kind);
  if (metadataError || kind !== 'image') return metadataError;

  try {
    return await new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      const finish = (message: string | null) => {
        URL.revokeObjectURL(objectUrl);
        resolve(message);
      };
      image.onload = () => finish(getTemplateImageDimensionError(image.naturalWidth, image.naturalHeight));
      image.onerror = () => finish('We could not read this image. Export it as JPEG, PNG, or WebP and try again.');
      image.src = objectUrl;
    });
  } catch {
    return 'We could not read this image. Export it as JPEG, PNG, or WebP and try again.';
  }
}

function getSafeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  if (value.startsWith('/templates/') || value.startsWith('/create-workflow')) return value;
  return null;
}

function getRunStatusCopy(run: TemplateRun): { title: string; body: string } {
  switch (run.status) {
    case 'collecting_inputs':
      return { title: 'Add your inputs', body: 'Required uploads stay private to this run.' };
    case 'queued':
      return { title: 'Your run is queued', body: 'The first workflow step will begin shortly.' };
    case 'processing':
    case 'running':
    case 'generating_frames':
    case 'generating_video':
      return { title: 'Your workflow is running', body: 'Steps update here as each result becomes available.' };
    case 'awaiting_approval':
      return { title: 'Your review is needed', body: 'Review the result below, then approve it or create another version.' };
    case 'needs_attention':
      return { title: 'A step needs attention', body: 'The failed step and its retry action are shown first. Earlier work remains saved.' };
    case 'succeeded':
      return {
        title: `Your ${run.result?.kind || 'result'} is ready`,
        body: run.isTest
          ? 'Return to the workflow canvas to finish publishing this template.'
          : 'Publish it to Showcase, download it, or create another version.',
      };
    case 'failed':
      return { title: 'This run could not finish', body: run.errorMessage || 'The workflow stopped before producing a result.' };
    case 'cancelled':
      return { title: 'Run cancelled', body: 'No new workflow steps will start for this run.' };
  }
}

export function getTemplateRunErrorCopy(message: string): { title: string; body: string } {
  const normalized = message.toLowerCase();
  if (
    (normalized.includes('insufficient') && normalized.includes('credit'))
    || normalized.includes('not enough credit')
  ) {
    return {
      title: 'Not enough credits',
      body: `${message} Add credits, then retry this action. Your uploads and completed steps are still saved.`,
    };
  }
  if (normalized.includes('network') || normalized.includes('fetch') || normalized.includes('connection')) {
    return {
      title: 'Connection interrupted',
      body: 'Check your connection and try again. Your saved inputs and completed steps will not be restarted.',
    };
  }
  return {
    title: 'We could not complete that action',
    body: `${message} Your saved inputs and completed steps are safe, so you can try again.`,
  };
}

function formatCredits(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} credits` : 'Calculated when the run starts';
}

function BusyRun() {
  return (
    <Surface variant="soft" padding="lg" className="flex min-h-56 flex-col items-center justify-center text-center">
      <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-rose-300/20 bg-rose-400/10 text-rose-100">
        <WandSparkles className="h-5 w-5" aria-hidden />
        <Loader2 className="absolute -right-2 -top-2 h-5 w-5 animate-spin text-white motion-reduce:animate-none" aria-hidden />
      </div>
      <Text as="h2" variant="cardTitle" className="mt-5">Preparing the next step</Text>
      <Text variant="bodySm" className="mt-2 max-w-md">
        This run is saved to your account. You can leave and resume it from this same link.
      </Text>
    </Surface>
  );
}

export default function TemplateRunClient({ runId }: { runId: string }) {
  const searchParams = useSearchParams();
  const { session, credits, isLoading: isAuthLoading, refreshSessionState } = useAuth();
  const [run, setRun] = useState<TemplateRun | null>(null);
  const [template, setTemplate] = useState<MediaTemplate | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<{
    type: 'uploading' | 'starting' | 'retrying' | 'approving' | 'cancelling';
    stepId?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputFiles, setInputFiles] = useState<Record<string, File | null>>({});
  const [previewUrls, setPreviewUrls] = useState<Record<string, string | null>>({});
  const [inputErrors, setInputErrors] = useState<Record<string, string | null>>({});
  const [validatingInputs, setValidatingInputs] = useState<Record<string, boolean>>({});
  const [shareFeedback, setShareFeedback] = useState<string | null>(null);
  const [isPublishOpen, setIsPublishOpen] = useState(false);
  const [publishedPost, setPublishedPost] = useState<{
    path: string;
    visibility: 'public' | 'unlisted' | 'private';
  } | null>(null);
  const previewUrlsRef = useRef(previewUrls);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const inputValidationSequenceRef = useRef<Record<string, number>>({});
  const returnTo = getSafeReturnTo(searchParams.get('returnTo'));
  const isTestView = searchParams.get('test') === '1';
  const isBusy = busyAction !== null;

  useEffect(() => { previewUrlsRef.current = previewUrls; }, [previewUrls]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => () => {
    Object.values(previewUrlsRef.current).forEach((url) => {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    });
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (isAuthLoading || !session?.access_token) return;
    let active = true;
    void getTemplateRun(runId, session.access_token)
      .then((nextRun) => { if (active) setRun(nextRun); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load this run.');
      })
      .finally(() => { if (active) setIsLoading(false); });
    return () => { active = false; };
  }, [isAuthLoading, runId, session?.access_token]);

  useEffect(() => {
    if (!run?.templateId || !session?.access_token || template?.id === run.templateId) return;
    let active = true;
    void getTemplate(run.templateId, session.access_token)
      .then((nextTemplate) => { if (active) setTemplate(nextTemplate); })
      .catch(() => { /* A snapshotted run remains resumable after a template is disabled. */ });
    return () => { active = false; };
  }, [run?.templateId, session?.access_token, template?.id]);

  const shouldPoll = Boolean(run && shouldPollTemplateRun(run));
  useEffect(() => {
    if (!shouldPoll || !session?.access_token) return;
    let active = true;
    const poll = async () => {
      try {
        const nextRun = await getTemplateRun(runId, session.access_token);
        if (!active) return;
        setRun(nextRun);
        if (shouldPollTemplateRun(nextRun)) pollTimeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS);
        else void refreshSessionState();
      } catch {
        if (active) pollTimeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS * 2);
      }
    };
    pollTimeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, [refreshSessionState, runId, session?.access_token, shouldPoll]);

  const replaceInputFile = async (slot: TemplateInputSlot, file: File | null) => {
    const sequence = (inputValidationSequenceRef.current[slot.key] ?? 0) + 1;
    inputValidationSequenceRef.current[slot.key] = sequence;
    setInputErrors((current) => ({ ...current, [slot.key]: null }));

    if (!file) {
      const previousUrl = previewUrls[slot.key];
      if (previousUrl?.startsWith('blob:')) URL.revokeObjectURL(previousUrl);
      setInputFiles((current) => ({ ...current, [slot.key]: null }));
      setPreviewUrls((current) => ({ ...current, [slot.key]: null }));
      setValidatingInputs((current) => ({ ...current, [slot.key]: false }));
      return;
    }

    setValidatingInputs((current) => ({ ...current, [slot.key]: true }));
    const validationError = await validateTemplateInputFile(file, slot.kind);
    if (inputValidationSequenceRef.current[slot.key] !== sequence) return;
    setValidatingInputs((current) => ({ ...current, [slot.key]: false }));
    if (validationError) {
      const keptPreviousInput = Boolean(inputFiles[slot.key] || run?.inputs[slot.key]);
      setInputErrors((current) => ({
        ...current,
        [slot.key]: `${validationError} ${keptPreviousInput ? 'Your previous input is still selected.' : 'This file was not selected.'}`,
      }));
      return;
    }

    const previousUrl = previewUrls[slot.key];
    if (previousUrl?.startsWith('blob:')) URL.revokeObjectURL(previousUrl);
    setInputFiles((current) => ({ ...current, [slot.key]: file }));
    setPreviewUrls((current) => ({ ...current, [slot.key]: URL.createObjectURL(file) }));
  };

  const setMutationFailure = (reason: unknown, fallback: string) => {
    setError(reason instanceof Error ? reason.message : fallback);
    setBusyAction(null);
  };

  const handleUploadAndStart = async () => {
    if (!run || !session?.access_token) return;
    if (Object.values(validatingInputs).some(Boolean)) {
      setError('Wait for the selected files to finish checking before starting.');
      return;
    }
    const missingSlot = run.inputSlots.find((slot) => slot.required && !run.inputs[slot.key] && !inputFiles[slot.key]);
    if (missingSlot) {
      setError(`Add ${missingSlot.label.toLowerCase()} before starting.`);
      return;
    }

    const filesToUpload = run.inputSlots.filter((slot) => Boolean(inputFiles[slot.key]));
    setBusyAction({ type: filesToUpload.length > 0 ? 'uploading' : 'starting' });
    setError(null);
    try {
      const uploadedInputs = await Promise.all(filesToUpload.map(async (slot) => {
        const file = inputFiles[slot.key];
        if (!file) throw new Error(`Choose a file for ${slot.label}.`);
        if (!file.type.startsWith(`${slot.kind}/`)) throw new Error(`${slot.label} must be a ${slot.kind} file.`);
        const intent = await signTemplateInput({ runId: run.id, token: session.access_token, slotKey: slot.key, file });
        const { supabase } = await import('@/lib/supabase');
        const { error: uploadError } = await supabase.storage
          .from(intent.bucket)
          .uploadToSignedUrl(intent.path, intent.token, file, { contentType: file.type || 'application/octet-stream' });
        if (uploadError) throw new Error(`Could not upload ${slot.label}: ${uploadError.message}`);
        return { slotKey: slot.key, storagePath: intent.storagePath };
      }));
      if (uploadedInputs.length > 0) {
        const finalizedRun = await finalizeTemplateInputs({
          runId: run.id,
          token: session.access_token,
          inputs: uploadedInputs,
        });
        setRun(finalizedRun);
        const uploadedKeys = new Set(uploadedInputs.map((input) => input.slotKey));
        filesToUpload.forEach((slot) => {
          const previewUrl = previewUrls[slot.key];
          if (previewUrl?.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
        });
        setInputFiles((current) => Object.fromEntries(
          Object.entries(current).map(([key, value]) => [key, uploadedKeys.has(key) ? null : value])
        ));
        setPreviewUrls((current) => Object.fromEntries(
          Object.entries(current).map(([key, value]) => [key, uploadedKeys.has(key) ? null : value])
        ));
      }
      setBusyAction({ type: 'starting' });
      const nextRun = await startTemplateRun(
        run.id,
        session.access_token,
        createClientIdempotencyKey(`template-run:${run.id}:start`)
      );
      setRun(nextRun);
      setBusyAction(null);
      void refreshSessionState();
    } catch (reason) {
      setMutationFailure(reason, 'Could not start this workflow.');
    }
  };

  const handleRetryStep = async (step: TemplateRunStep) => {
    if (!run || !session?.access_token) return;
    setBusyAction({ type: 'retrying', stepId: step.id });
    setError(null);
    try {
      const nextRun = await retryTemplateRunStep({
        runId: run.id,
        stepId: step.id,
        token: session.access_token,
        idempotencyKey: createClientIdempotencyKey(`template-run:${run.id}:step:${step.id}:retry`),
      });
      setRun(nextRun);
      setBusyAction(null);
      void refreshSessionState();
    } catch (reason) {
      setMutationFailure(reason, 'Could not retry this step.');
    }
  };

  const handleApproveStep = async (step: TemplateRunStep) => {
    if (!run || !session?.access_token) return;
    setBusyAction({ type: 'approving', stepId: step.id });
    setError(null);
    try {
      const nextRun = await approveTemplateRunStep({
        runId: run.id,
        stepId: step.id,
        token: session.access_token,
        idempotencyKey: createClientIdempotencyKey(`template-run:${run.id}:approval:${step.id}`),
      });
      setRun(nextRun);
      setBusyAction(null);
      void refreshSessionState();
    } catch (reason) {
      setMutationFailure(reason, 'Could not approve this step.');
    }
  };

  const handleCancel = async () => {
    if (!run || !session?.access_token || !window.confirm('Cancel this run? Completed steps will remain in your creation history.')) return;
    setBusyAction({ type: 'cancelling' });
    setError(null);
    try {
      setRun(await cancelTemplateRun(run.id, session.access_token));
      setBusyAction(null);
    } catch (reason) {
      setMutationFailure(reason, 'Could not cancel this run.');
    }
  };

  const handleShare = async () => {
    if (!run?.result?.url) return;
    const hasPublicFeedPost = publishedPost?.visibility === 'public';
    const shareUrl = hasPublicFeedPost
      ? new URL(publishedPost.path, window.location.origin).toString()
      : run.result.url;
    try {
      if (navigator.share) {
        await navigator.share({ title: template?.name || run.templateTitle, url: shareUrl });
        setShareFeedback('Share sheet opened.');
      } else {
        await navigator.clipboard.writeText(shareUrl);
        setShareFeedback(hasPublicFeedPost ? 'Showcase post link copied.' : 'Result link copied.');
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setShareFeedback('Could not share this result.');
    }
  };

  const inputReady = useMemo(() => {
    if (!run) return false;
    return run.inputSlots.filter((slot) => slot.required).every((slot) => Boolean(run.inputs[slot.key] || inputFiles[slot.key]));
  }, [inputFiles, run]);
  const isInputValidating = Object.values(validatingInputs).some(Boolean);

  if (!isAuthLoading && !session?.access_token) {
    return (
      <TemplatePageShell>
        <Surface variant="panel" padding="lg" className="mx-auto mt-16 max-w-lg text-center">
          <LogIn className="mx-auto h-9 w-9 text-rose-200" aria-hidden />
          <Text as="h1" variant="cardTitle" className="mt-4">Sign in to continue</Text>
          <Text variant="bodySm" className="mt-2">Your run is saved to your account so you can resume it anywhere.</Text>
          <Button href={`/login?returnUrl=${encodeURIComponent(`/template-runs/${runId}`)}`} variant="primary" className="mt-6">Sign in</Button>
        </Surface>
      </TemplatePageShell>
    );
  }

  if (isLoading || (isAuthLoading && !run)) {
    return (
      <TemplatePageShell>
        <div className="flex min-h-[68vh] items-center justify-center" role="status">
          <Loader2 className="h-8 w-8 animate-spin text-rose-200" aria-hidden />
          <span className="sr-only">Loading template run</span>
        </div>
      </TemplatePageShell>
    );
  }

  if (!run) {
    return (
      <TemplatePageShell>
        <Button href="/templates" variant="ghost" icon={ArrowLeft} iconPosition="start">Back to templates</Button>
        <StatusCallout tone="danger" title="Run unavailable" body={error || 'This run could not be found.'} className="mt-6" />
      </TemplatePageShell>
    );
  }

  const statusCopy = getRunStatusCopy(run);
  const result = run.result;
  const isTestRun = isTestView || run.isTest;
  const templateHref = template ? `/templates/${template.slug || template.id}` : '/templates';
  const createAnotherHref = `/templates/${template?.slug || run.templateId}/create`;
  const testReturnHref = returnTo
    ? `${returnTo}${returnTo.includes('?') ? '&' : '?'}testRunId=${encodeURIComponent(run.id)}`
    : `/create-workflow?template=${encodeURIComponent(run.templateId)}&testRunId=${encodeURIComponent(run.id)}`;
  const backHref = isTestRun ? testReturnHref : templateHref;
  const estimatedTotalCredits = run.estimatedTotalCredits ?? template?.estimatedTotalCredits ?? null;
  const creditShortfall = credits !== null && estimatedTotalCredits !== null
    ? Math.max(0, estimatedTotalCredits - credits)
    : 0;
  const missingRequiredSlots = run.inputSlots.filter(
    (slot) => slot.required && !run.inputs[slot.key] && !inputFiles[slot.key]
  );
  const errorCopy = error ? getTemplateRunErrorCopy(error) : null;
  const attentionSteps = run.steps.filter((step) => isStepFailed(step) || isStepAwaitingApproval(step));
  const orderedSteps = attentionSteps.length > 0
    ? [...attentionSteps, ...run.steps.filter((step) => !attentionSteps.includes(step))]
    : run.steps;
  const runEnded = isRunTerminal(run.status);

  return (
    <TemplatePageShell>
      <Surface variant="panel" padding="none" className="mb-6 p-5 sm:p-6">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <Button
                href={backHref}
                variant="ghost"
                icon={ArrowLeft}
                iconPosition="start"
                ariaLabel={isTestRun ? 'Back to workflow canvas' : 'Back to template'}
                className="shrink-0 px-3"
              >
                {isTestRun ? 'Canvas' : 'Back'}
              </Button>
              <div>
                <Kicker>{isTestRun ? 'Creator test run' : 'Template studio'}</Kicker>
                <Text as="h1" variant="sectionTitle" className="mt-2">{template?.name || run.templateTitle}</Text>
                <div role="status" aria-live="polite" aria-atomic="true">
                  <Text variant="bodySm" className="mt-2 max-w-2xl">
                    <span className="font-bold text-zinc-200">{statusCopy.title}.</span> {statusCopy.body}
                  </Text>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {credits !== null ? <Pill accent="commerce" icon={CircleDollarSign}>{credits} available</Pill> : null}
              {run.creditsUsed > 0 ? <Pill accent="neutral">{run.creditsUsed} credits used</Pill> : null}
              {run.estimatedRemainingCredits !== null && !isRunTerminal(run.status) ? (
                <Pill accent="neutral">~{run.estimatedRemainingCredits} credits remaining</Pill>
              ) : null}
              {!isRunTerminal(run.status) ? (
                <Button variant="ghost" icon={X} disabled={isBusy} onClick={handleCancel} className="px-3">
                  {busyAction?.type === 'cancelling' ? 'Cancelling…' : 'Cancel run'}
                </Button>
              ) : null}
            </div>
          </div>
          <TemplateRunStepper status={run.status} steps={run.steps} />
          {isTestRun && !result ? (
            <StatusCallout
              tone={run.status === 'needs_attention' || run.status === 'failed' || run.status === 'cancelled' ? 'warning' : 'info'}
              title={run.status === 'cancelled'
                ? 'This test run is closed'
                : run.status === 'needs_attention' || run.status === 'failed'
                  ? 'Fix this test before publishing'
                  : 'This run verifies the consumer experience'}
              body={run.status === 'cancelled'
                ? 'Return to the workflow canvas and start a new consumer test. Cancelled tests cannot unlock publishing.'
                : run.status === 'needs_attention' || run.status === 'failed'
                  ? 'Publishing stays locked until the test succeeds. Retry the failed step below, or return to the canvas to change the workflow.'
                  : 'Complete every generation and approval. A successful test unlocks publishing for this saved workflow revision.'}
            />
          ) : null}
        </div>
      </Surface>

      {errorCopy ? (
        <div ref={errorRef} tabIndex={-1} className="scroll-mt-24 outline-none">
          <StatusCallout tone="danger" title={errorCopy.title} body={errorCopy.body} className="mb-6" />
        </div>
      ) : null}

      {run.status === 'collecting_inputs' ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
          {run.inputSlots.length > 0 ? (
            <div className="grid gap-5 sm:grid-cols-2">
              {run.inputSlots.map((slot) => (
                <TemplateSlotUpload
                  key={slot.key}
                  slot={slot}
                  file={inputFiles[slot.key] ?? null}
                  previewUrl={previewUrls[slot.key] ?? null}
                  stored={Boolean(run.inputs[slot.key])}
                  disabled={isBusy}
                  validating={Boolean(validatingInputs[slot.key])}
                  error={inputErrors[slot.key] ?? null}
                  onChange={(file) => { void replaceInputFile(slot, file); }}
                />
              ))}
            </div>
          ) : (
            <Surface variant="soft" padding="lg">
              <Text as="h2" variant="cardTitle">No uploads needed</Text>
              <Text variant="bodySm" className="mt-2">This template is ready to start with its saved workflow settings.</Text>
            </Surface>
          )}
          <Surface variant="panel" padding="lg" className="xl:sticky xl:top-24">
            <Kicker icon={WandSparkles}>Ready to create</Kicker>
            <Text as="h2" variant="cardTitle" className="mt-3">Start the workflow</Text>
            <Text variant="bodySm" className="mt-2">
              Your uploads are saved first, then the opening generation begins automatically. You can leave after it starts.
            </Text>
            <dl className="mt-5 divide-y divide-white/8 rounded-2xl border border-amber-300/15 bg-amber-400/[0.06] px-4">
              <div className="flex items-center justify-between gap-3 py-3.5">
                <dt className="text-sm font-semibold text-zinc-300">Estimated total</dt>
                <dd className="text-right text-sm font-bold text-amber-100">{formatCredits(estimatedTotalCredits)}</dd>
              </div>
              {credits !== null ? (
                <div className="flex items-center justify-between gap-3 py-3.5">
                  <dt className="text-sm font-semibold text-zinc-300">Your balance</dt>
                  <dd className={creditShortfall > 0 ? 'text-right text-sm font-bold text-rose-200' : 'text-right text-sm font-bold text-zinc-100'}>
                    {credits} credits
                  </dd>
                </div>
              ) : null}
            </dl>

            {creditShortfall > 0 ? (
              <div className="mt-4">
                <StatusCallout
                  tone="warning"
                  title={`You need ${creditShortfall} more credits`}
                  body="Add credits before starting so the workflow does not stop partway through."
                />
                <Button href="/pricing" variant="primary" icon={CircleDollarSign} className="mt-3 w-full">
                  Add credits
                </Button>
              </div>
            ) : null}

            {busyAction?.type === 'uploading' || busyAction?.type === 'starting' ? (
              <StatusCallout
                tone="info"
                title={busyAction.type === 'uploading' ? 'Uploading your media privately…' : 'Uploads saved. Starting the first step…'}
                body="Keep this page open until the workflow progress appears."
                className="mt-4"
              />
            ) : null}

            <Button
              variant="accent"
              accent={template?.outputKind || 'workflow'}
              icon={isBusy || isInputValidating ? Loader2 : Sparkles}
              disabled={!inputReady || isBusy || isInputValidating || creditShortfall > 0}
              onClick={handleUploadAndStart}
              className="mt-5 w-full"
            >
              {isInputValidating
                ? 'Checking files…'
                : busyAction?.type === 'uploading'
                  ? 'Uploading media…'
                  : busyAction?.type === 'starting'
                    ? 'Starting first step…'
                    : Object.values(inputFiles).some(Boolean)
                      ? 'Upload & start'
                      : 'Start workflow'}
            </Button>
            {isInputValidating ? (
              <Text variant="caption" className="mt-3 text-center text-sky-100" as="p">
                Checking image format and dimensions before upload…
              </Text>
            ) : !inputReady ? (
              <Text variant="caption" className="mt-3 text-center text-amber-100" as="p">
                Add {missingRequiredSlots.map((slot) => slot.label).join(' and ')} to continue.
              </Text>
            ) : creditShortfall === 0 && !isBusy ? (
              <Text variant="caption" className="mt-3 text-center" as="p">
                {estimatedTotalCredits !== null
                  ? `Starting may use up to ${estimatedTotalCredits} credits. You only pay for generations that begin.`
                  : 'The final cost is calculated from the generations that begin.'}
              </Text>
            ) : null}
            <div className="mt-4 flex items-center justify-center gap-2 text-center text-xs font-semibold text-zinc-500">
              <LockKeyhole className="h-3.5 w-3.5 text-zinc-500" aria-hidden />
              <span>Uploads stay private from the template creator.</span>
            </div>
          </Surface>
        </div>
      ) : null}

      {run.status !== 'collecting_inputs' && !result ? (
        <div className="space-y-6">
          {run.steps.length > 0 ? (
            <section className="mx-auto max-w-6xl" aria-labelledby="template-run-steps-heading">
              <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <Kicker>{runEnded ? 'Run history' : attentionSteps.length > 0 ? 'Action needed' : 'Workflow progress'}</Kicker>
                  <Text as="h2" variant="cardTitle" className="mt-2">
                    <span id="template-run-steps-heading">
                      {runEnded
                        ? 'What happened in this run'
                        : attentionSteps.length > 0
                          ? 'Continue from the step that needs you'
                          : 'Your generation steps'}
                    </span>
                  </Text>
                </div>
                {runEnded ? (
                  <Text variant="caption" className="max-w-md sm:text-right">
                    Review the last step below, then start a fresh run when you are ready.
                  </Text>
                ) : attentionSteps.length > 0 ? (
                  <Text variant="caption" className="max-w-md sm:text-right">
                    Steps requiring approval or retry are shown first. Completed work remains saved.
                  </Text>
                ) : null}
              </div>
              <div className="space-y-5">
                {orderedSteps.map((step) => (
                  <TemplateRunStepCard
                    key={step.id}
                    step={step}
                    disabled={isBusy}
                    availableCredits={credits}
                    retryEnabled={!isRunTerminal(run.status)}
                    busyAction={busyAction?.stepId === step.id
                      ? busyAction.type === 'retrying'
                        ? 'retry'
                        : busyAction.type === 'approving'
                          ? 'approve'
                          : null
                      : null}
                    restartHref={isTestRun ? testReturnHref : createAnotherHref}
                    restartLabel={isTestRun ? 'Back to workflow canvas' : 'Start a new run'}
                    onApprove={() => void handleApproveStep(step)}
                    onRetry={() => void handleRetryStep(step)}
                  />
                ))}
              </div>
            </section>
          ) : run.status === 'needs_attention' ? (
            <Surface variant="panel" padding="lg" className="mx-auto max-w-2xl text-center">
              <X className="mx-auto h-10 w-10 text-rose-300" aria-hidden />
              <Text as="h2" variant="cardTitle" className="mt-4">We could not identify the step to retry</Text>
              <Text variant="bodySm" className="mx-auto mt-2 max-w-lg">
                Your inputs remain saved. Return to the canvas if this is a test, or begin a new run to continue.
              </Text>
              <Button
                href={isTestRun ? testReturnHref : createAnotherHref}
                variant="primary"
                icon={isTestRun ? ArrowLeft : RotateCcw}
                iconPosition={isTestRun ? 'start' : 'end'}
                className="mt-5"
              >
                {isTestRun ? 'Back to workflow canvas' : 'Start a new run'}
              </Button>
            </Surface>
          ) : !isRunTerminal(run.status) ? <BusyRun /> : null}

          {shouldPollTemplateRun(run) ? (
            <Surface variant="soft" padding="lg" className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Kicker icon={Loader2}>Run in progress</Kicker>
                <Text variant="bodySm" className="mt-2">You can leave this page. Your progress is saved and will resume here.</Text>
              </div>
              <Button href={isTestRun ? testReturnHref : '/templates'} variant="secondary" icon={ArrowRight}>
                {isTestRun ? 'Return to canvas' : 'Browse templates'}
              </Button>
            </Surface>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
          <Surface variant="panel" padding="none" className="overflow-hidden">
            <MediaFrame aspectRatio={result.kind === 'video' ? '16 / 10' : '4 / 5'} className="rounded-none border-0">
              {result.kind === 'video' ? (
                <video src={result.url} controls playsInline className="h-full w-full bg-black object-contain">
                  Your browser does not support video playback.
                </video>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={result.url} alt={`${run.templateTitle} result`} className="h-full w-full bg-black object-contain" />
              )}
            </MediaFrame>
          </Surface>
          <Surface variant="panel" padding="lg">
            <Pill accent="workflow" icon={Check}>Complete</Pill>
            <Text as="h2" variant="sectionTitle" className="mt-4">Your {result.kind} is ready</Text>
            <Text variant="bodySm" className="mt-2">The final result remains attached to this resumable run.</Text>
            {isTestRun ? (
              <Button href={testReturnHref} variant="primary" icon={ArrowRight} className="mt-6 w-full">Back to workflow canvas</Button>
            ) : (
              <>
                {publishedPost ? (
                  <div className="mt-6">
                    <StatusCallout
                      tone="success"
                      title={publishedPost.visibility === 'public' ? 'Published to Showcase' : 'Saved as a private post'}
                      body={publishedPost.visibility === 'public'
                        ? 'Your final template result is now visible in Showcase.'
                        : 'Only you can open this post until you publish it publicly.'}
                    />
                    <Button href={publishedPost.path} variant="primary" icon={ArrowRight} className="mt-3 w-full">
                      {publishedPost.visibility === 'public' ? 'View in Showcase' : 'Open private post'}
                    </Button>
                  </div>
                ) : result.generationId ? (
                  <Button
                    variant="primary"
                    icon={Share2}
                    onClick={() => setIsPublishOpen(true)}
                    className="mt-6 w-full"
                  >
                    Publish to Showcase
                  </Button>
                ) : null}
                <a href={result.url} download className={`${publishedPost ? 'mt-3' : result.generationId ? 'mt-3' : 'mt-6'} ui-button ui-button-secondary ui-focus-ring w-full`}>
                  <Download className="h-4 w-4" aria-hidden />
                  Download {result.kind}
                </a>
                <Button variant="secondary" icon={Share2} onClick={handleShare} className="mt-3 w-full">
                  {publishedPost?.visibility === 'public' ? 'Share Showcase post' : `Share ${result.kind}`}
                </Button>
                <Button href={createAnotherHref} variant="ghost" icon={RotateCcw} className="mt-2 w-full">Create another version</Button>
              </>
            )}
            {shareFeedback ? (
              <div role="status" aria-live="polite">
                <Text variant="caption" className="mt-3 text-center">{shareFeedback}</Text>
              </div>
            ) : null}
          </Surface>
        </div>
      ) : null}

      {(run.status === 'failed' || run.status === 'cancelled') && !result ? (
        <Surface variant="panel" padding="lg" className="mx-auto mt-6 max-w-2xl text-center">
          {run.status === 'failed' ? <X className="mx-auto h-10 w-10 text-rose-300" aria-hidden /> : <ImageIcon className="mx-auto h-10 w-10 text-zinc-400" aria-hidden />}
          <Text as="h2" variant="sectionTitle" className="mt-4">{statusCopy.title}</Text>
          <Text variant="bodySm" className="mx-auto mt-2 max-w-lg">{statusCopy.body}</Text>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {isTestRun ? (
              <Button href={testReturnHref} variant="primary" icon={ArrowLeft} iconPosition="start">
                Back to workflow canvas
              </Button>
            ) : (
              <>
                <Button href="/templates" variant="secondary" icon={ArrowLeft} iconPosition="start">Browse templates</Button>
                <Button href={createAnotherHref} variant="primary" icon={RotateCcw}>Start again</Button>
              </>
            )}
          </div>
        </Surface>
      ) : null}

      {!isTestRun && result?.generationId ? (
        <PublishToShowcaseModal
          isOpen={isPublishOpen}
          onClose={() => setIsPublishOpen(false)}
          generationId={result.generationId}
          accessToken={session?.access_token ?? null}
          defaultTitle={template?.name || run.templateTitle}
          defaultDescription=""
          showPaidShortcut={false}
          mediaOnly
          onPublished={(payload) => {
            const visibility = payload.visibility ?? 'private';
            const stablePath = payload.showcasePath
              ?? payload.ownerPath
              ?? (payload.postId
                ? visibility === 'public'
                  ? `/showcase/${payload.postId}`
                  : `/post/${payload.postId}/edit`
                : null);
            if (stablePath) {
              setPublishedPost({ path: stablePath, visibility });
            }
          }}
        />
      ) : null}
    </TemplatePageShell>
  );
}
