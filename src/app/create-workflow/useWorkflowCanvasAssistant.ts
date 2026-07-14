'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { WorkflowCanvasRecord, WorkflowCanvasGraph } from '@/lib/workflow-canvas';
import {
  getWorkflowAssistantPreviewNodeStates,
  WORKFLOW_ASSISTANT_SETUP_ERROR_CODE,
  type WorkflowCanvasAssistantMessageRecord,
  type WorkflowCanvasAssistantProposalRecord,
  type WorkflowAssistantAvailability,
  type WorkflowCanvasAssistantState,
} from '@/lib/workflow-assistant-client';

type PersistCanvasResult = {
  status: 'saved' | 'noop' | 'conflict' | 'failed';
};

interface UseWorkflowCanvasAssistantOptions {
  activeCanvasId: string | null;
  activeCanvasRevision: number;
  authHeaders: () => Promise<Record<string, string>>;
  canvasTitle: string;
  graph: WorkflowCanvasGraph;
  hasUnsavedChanges: boolean;
  onApplyCanvas: (canvas: WorkflowCanvasRecord) => void;
  onPersistCanvas: (
    title?: string,
    graph?: WorkflowCanvasGraph
  ) => Promise<PersistCanvasResult>;
  onUpdateCredits: (nextCredits: number | null) => void;
}

interface AssistantStateResponse extends WorkflowCanvasAssistantState {
  remainingCredits?: number | null;
  canvas?: WorkflowCanvasRecord;
}

class WorkflowAssistantRequestError extends Error {
  code: string | null;
  setupMessage: string | null;

  constructor(message: string, options?: { code?: string | null; setupMessage?: string | null }) {
    super(message);
    this.name = 'WorkflowAssistantRequestError';
    this.code = options?.code ?? null;
    this.setupMessage = options?.setupMessage ?? null;
  }
}

async function readAssistantResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) {
    throw new WorkflowAssistantRequestError(
      data.error || 'Workflow assistant request failed.',
      {
        code: typeof data.code === 'string' ? data.code : null,
        setupMessage: typeof data.setupMessage === 'string' ? data.setupMessage : null,
      }
    );
  }

  return data as AssistantStateResponse;
}

