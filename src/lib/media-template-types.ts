import type { GenerationStartFailureCode } from '@/lib/generation-public-failure';

export type MediaTemplateStatus = 'draft' | 'active' | 'disabled';
export type TemplateMediaKind = 'image' | 'video';

export type TemplateInputSlot = {
  key: string;
  kind: TemplateMediaKind;
  label: string;
  description?: string;
  required: true;
};

export type TemplateCreator = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

/** Public catalog contract. Private graphs, prompts, model IDs, and fixed paths
 * are deliberately absent from this type. */
export type MediaTemplateDto = {
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
  outputKind: TemplateMediaKind | null;
  status: MediaTemplateStatus;
  useCount: number;
  estimatedTotalCredits: number | null;
  createdAt: string;
  updatedAt: string;
  authoring?: {
    sourceCanvasId: string | null;
    outputNodeId: string | null;
    activeVersionId: string | null;
  };
};

export type TemplateValidationIssue = {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
};

export type TemplateGraphValidationDto = {
  valid: boolean;
  issues: TemplateValidationIssue[];
  inputSlots: TemplateInputSlot[];
  outputKind: TemplateMediaKind | null;
  estimatedTotalCredits: number | null;
  graphHash: string | null;
  canvasRevision: number;
};

export type CompiledTemplateGraph = {
  graph: Record<string, unknown>;
  graphHash: string;
  outputNodeId: string;
  outputKind: TemplateMediaKind;
  inputSlots: TemplateInputSlot[];
  inputNodeIds: Record<string, string>;
  nodeCosts: Record<string, number>;
  estimatedTotalCredits: number;
  catalogRevision: string | null;
};

export type TemplateVersionSnapshot = CompiledTemplateGraph & {
  templateId: string;
  templateVersionId: string | null;
  templateTitle: string;
  sourceCanvasId: string;
  sourceCanvasRevision: number;
  demoOutputUrl: string | null;
};

export type TemplateRunStatus =
  | 'collecting_inputs'
  | 'queued'
  | 'processing'
  | 'awaiting_approval'
  | 'needs_attention'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type TemplateRunStepStatus =
  | 'queued'
  | 'processing'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type TemplateRunStepDto = {
  id: string;
  kind: 'generation' | 'approval';
  mediaKind: TemplateMediaKind;
  status: TemplateRunStepStatus;
  label: string;
  outputUrl: string | null;
  errorMessage: string | null;
  failureCode: GenerationStartFailureCode | null;
  canRetry: boolean;
  estimatedRetryCredits: number;
};

export type TemplateRunResultDto = {
  generationId: string;
  kind: TemplateMediaKind;
  url: string;
};

/** Consumer-safe run contract. Step IDs are database UUIDs; graph node IDs and
 * step snapshots never leave the backend. */
export type TemplateRunDto = {
  id: string;
  templateId: string;
  templateTitle: string;
  userId: string;
  status: TemplateRunStatus;
  inputSlots: TemplateInputSlot[];
  inputs: Record<string, string>;
  steps: TemplateRunStepDto[];
  result: TemplateRunResultDto | null;
  estimatedTotalCredits: number;
  estimatedRemainingCredits: number;
  creditsUsed: number;
  errorMessage: string | null;
  isTest: boolean;
  createdAt: string;
  updatedAt: string;
};

export class MediaTemplateError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'MediaTemplateError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
