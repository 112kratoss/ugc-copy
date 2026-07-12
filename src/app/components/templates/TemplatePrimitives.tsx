'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { useState, type ChangeEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  AlertTriangle,
  Check,
  CircleDollarSign,
  Clock3,
  Image as ImageIcon,
  Loader2,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldCheck,
  Upload,
  UserRound,
  Video,
} from 'lucide-react';

import {
  Button,
  Kicker,
  MediaFrame,
  Pill,
  StatusCallout,
  Surface,
  Text,
} from '@/app/components/DesignSystem';
import { requiresReplacementGenerationInput } from '@/lib/generation-public-failure';

import type {
  MediaTemplate,
  TemplateInputSlot,
  TemplateRunStatus,
  TemplateRunStep,
} from './types';
import {
  isStepAwaitingApproval,
  isStepBusy,
  isStepFailed,
  isStepSuccessful,
} from './types';

export function TemplatePageShell({ children }: { children: ReactNode }) {
  return (
    <div className="ui-page ui-page-ambient min-h-screen py-7 text-[var(--ui-text-primary)] sm:py-10">
      <div className="studio-shell relative z-10">{children}</div>
    </div>
  );
}

export function getTemplateCreatorLabel(template: MediaTemplate): string {
  return template.creator?.displayName || template.creator?.username || 'Community creator';
}

