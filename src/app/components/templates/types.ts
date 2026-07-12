import type { GenerationStartFailureCode } from '@/lib/generation-public-failure';

export type TemplateStatus = 'draft' | 'active' | 'disabled';
export type TemplateMediaKind = 'image' | 'video';

export type TemplateInputSlot = {
  key: string;
  kind: TemplateMediaKind;
  label: string;
  description?: string;
  required: boolean;
};

export type TemplateCreator = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

/** Public template manifest. It intentionally contains no graph, prompt, or model data. */
export type MediaTemplate = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  videoUrl: string | null;
  thumbnailUrl: string | null;
  creatorUserId: string | null;
  creator: TemplateCreator | null;
  inputSlots: TemplateInputSlot[];
  outputKind: TemplateMediaKind;
  status: TemplateStatus;
  useCount: number;
  estimatedTotalCredits: number | null;
  createdAt: string;
  updatedAt: string;
};

export type TemplateRunStatus =
  | 'collecting_inputs'
  | 'queued'
  | 'processing'
  // Legacy statuses are normalized at the client boundary during rollout.
  | 'running'
  | 'generating_frames'
  | 'awaiting_approval'
  | 'generating_video'
  | 'succeeded'
  | 'needs_attention'
  | 'failed'
  | 'cancelled';

export type TemplateRunStepKind = 'generation' | 'approval';

export type TemplateRunStep = {
  /** Public run-step UUID. This is never a workflow graph node id. */
  id: string;
  kind: TemplateRunStepKind;
  mediaKind: TemplateMediaKind;
  status: string;
  label: string;
  outputUrl: string | null;
  errorMessage: string | null;
  failureCode: GenerationStartFailureCode | null;
  canRetry: boolean;
  estimatedRetryCredits: number | null;
};

export type TemplateRunResult = {
  generationId: string;
  kind: TemplateMediaKind;
  url: string;
};

export type TemplateRun = {
  id: string;
  templateId: string;
  templateTitle: string;
  userId: string;
  status: TemplateRunStatus;
  inputSlots: TemplateInputSlot[];
  inputs: Record<string, string>;
  steps: TemplateRunStep[];
  result: TemplateRunResult | null;
  estimatedTotalCredits: number | null;
  estimatedRemainingCredits: number | null;
  creditsUsed: number;
  errorMessage: string | null;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
};

const TERMINAL_RUN_STATUSES = new Set<TemplateRunStatus>(['succeeded', 'failed', 'cancelled']);
const BUSY_STEP_STATUSES = new Set(['queued', 'pending', 'waiting', 'running', 'processing', 'generating', 'starting']);

export function isRunTerminal(status: TemplateRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isStepSuccessful(step: TemplateRunStep): boolean {
  return ['succeeded', 'completed', 'complete', 'success', 'approved'].includes(step.status.toLowerCase());
}

export function isStepFailed(step: TemplateRunStep): boolean {
  return ['failed', 'error', 'cancelled'].includes(step.status.toLowerCase());
}

export function isStepAwaitingApproval(step: TemplateRunStep): boolean {
  return step.kind === 'approval'
    && ['awaiting_approval', 'waiting_for_approval', 'ready', 'pending_approval'].includes(step.status.toLowerCase());
}

export function isStepBusy(step: TemplateRunStep): boolean {
  return BUSY_STEP_STATUSES.has(step.status.toLowerCase());
}

export function shouldPollTemplateRun(run: TemplateRun): boolean {
  if (isRunTerminal(run.status)) return false;
  if (run.status === 'collecting_inputs' || run.status === 'awaiting_approval' || run.status === 'needs_attention') {
    return false;
  }
  return run.status === 'running'
    || run.status === 'queued'
    || run.status === 'processing'
    || run.status === 'generating_frames'
    || run.status === 'generating_video'
    || run.steps.some(isStepBusy);
}
