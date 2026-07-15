import type { WorkflowCanvasStatus } from '@/lib/workflow-canvas';

export const WORKFLOW_CANVAS_LIST_SELECT = 'id,title,library_summary,updated_at,revision,status,published_at';
export const WORKFLOW_CANVAS_LIST_SELECT_WITH_GRAPH = 'id,title,graph,updated_at,revision,status,published_at';
export const WORKFLOW_CANVAS_LIST_SELECT_LEGACY = 'id,title,graph,updated_at,revision';
export const WORKFLOW_CANVAS_SELECT = 'id,title,graph,created_at,updated_at,revision,status,published_at';
export const WORKFLOW_CANVAS_SELECT_LEGACY = 'id,title,graph,created_at,updated_at,revision';

type SupabaseLikeError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

export function withWorkflowCanvasLifecycleDefaults<T extends Record<string, unknown>>(row: T): T & {
  status: WorkflowCanvasStatus;
  published_at: string | null;
} {
  const normalizedStatus = row.status === 'published' ? 'published' : 'draft';
  const normalizedPublishedAt = typeof row.published_at === 'string' ? row.published_at : null;

  return {
    ...row,
    status: normalizedStatus,
    published_at: normalizedPublishedAt,
  };
}

function getSupabaseErrorText(error: SupabaseLikeError | null | undefined) {
  return [
    error?.code,
    error?.message,
    error?.details,
    error?.hint,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function isMissingWorkflowLifecycleColumnsError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const normalizedError = error as SupabaseLikeError;
  const text = getSupabaseErrorText(normalizedError);

  return (
    (
      normalizedError.code === '42703' ||
      normalizedError.code === 'PGRST204' ||
      normalizedError.code === 'pgrst204'
    ) &&
    (
      text.includes('status') ||
      text.includes('published_at')
    )
  );
}

export function isMissingWorkflowLibrarySummaryColumnError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const normalizedError = error as SupabaseLikeError;
  const text = getSupabaseErrorText(normalizedError);
  return (
    (
      normalizedError.code === '42703'
      || normalizedError.code === 'PGRST204'
      || normalizedError.code === 'pgrst204'
    )
    && text.includes('library_summary')
  );
}

export function isMissingWorkflowCanvasHistorySchemaError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const normalizedError = error as SupabaseLikeError;
  const text = getSupabaseErrorText(normalizedError);

  return (
    normalizedError.code === '42P01' ||
    normalizedError.code === '42p01' ||
    text.includes('workflow_canvas_history')
  );
}

export function isMissingWorkflowCanvasAssistantSchemaError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const normalizedError = error as SupabaseLikeError;
  const text = getSupabaseErrorText(normalizedError);

  return (
    normalizedError.code === '42P01' ||
    normalizedError.code === '42p01' ||
    (
      (
        normalizedError.code === '42883' ||
        normalizedError.code === 'PGRST202' ||
        normalizedError.code === 'pgrst202'
      ) && text.includes('apply_workflow_canvas_assistant_proposal')
    ) ||
    text.includes('workflow_canvas_assistant_messages') ||
    text.includes('workflow_canvas_assistant_proposals')
  );
}