export function useWorkflowCanvasAssistant({
  activeCanvasId,
  activeCanvasRevision,
  authHeaders,
  canvasTitle,
  graph,
  hasUnsavedChanges,
  onApplyCanvas,
  onPersistCanvas,
  onUpdateCredits,
}: UseWorkflowCanvasAssistantOptions) {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<WorkflowCanvasAssistantMessageRecord[]>([]);
  const [proposal, setProposal] = useState<WorkflowCanvasAssistantProposalRecord | null>(null);
  const [availability, setAvailability] = useState<WorkflowAssistantAvailability>('ready');
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);

  const loadAssistantState = useCallback(async () => {
    if (!activeCanvasId) {
      setMessages([]);
      setProposal(null);
      setAvailability('ready');
      setSetupMessage(null);
      setIsPreviewOpen(false);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/workflow-canvases/${activeCanvasId}/assistant`, {
        headers: await authHeaders(),
      });
      const data = await readAssistantResponse(response);
      setMessages(data.messages ?? []);
      setProposal(data.proposal ?? null);
      setAvailability(data.availability ?? 'ready');
      setSetupMessage(data.setupMessage ?? null);
      if (data.proposal?.status === 'ready') {
        setIsOpen(true);
        setIsPreviewOpen(true);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load workflow assistant state.');
      setMessages([]);
      setProposal(null);
      setAvailability('ready');
      setSetupMessage(null);
      setIsPreviewOpen(false);
    } finally {
      setIsLoading(false);
    }
  }, [activeCanvasId, authHeaders]);

  useEffect(() => {
    // The composer belongs to the active canvas and must not leak between canvases.
    setInput('');
    void loadAssistantState();
  }, [loadAssistantState]);

  const sendMessage = useCallback(async () => {
    if (!activeCanvasId) {
      return;
    }

    if (availability !== 'ready') {
      return;
    }

    const nextInput = input.trim();
    if (!nextInput) {
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (hasUnsavedChanges) {
        const saveResult = await onPersistCanvas(canvasTitle, graph);
        if (saveResult.status !== 'saved' && saveResult.status !== 'noop') {
          throw new Error('Save your workflow changes before generating a new assistant proposal.');
        }
      }

      const response = await fetch(`/api/workflow-canvases/${activeCanvasId}/assistant/messages`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({ content: nextInput }),
      });

      const data = await readAssistantResponse(response);
      setMessages(data.messages ?? []);
      setProposal(data.proposal ?? null);
      setAvailability(data.availability ?? 'ready');
      setSetupMessage(data.setupMessage ?? null);
      setInput('');
      setIsOpen(true);
      setIsPreviewOpen(Boolean(data.proposal?.status === 'ready'));

      if (typeof data.remainingCredits === 'number') {
        onUpdateCredits(data.remainingCredits);
      }
    } catch (submitError) {
      if (
        submitError instanceof WorkflowAssistantRequestError &&
        submitError.code === WORKFLOW_ASSISTANT_SETUP_ERROR_CODE
      ) {
        setAvailability('setup_required');
        setSetupMessage(submitError.setupMessage ?? submitError.message);
        setError(null);
      } else {
        setError(submitError instanceof Error ? submitError.message : 'Failed to generate workflow proposal.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [
    activeCanvasId,
    availability,
    authHeaders,
    canvasTitle,
    graph,
    hasUnsavedChanges,
    input,
    onPersistCanvas,
    onUpdateCredits,
  ]);

  const applyProposal = useCallback(async () => {
    if (!activeCanvasId || !proposal) {
      return;
    }

    setIsApplying(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/workflow-canvases/${activeCanvasId}/assistant/proposals/${proposal.id}/apply`,
        {
          method: 'POST',
          headers: await authHeaders(),
        }
      );
      const data = await response.json();

      if (response.status === 409) {
        if (data.canvas) {
          onApplyCanvas(data.canvas);
        }
        setProposal(null);
        setIsPreviewOpen(false);
        setError(data.error || 'This proposal is stale. The workflow has been refreshed to the latest saved canvas.');
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to apply assistant proposal.');
      }

      if (data.canvas) {
        onApplyCanvas(data.canvas);
      }
      setProposal(null);
      setIsPreviewOpen(false);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Failed to apply assistant proposal.');
    } finally {
      setIsApplying(false);
    }
  }, [activeCanvasId, authHeaders, onApplyCanvas, proposal]);

  const discardProposal = useCallback(async () => {
    if (!activeCanvasId || !proposal) {
      return;
    }

    setIsDiscarding(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/workflow-canvases/${activeCanvasId}/assistant/proposals/${proposal.id}/discard`,
        {
          method: 'POST',
          headers: await authHeaders(),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to discard assistant proposal.');
      }

      setProposal(null);
      setIsPreviewOpen(false);
    } catch (discardError) {
      setError(discardError instanceof Error ? discardError.message : 'Failed to discard assistant proposal.');
    } finally {
      setIsDiscarding(false);
    }
  }, [activeCanvasId, authHeaders, proposal]);

  const isProposalReady = proposal?.status === 'ready';
  const previewGraph = useMemo(
    () => (isProposalReady && isPreviewOpen ? proposal.proposed_graph : null),
    [isPreviewOpen, isProposalReady, proposal]
  );
  const previewNodeStates = useMemo(
    () => getWorkflowAssistantPreviewNodeStates(proposal?.diff),
    [proposal?.diff]
  );
  const isProposalStale = Boolean(proposal && proposal.base_revision !== activeCanvasRevision);

  return {
    availability,
    closeAssistant: () => {
      setIsOpen(false);
      setIsPreviewOpen(false);
    },
    discardProposal,
    error,
    input,
    isApplying,
    isDiscarding,
    isLoading,
    isOpen,
    isProposalReady,
    isProposalStale,
    isPreviewOpen,
    isSubmitting,
    messages,
    openAssistant: () => {
      setIsOpen(true);
      if (proposal?.status === 'ready') {
        setIsPreviewOpen(true);
      }
    },
    previewGraph,
    previewNodeStates,
    proposal,
    reloadAssistantState: loadAssistantState,
    setupMessage,
    sendMessage,
    setInput,
    setIsOpen,
    setIsPreviewOpen,
    applyProposal,
  };
}