function inputSummary(slots: TemplateInputSlot[]): string {
  if (slots.length === 0) return 'No uploads';
  const imageCount = slots.filter((slot) => slot.kind === 'image').length;
  const videoCount = slots.length - imageCount;
  const labels = [
    imageCount ? `${imageCount} image${imageCount === 1 ? '' : 's'}` : '',
    videoCount ? `${videoCount} video${videoCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return labels.join(' + ');
}

export function TemplateCard({
  template,
  mode = 'public',
}: {
  template: MediaTemplate;
  mode?: 'public' | 'owner';
}) {
  const href = mode === 'owner'
    ? `/templates/${template.id}/edit`
    : `/templates/${template.slug || template.id}`;
  const creatorLabel = getTemplateCreatorLabel(template);
  const OutputIcon = template.outputKind === 'video' ? Video : ImageIcon;

  return (
    <Link href={href} className="ui-card ui-card-interactive ui-focus-ring group flex h-full flex-col overflow-hidden rounded-3xl">
      <MediaFrame aspectRatio="4 / 5" className="relative rounded-none border-0 border-b border-white/8">
        {template.videoUrl ? (
          <video
            src={template.videoUrl}
            poster={template.thumbnailUrl || undefined}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
            aria-label={`${template.name} demo`}
          />
        ) : template.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={template.thumbnailUrl} alt={`${template.name} preview`} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_70%_10%,rgba(244,63,94,0.26),transparent_36%),linear-gradient(145deg,#211318,#08090c)]">
            <OutputIcon className="h-12 w-12 text-rose-100/70" aria-hidden />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />
        <div className="absolute left-4 top-4">
          <Pill accent={template.outputKind} icon={mode === 'owner' ? OutputIcon : Play}>
            {mode === 'owner' ? template.status : `${template.outputKind} template`}
          </Pill>
        </div>
        <div className="absolute bottom-4 left-4 right-4 flex items-end justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-white/75">
            <UserRound className="h-3.5 w-3.5" aria-hidden />
            <span className="truncate">{creatorLabel}</span>
          </div>
          <span className="rounded-full border border-white/15 bg-black/45 px-2.5 py-1 text-xs font-bold text-white backdrop-blur-sm">
            {inputSummary(template.inputSlots)}
          </span>
        </div>
      </MediaFrame>

      <div className="flex flex-1 flex-col p-5">
        <Kicker>{template.category || 'Creative'}</Kicker>
        <Text as="h2" variant="cardTitle" className="mt-2 line-clamp-2">{template.name}</Text>
        <Text variant="bodySm" className="mt-2 line-clamp-2">
          {template.description || `Add your media and create a new ${template.outputKind}.`}
        </Text>
        <div className="mt-4 flex items-center gap-3 border-t border-white/8 pt-4">
          <div className="text-xs font-semibold text-zinc-400">
            {template.useCount.toLocaleString()} {template.useCount === 1 ? 'use' : 'uses'}
          </div>
          {mode === 'public' && template.estimatedTotalCredits !== null ? (
            <div className="ml-auto inline-flex items-center gap-1.5 text-xs font-bold text-amber-100">
              <CircleDollarSign className="h-3.5 w-3.5" aria-hidden />
              {template.estimatedTotalCredits} credits
            </div>
          ) : null}
          <span className={clsx('inline-flex items-center gap-1 text-sm font-bold text-white', mode !== 'public' && 'ml-auto')}>
            {mode === 'owner' ? 'Open canvas' : 'View'}
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </span>
        </div>
      </div>
    </Link>
  );
}

export function TemplateRunStepper({
  status,
  steps,
}: {
  status: TemplateRunStatus;
  steps: TemplateRunStep[];
}) {
  const items = [
    {
      id: 'inputs',
      label: 'Add inputs',
      complete: status !== 'collecting_inputs',
      active: status === 'collecting_inputs',
      tone: 'input' as const,
    },
    ...steps.map((step) => ({
      id: step.id,
      label: step.label,
      complete: isStepSuccessful(step),
      active: isStepBusy(step) || isStepAwaitingApproval(step) || isStepFailed(step),
      tone: isStepFailed(step)
        ? 'failed' as const
        : isStepAwaitingApproval(step)
          ? 'approval' as const
          : 'generation' as const,
    })),
  ];
  const completed = items.filter((item) => item.complete).length;
  const currentItem = items.find((item) => item.active && !item.complete);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-zinc-400">
          {status === 'collecting_inputs' ? 'Ready for your media' : `${completed} of ${items.length} steps complete`}
        </span>
        <span className="min-w-0 truncate text-right text-xs font-bold text-zinc-200">
          {status === 'cancelled'
            ? 'Cancelled'
            : status === 'failed'
              ? 'Stopped'
              : currentItem
                ? `Current: ${currentItem.label}`
                : status === 'succeeded'
                  ? 'Complete'
                  : 'Waiting to continue'}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Template progress"
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={completed}
        aria-valuetext={`${completed} of ${items.length} steps complete${currentItem ? `. Current step: ${currentItem.label}` : ''}`}
        className="flex gap-2"
      >
        {items.map((item) => (
          <div
            key={item.id}
            title={item.label}
            className={clsx(
              'h-1.5 min-w-3 flex-1 rounded-full transition-colors',
              item.complete && 'bg-emerald-400',
              item.active && !item.complete && item.tone === 'failed' && 'bg-rose-400',
              item.active && !item.complete && item.tone === 'approval' && 'bg-amber-300',
              item.active && !item.complete && (item.tone === 'generation' || item.tone === 'input') && 'bg-sky-400',
              !item.complete && !item.active && 'bg-white/10'
            )}
          />
        ))}
      </div>
    </div>
  );
}

export function TemplateSlotUpload({
  slot,
  file,
  previewUrl,
  stored,
  disabled,
  validating = false,
  error,
  onChange,
}: {
  slot: TemplateInputSlot;
  file: File | null;
  previewUrl: string | null;
  stored: boolean;
  disabled?: boolean;
  validating?: boolean;
  error?: string | null;
  onChange: (file: File | null) => void;
}) {
  const inputId = `template-input-${slot.key}`;
  const descriptionId = `${inputId}-description`;
  const requirementsId = `${inputId}-requirements`;
  const errorId = `${inputId}-error`;
  const SlotIcon = slot.kind === 'video' ? Video : ImageIcon;
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.target.files?.[0] ?? null);
    event.target.value = '';
  };

  return (
    <Surface
      variant="soft"
      padding="none"
      className={clsx(
        'overflow-hidden',
        stored && !file && !error && 'border-emerald-300/20',
        error && 'border-rose-300/30'
      )}
    >
      <div className="relative aspect-[16/10] bg-black/45 sm:aspect-[4/3]">
        {previewUrl && slot.kind === 'video' ? (
          <video src={previewUrl} muted controls playsInline className="h-full w-full object-contain" aria-label={`${slot.label} preview`} />
        ) : previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt={`${slot.label} preview`} className="h-full w-full object-cover" />
        ) : stored ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-emerald-200">
            <Check className="h-9 w-9" aria-hidden />
            <span className="text-sm font-bold">Uploaded securely</span>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-300/20 bg-sky-400/10 text-sky-200">
              <SlotIcon className="h-5 w-5" aria-hidden />
            </div>
            <span className="text-sm font-semibold text-zinc-300">
              Choose {slot.kind === 'image' ? 'an' : 'a'} {slot.kind}
            </span>
          </div>
        )}
        {file ? (
          <div className="absolute inset-x-3 bottom-3 truncate rounded-full border border-white/15 bg-black/65 px-3 py-2 text-xs font-semibold text-white backdrop-blur-sm">
            {file.name}
          </div>
        ) : null}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <Text as="h3" variant="cardTitle" className="text-base">{slot.label}</Text>
          <Pill accent="neutral">{slot.required ? 'Required' : 'Optional'}</Pill>
        </div>
        <div id={descriptionId}>
          <Text variant="bodySm" className="mt-1 min-h-12" as="p">
            {slot.description || `Choose a clear ${slot.kind} that matches this step.`}
          </Text>
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs font-semibold" aria-live="polite">
          {validating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-200 motion-reduce:animate-none" aria-hidden />
              <span className="text-sky-100">Checking file quality…</span>
            </>
          ) : file ? (
            <>
              <Clock3 className="h-3.5 w-3.5 shrink-0 text-sky-200" aria-hidden />
              <span className="text-sky-100">Ready to upload when you start</span>
            </>
          ) : stored ? (
            <>
              <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-emerald-200" aria-hidden />
              <span className="text-emerald-100">Stored privately for this run</span>
            </>
          ) : (
            <>
              <Upload className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
              <span className="text-zinc-400">Not uploaded yet</span>
            </>
          )}
        </div>
        {error ? (
          <div id={errorId} role="alert" className="mt-3 flex gap-2 rounded-xl border border-rose-300/20 bg-rose-400/[0.07] p-3 text-xs font-semibold leading-5 text-rose-100">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        ) : null}
        <div id={requirementsId}>
          <Text variant="caption" className="mt-3" as="p">
            {slot.kind === 'image'
              ? 'JPEG, PNG or WebP · at least 256 × 256 px · up to 30 MB'
              : 'MP4, WebM or MOV · up to 100 MB'}
          </Text>
        </div>
        <input
          id={inputId}
          type="file"
          accept={slot.kind === 'video' ? 'video/mp4,video/webm,video/quicktime' : 'image/jpeg,image/png,image/webp'}
          className="peer sr-only"
          disabled={disabled || validating}
          aria-invalid={Boolean(error)}
          aria-describedby={`${descriptionId} ${requirementsId}${error ? ` ${errorId}` : ''}`}
          onChange={handleChange}
        />
        <label
          htmlFor={inputId}
          className={clsx(
            'ui-button ui-button-secondary mt-4 w-full cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-rose-200/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-black',
            (disabled || validating) && 'pointer-events-none opacity-55'
          )}
        >
          <Upload className="h-4 w-4" aria-hidden />
          {file || stored ? `Replace ${slot.kind}` : `Choose ${slot.kind}`}
        </label>
        {file ? (
          <button
            type="button"
            disabled={disabled || validating}
            onClick={() => onChange(null)}
            className="ui-focus-ring mt-2 min-h-11 w-full rounded-xl px-3 text-xs font-bold text-zinc-400 transition hover:bg-white/[0.04] hover:text-white disabled:opacity-55"
          >
            Remove selection
          </button>
        ) : null}
      </div>
    </Surface>
  );
}

function StepMedia({ step }: { step: TemplateRunStep }) {
  if (step.outputUrl && step.mediaKind === 'video') {
    return <video src={step.outputUrl} controls playsInline preload="metadata" className="h-full w-full bg-black object-contain" />;
  }
  if (step.outputUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={step.outputUrl} alt={step.label} className="h-full w-full object-contain" />;
  }
  if (isStepFailed(step)) {
    return (
      <div className="flex h-full min-h-52 flex-col items-center justify-center gap-3 px-6 text-center text-rose-100">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-300/20 bg-rose-400/10">
          <AlertTriangle className="h-5 w-5" aria-hidden />
        </div>
        <span className="text-sm font-bold">No result was created</span>
        <span className="max-w-xs text-xs font-medium leading-5 text-zinc-400">Your uploads and completed steps are still saved.</span>
      </div>
    );
  }
  const Icon = step.mediaKind === 'video' ? Video : ImageIcon;
  const waitingLabel = isStepBusy(step)
    ? 'Creating your result…'
    : isStepAwaitingApproval(step)
      ? 'Ready for your review'
      : 'Waiting for an earlier step';
  return (
    <div className="flex h-full min-h-52 flex-col items-center justify-center gap-3 px-6 text-center text-zinc-300" role="status">
      <div className="relative">
        <Icon className="h-8 w-8 text-rose-100" aria-hidden />
        {isStepBusy(step) ? <Loader2 className="absolute -right-4 -top-4 h-5 w-5 animate-spin text-white motion-reduce:animate-none" aria-hidden /> : null}
      </div>
      <span className="text-sm font-semibold">{waitingLabel}</span>
      {!isStepBusy(step) && !isStepAwaitingApproval(step) ? (
        <span className="max-w-xs text-xs font-medium leading-5 text-zinc-500">This begins automatically when the previous step finishes.</span>
      ) : null}
    </div>
  );
}

function stepPill(step: TemplateRunStep): { label: string; accent: 'workflow' | 'video' | 'neutral' | 'commerce' } {
  if (isStepSuccessful(step)) return { label: step.kind === 'approval' ? 'Approved' : 'Complete', accent: 'workflow' };
  if (isStepAwaitingApproval(step)) return { label: 'Review', accent: 'commerce' };
  if (isStepFailed(step)) return { label: 'Needs attention', accent: 'video' };
  if (isStepBusy(step)) return { label: 'In progress', accent: 'video' };
  return { label: step.status.replaceAll('_', ' '), accent: 'neutral' };
}

export function TemplateRunStepCard({
  step,
  disabled,
  availableCredits,
  busyAction,
  retryEnabled = true,
  restartHref,
  restartLabel = 'Start a new run',
  onApprove,
  onRetry,
}: {
  step: TemplateRunStep;
  disabled?: boolean;
  availableCredits?: number | null;
  busyAction?: 'approve' | 'retry' | null;
  retryEnabled?: boolean;
  restartHref?: string;
  restartLabel?: string;
  onApprove: () => void;
  onRetry: () => void;
}) {
  const [confirmingRetry, setConfirmingRetry] = useState(false);
  const status = stepPill(step);
  const showApprove = isStepAwaitingApproval(step);
  const isFailed = isStepFailed(step);
  const isServiceMisconfigured = isFailed && step.failureCode === 'service_misconfigured';
  const requiresNewInput = isFailed && requiresReplacementGenerationInput({
    code: step.failureCode,
    message: step.errorMessage,
  });
  const showRetry = step.canRetry
    && retryEnabled
    && !requiresNewInput
    && (isStepAwaitingApproval(step) || isFailed);
  const mediaAspect = !step.outputUrl ? '16 / 9' : step.mediaKind === 'video' ? '16 / 10' : '4 / 5';
  const knownRetryCost = step.estimatedRetryCredits !== null ? step.estimatedRetryCredits : null;
  const missingRetryCredits = knownRetryCost !== null && availableCredits !== null && availableCredits !== undefined
    ? Math.max(0, knownRetryCost - availableCredits)
    : 0;
  const retryLabel = isServiceMisconfigured
    ? knownRetryCost !== null
      ? `Retry after setup · ${knownRetryCost} credits`
      : 'Retry after setup'
    : knownRetryCost !== null
      ? `Retry step · ${knownRetryCost} credits`
      : 'Retry this step';
  const requestRetry = () => setConfirmingRetry(true);
  const confirmRetry = () => {
    setConfirmingRetry(false);
    onRetry();
  };

  return (
    <Surface
      as="article"
      variant="card"
      padding="none"
      className={clsx(
        'overflow-hidden',
        showApprove && 'border-amber-300/30',
        isFailed && 'border-rose-300/25'
      )}
    >
      <div className="grid md:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.2fr)]">
        <MediaFrame
          aspectRatio={mediaAspect}
          className="relative rounded-none border-0 border-b border-white/8 md:!aspect-auto md:min-h-72 md:border-b-0 md:border-r"
        >
          <StepMedia step={step} />
          <Pill accent={status.accent} icon={isStepSuccessful(step) ? Check : undefined} className="absolute right-4 top-4">
            {status.label}
          </Pill>
        </MediaFrame>
        <div className="flex min-w-0 flex-col p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-zinc-200">
              {step.kind === 'approval' ? <ShieldCheck className="h-4 w-4" aria-hidden /> : step.mediaKind === 'video' ? <Video className="h-4 w-4" aria-hidden /> : <ImageIcon className="h-4 w-4" aria-hidden />}
            </div>
            <div className="min-w-0">
              <Text as="h3" variant="cardTitle" className="text-lg sm:text-xl">{step.label}</Text>
              <Text variant="caption" className="mt-1 capitalize">{step.kind} · {step.mediaKind}</Text>
            </div>
          </div>

          {isFailed ? (
            <StatusCallout
              tone="danger"
              title={isServiceMisconfigured ? 'Generation setup needs attention' : 'This generation did not finish'}
              body={step.errorMessage || 'The generation service did not return a usable result. Retry this step to continue.'}
              className="mt-5"
            />
          ) : step.errorMessage ? (
            <StatusCallout tone="warning" title="Step note" body={step.errorMessage} className="mt-5" />
          ) : null}

          {showApprove ? (
            <Text variant="bodySm" className="mt-5 text-zinc-300">
              Check the result carefully. Approving continues the workflow; retrying creates a new version of only this step.
            </Text>
          ) : isFailed ? (
            <Text variant="bodySm" className="mt-5 text-zinc-300">
              {!retryEnabled
                ? 'This run has ended. Return to the template or workflow canvas to start a fresh run.'
                : isServiceMisconfigured
                ? 'Your uploads and earlier work are safe. Ask an administrator to finish the service setup, then retry this step. Credits are only charged when generation can start.'
                : requiresNewInput
                ? 'This upload cannot be reused. Start a new run with a clear, supported replacement instead of paying to retry the same file.'
                : 'Earlier completed steps are safe. You can retry only this generation without uploading your media again.'}
            </Text>
          ) : null}

          {showRetry ? (
            <div className="mt-5 grid grid-cols-2 gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-4 text-sm">
              <div>
                <div className="text-xs font-semibold text-zinc-500">Retry cost</div>
                <div className="mt-1 font-bold text-zinc-100">{knownRetryCost !== null ? `${knownRetryCost} credits` : 'Current model rate'}</div>
              </div>
              <div>
                <div className="text-xs font-semibold text-zinc-500">Your balance</div>
                <div className={clsx('mt-1 font-bold', missingRetryCredits > 0 ? 'text-rose-200' : 'text-zinc-100')}>
                  {availableCredits !== null && availableCredits !== undefined ? `${availableCredits} credits` : 'Checking…'}
                </div>
              </div>
            </div>
          ) : null}

          <div className="mt-auto pt-5">
            {confirmingRetry ? (
              <Surface variant="soft" padding="sm" role="alert" ariaLive="polite" className="border-amber-300/20">
                <Text as="h3" variant="label" className="text-amber-100">Create a new version of this step?</Text>
                <Text variant="caption" className="mt-1">
                  {knownRetryCost !== null
                    ? `${knownRetryCost} credits may be charged. Your earlier results will stay saved.`
                    : 'The current model rate may be charged. Your earlier results will stay saved.'}
                </Text>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <Button
                    variant="primary"
                    icon={RefreshCw}
                    disabled={disabled}
                    onClick={confirmRetry}
                    className="w-full px-3"
                  >
                    Confirm retry
                  </Button>
                  <Button variant="ghost" disabled={disabled} onClick={() => setConfirmingRetry(false)} className="w-full px-3">
                    Keep current step
                  </Button>
                </div>
              </Surface>
            ) : showApprove || showRetry ? (
              <div className={clsx('grid gap-2', showApprove && showRetry && 'sm:grid-cols-2')}>
                {showApprove ? (
                  <Button
                    variant="accent"
                    accent="workflow"
                    icon={busyAction === 'approve' ? Loader2 : Check}
                    disabled={disabled}
                    onClick={onApprove}
                    className="w-full px-3"
                  >
                    {busyAction === 'approve' ? 'Approving…' : 'Approve & continue'}
                  </Button>
                ) : null}
                {showRetry && missingRetryCredits === 0 ? (
                  <Button
                    variant={isFailed ? 'primary' : 'secondary'}
                    icon={busyAction === 'retry' ? Loader2 : RefreshCw}
                    disabled={disabled}
                    onClick={requestRetry}
                    className="w-full px-3"
                  >
                    {busyAction === 'retry' ? 'Retrying…' : retryLabel}
                  </Button>
                ) : null}
                {showRetry && missingRetryCredits > 0 ? (
                  <Button href="/pricing" variant="primary" icon={CircleDollarSign} className="w-full px-3">
                    Add {missingRetryCredits} credits to retry
                  </Button>
                ) : null}
              </div>
            ) : isFailed && restartHref ? (
              <div>
                <StatusCallout
                  tone="warning"
                  title={requiresNewInput ? 'Use a new input to continue' : 'This step cannot be retried'}
                  body={requiresNewInput
                    ? 'Choose a readable JPEG, PNG, or WebP image that is at least 256 × 256 px when you start the next run.'
                    : restartLabel === 'Back to workflow canvas'
                      ? 'Return to the canvas, update the workflow, and create a new test run.'
                      : 'Start a new run to use the same template with fresh inputs.'}
                />
                <Button href={restartHref} variant="primary" icon={RefreshCw} className="mt-3 w-full">
                  {restartLabel}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Surface>
  );
}
