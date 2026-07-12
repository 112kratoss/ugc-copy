'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDollarSign,
  ExternalLink,
  Loader2,
  Play,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  createWorkflowGraphHash,
  getWorkflowNodeMediaOutputKind,
  validateWorkflowTemplateAuthoringGraph,
  type WorkflowCanvasGraph,
  type WorkflowTemplateAuthoringIssue,
  type WorkflowTemplateAuthoringValidation,
} from '@/lib/workflow-canvas';

interface RemoteTemplateValidation {
  valid: boolean;
  issues: WorkflowTemplateAuthoringIssue[];
  inputSlots: Array<{
    key: string;
    kind: 'image' | 'video';
    label: string;
    description?: string;
    required: boolean;
  }>;
  outputKind: 'image' | 'video' | null;
  estimatedTotalCredits: number | null;
  graphHash: string;
  canvasRevision: number;
}

interface TemplateAuthoringRecord {
  id: string;
  name?: string;
  description?: string | null;
  category?: string | null;
  authoring?: {
    outputNodeId?: string | null;
    sourceCanvasId?: string | null;
  } | null;
}

interface TemplateTestRun {
  id: string;
  status: string;
  errorMessage?: string | null;
  isTest?: boolean;
  templateId?: string;
}

interface TemplateTestContext {
  canvasRevision: number;
  clientPathHash: string;
  graphHash: string;
  templateId: string;
}

interface WorkflowTemplatePublishDrawerProps {
  activeCanvasId: string | null;
  activeCanvasRevision: number;
  authHeaders: () => Promise<Record<string, string>>;
  canvasTitle: string;
  catalogRevision: string | null;
  graph: WorkflowCanvasGraph;
  initialTestRunId: string | null;
  isOpen: boolean;
  outputNodeId: string | null;
  templateId: string | null;
  onClose: () => void;
  onEnsureSaved: () => Promise<number | null>;
  onFocusNode: (nodeId: string) => void;
  onOutputNodeChange: (nodeId: string | null) => void;
  onTemplateCreated: (template: TemplateAuthoringRecord) => void;
}

function isTestRunPending(status: string) {
  return ['collecting_inputs', 'queued', 'processing', 'generating', 'awaiting_approval'].includes(status);
}

function shouldPollTestRun(status: string) {
  return isTestRunPending(status);
}

function isTestRunAttention(status: string) {
  return status === 'needs_attention' || status === 'failed';
}

function testRunStorageKey(canvasId: string | null, outputNodeId: string | null) {
  if (!canvasId || !outputNodeId) return null;
  return `magicbooklet:template-test:${canvasId}:${outputNodeId}`;
}

function renderConsumerTestSetupWindow(
  consumerWindow: Window,
  state: 'preparing' | 'error',
  detail?: string
) {
  try {
    const popupDocument = consumerWindow.document;
    const isError = state === 'error';
    popupDocument.open();
    popupDocument.write(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>${isError ? 'Test setup needs attention' : 'Preparing consumer test'} · Magicbooklet</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #070707; color: #fafafa; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(100%, 520px); border: 1px solid ${isError ? 'rgba(244,63,94,.3)' : 'rgba(139,92,246,.28)'}; border-radius: 28px; padding: 30px; background: linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.018)); box-shadow: 0 28px 100px rgba(0,0,0,.55); }
      .brand { color: #a1a1aa; font-size: 11px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; }
      .mark { display: grid; place-items: center; width: 44px; height: 44px; margin: 28px 0 22px; border-radius: 15px; background: ${isError ? 'rgba(244,63,94,.12)' : 'rgba(139,92,246,.14)'}; color: ${isError ? '#fecdd3' : '#ddd6fe'}; font-size: 22px; }
      .spinner { width: 20px; height: 20px; border: 2px solid rgba(221,214,254,.28); border-top-color: #ddd6fe; border-radius: 50%; animation: spin .8s linear infinite; }
      h1 { margin: 0; font-size: clamp(24px, 6vw, 34px); line-height: 1.08; letter-spacing: -.035em; }
      p { margin: 14px 0 0; color: #b4b4bd; font-size: 15px; line-height: 1.65; }
      .detail { margin-top: 18px; padding: 13px 15px; border: 1px solid ${isError ? 'rgba(244,63,94,.2)' : 'rgba(255,255,255,.08)'}; border-radius: 16px; background: rgba(0,0,0,.2); color: ${isError ? '#ffe4e6' : '#d4d4d8'}; font-size: 13px; }
      button { min-height: 44px; margin-top: 22px; border: 1px solid rgba(255,255,255,.12); border-radius: 999px; padding: 0 18px; background: rgba(255,255,255,.06); color: #fafafa; font: inherit; font-size: 14px; cursor: pointer; }
      button:hover { background: rgba(255,255,255,.1); }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-top-color: rgba(221,214,254,.28); } }
    </style>
  </head>
  <body>
    <main aria-live="polite">
      <div class="brand">Magicbooklet · Creator test</div>
      <div class="mark" aria-hidden="true">${isError ? '!' : '<div class="spinner"></div>'}</div>
      <h1>${isError ? 'We couldn\u2019t prepare this test' : 'Preparing your consumer test'}</h1>
      <p>${isError
        ? 'Return to the workflow tab, review the message there, and choose Test in new tab again.'
        : 'Saving and validating this exact workflow revision. This tab will continue automatically.'}</p>
      <div class="detail" id="test-setup-detail"></div>
      ${isError ? '<button type="button" id="close-test-setup">Close this tab</button>' : ''}
    </main>
  </body>
</html>`);
    popupDocument.close();

    const detailElement = popupDocument.getElementById('test-setup-detail');
    if (detailElement) {
      detailElement.textContent = detail || (isError
        ? 'The test was not created, so no generation credits were used.'
        : 'Please keep this tab open.');
    }
    popupDocument.getElementById('close-test-setup')?.addEventListener('click', () => consumerWindow.close());
  } catch {
    // The main workflow tab still carries the actionable error if a browser
    // prevents us from styling or updating the pre-opened tab.
  }
}

function getTestRunCopy(status: string, matchesCurrentPath: boolean) {
  if (!matchesCurrentPath) {
    return {
      title: 'Test belongs to an older workflow revision',
      description: 'The selected execution path changed. Validate and test the current path before publishing.',
      action: 'View previous test',
    };
  }

  switch (status) {
    case 'collecting_inputs':
      return {
        title: 'Waiting for consumer uploads',
        description: 'Add the required images or videos in the consumer tab, then start the workflow there.',
        action: 'Continue consumer test',
      };
    case 'awaiting_approval':
      return {
        title: 'Waiting for your approval',
        description: 'Review the generated media in the consumer tab and approve it to continue.',
        action: 'Review generated media',
      };
    case 'needs_attention':
    case 'failed':
      return {
        title: 'Test needs attention',
        description: 'Open the consumer test to see the failed step and retry it without repeating successful work.',
        action: 'Open and retry test',
      };
    case 'succeeded':
      return {
        title: 'Consumer test passed',
        description: 'This exact workflow revision produced its final result successfully.',
        action: 'View test result',
      };
    case 'cancelled':
      return {
        title: 'Test was cancelled',
        description: 'Run a new consumer test for this workflow before publishing.',
        action: 'View cancelled test',
      };
    default:
      return {
        title: 'Consumer test is running',
        description: 'Keep this drawer open while you work in the consumer tab. Status updates automatically.',
        action: 'Continue consumer test',
      };
  }
}

export function WorkflowTemplatePublishDrawer({
  activeCanvasId,
  activeCanvasRevision,
  authHeaders,
  canvasTitle,
  catalogRevision,
  graph,
  initialTestRunId,
  isOpen,
  outputNodeId,
  templateId,
  onClose,
  onEnsureSaved,
  onFocusNode,
  onOutputNodeChange,
  onTemplateCreated,
}: WorkflowTemplatePublishDrawerProps) {
  const { credits } = useAuth();
  const hydratedReturnTestKeyRef = useRef<string | null>(null);
  const [name, setName] = useState(canvasTitle);
  const [hasEditedName, setHasEditedName] = useState(false);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Transformation');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [remoteValidation, setRemoteValidation] = useState<RemoteTemplateValidation | null>(null);
  const [validatedClientPathHash, setValidatedClientPathHash] = useState<string | null>(null);
  const [testRun, setTestRun] = useState<TemplateTestRun | null>(null);
  const [testContext, setTestContext] = useState<TemplateTestContext | null>(null);
  const [busyAction, setBusyAction] = useState<'validate' | 'save' | 'test' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [testRecoveryMessage, setTestRecoveryMessage] = useState<string | null>(null);
  const templateName = !templateId && !hasEditedName ? canvasTitle : name;
  const activeTestRunId = testRun?.id ?? null;
  const activeTestRunStatus = testRun?.status ?? null;

  const outputOptions = useMemo(() => graph.nodes
    .map((node) => ({
      id: node.id,
      title: node.data.title || 'Untitled node',
      kind: getWorkflowNodeMediaOutputKind(node),
      type: node.type,
    }))
    .filter((node) => node.kind && node.type !== 'image-input' && node.type !== 'video-input'), [graph.nodes]);
  const localValidation = useMemo<WorkflowTemplateAuthoringValidation>(() => (
    validateWorkflowTemplateAuthoringGraph({ graph, outputNodeId })
  ), [graph, outputNodeId]);
  const clientPathHash = useMemo(() => {
    const pathNodeIds = new Set(localValidation.path.nodeIds);
    const pathEdgeIds = new Set(localValidation.path.edgeIds);
    return createWorkflowGraphHash({
      ...graph,
      nodes: graph.nodes.filter((node) => pathNodeIds.has(node.id)),
      edges: graph.edges.filter((edge) => pathEdgeIds.has(edge.id)),
    }, { mode: 'template-compile' });
  }, [graph, localValidation.path.edgeIds, localValidation.path.nodeIds]);
  const storedTestKey = useMemo(
    () => testRunStorageKey(activeCanvasId, outputNodeId),
    [activeCanvasId, outputNodeId]
  );

  const readJson = useCallback(async (response: Response) => {
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Template request failed.');
    }
    return data as Record<string, unknown>;
  }, []);

  useEffect(() => {
    if (!isOpen || outputNodeId || outputOptions.length === 0) {
      return;
    }
    const preferred = [...outputOptions].reverse().find((node) => node.kind === 'video') ?? outputOptions.at(-1);
    onOutputNodeChange(preferred?.id ?? null);
  }, [isOpen, onOutputNodeChange, outputNodeId, outputOptions]);

  useEffect(() => {
    if (!isOpen || !templateId) {
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/templates/${templateId}`, {
          headers: await authHeaders(),
        });
        const data = await readJson(response);
        const template = data.template as TemplateAuthoringRecord | undefined;
        if (!template || cancelled) {
          return;
        }
        setName(template.name || canvasTitle);
        setDescription(template.description || '');
        setCategory(template.category || 'Transformation');
        if (template.authoring?.outputNodeId) {
          onOutputNodeChange(template.authoring.outputNodeId);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load template details.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authHeaders, canvasTitle, isOpen, onOutputNodeChange, readJson, templateId]);

  useEffect(() => {
    if (!isOpen || !storedTestKey || initialTestRunId) return;

    const timeoutId = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(storedTestKey);
        if (!raw) return;
        const stored = JSON.parse(raw) as {
          run?: TemplateTestRun;
          context?: TemplateTestContext;
        };
        if (
          typeof stored.run?.id === 'string'
          && typeof stored.run.status === 'string'
          && typeof stored.context?.canvasRevision === 'number'
          && typeof stored.context.clientPathHash === 'string'
          && typeof stored.context.graphHash === 'string'
          && typeof stored.context.templateId === 'string'
        ) {
          setTestRun(stored.run);
          setTestContext(stored.context);
        }
      } catch {
        window.localStorage.removeItem(storedTestKey);
      }
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [initialTestRunId, isOpen, storedTestKey]);

  useEffect(() => {
    if (!storedTestKey || !testRun || !testContext) return;
    try {
      window.localStorage.setItem(storedTestKey, JSON.stringify({ run: testRun, context: testContext }));
    } catch {
      // Browser storage is only a convenience for returning from the consumer
      // tab. The active in-memory test remains usable when storage is blocked.
    }
  }, [storedTestKey, testContext, testRun]);

  const clearMissingTestRun = useCallback(() => {
    setTestRun(null);
    setTestContext(null);
    setError(null);
    setSuccessMessage(null);
    setTestRecoveryMessage('The previous consumer test expired or was removed. Run a fresh test for this workflow revision.');
    if (storedTestKey) {
      try {
        window.localStorage.removeItem(storedTestKey);
      } catch {
        // The in-memory state is already cleared when browser storage is unavailable.
      }
    }
  }, [storedTestKey]);

  useEffect(() => {
    if (!isOpen || !activeTestRunId || !activeTestRunStatus) {
      return;
    }

    let cancelled = false;
    let refreshInFlight = false;
    const refresh = async () => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      try {
        const response = await fetch(`/api/template-runs/${activeTestRunId}`, {
          headers: await authHeaders(),
        });
        if (response.status === 404) {
          if (!cancelled) clearMissingTestRun();
          return;
        }
        const data = await readJson(response);
        const run = data.run as TemplateTestRun | undefined;
        if (run && !cancelled) {
          setTestRun(run);
          if (run.status === 'succeeded' && activeTestRunStatus !== 'succeeded') {
            setSuccessMessage('Consumer test passed. Confirm publishing rights to unlock Publish.');
          }
        }
      } catch {
        // The explicit action error remains the primary feedback. A later poll
        // can recover from a transient request failure without resetting state.
      } finally {
        refreshInFlight = false;
      }
    };

    if (shouldPollTestRun(activeTestRunStatus)) {
      const intervalId = window.setInterval(() => void refresh(), 4000);
      void refresh();
      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
      };
    }

    if (!isTestRunAttention(activeTestRunStatus)) {
      return;
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const refreshWhenFocused = () => void refresh();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenFocused);
    void refresh();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenFocused);
    };
  }, [activeTestRunId, activeTestRunStatus, authHeaders, clearMissingTestRun, isOpen, readJson]);

  const runRemoteValidation = useCallback(async (): Promise<RemoteTemplateValidation | null> => {
    if (!activeCanvasId || !outputNodeId) {
      setError('Choose a final output before validating.');
      return null;
    }
    if (!localValidation.valid) {
      setRemoteValidation(null);
      setValidatedClientPathHash(null);
      setError('Resolve the highlighted graph issues before testing.');
      const firstIssueNodeId = localValidation.issues.find((issue) => issue.nodeId)?.nodeId;
      if (firstIssueNodeId) {
        onFocusNode(firstIssueNodeId);
      }
      return null;
    }

    const revision = await onEnsureSaved();
    if (revision === null) {
      setError('Save the workflow before validating it.');
      return null;
    }

    const response = await fetch('/api/templates/validate', {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({
        canvasId: activeCanvasId,
        outputNodeId,
        expectedRevision: revision,
        catalogRevision,
      }),
    });
    const data = await readJson(response);
    const validation = data.validation as RemoteTemplateValidation;
    setRemoteValidation(validation);
    setValidatedClientPathHash(clientPathHash);
    if (!validation.valid) {
      const firstIssueNodeId = validation.issues.find((issue) => issue.nodeId)?.nodeId;
      if (firstIssueNodeId) {
        onFocusNode(firstIssueNodeId);
      }
    }
    return validation;
  }, [
    activeCanvasId,
    authHeaders,
    catalogRevision,
    clientPathHash,
    localValidation,
    onEnsureSaved,
    onFocusNode,
    outputNodeId,
    readJson,
  ]);

  useEffect(() => {
    if (
      !isOpen
      || !initialTestRunId
      || !templateId
      || !activeCanvasId
      || !outputNodeId
      || !localValidation.valid
    ) {
      return;
    }

    const hydrationKey = `${activeCanvasId}:${templateId}:${initialTestRunId}`;
    if (hydratedReturnTestKeyRef.current === hydrationKey) {
      return;
    }
    hydratedReturnTestKeyRef.current = hydrationKey;
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/template-runs/${initialTestRunId}`, {
          headers: await authHeaders(),
        });
        if (response.status === 404) {
          if (!cancelled) clearMissingTestRun();
          return;
        }
        const data = await readJson(response);
        const run = data.run as TemplateTestRun | undefined;
        if (!run || run.id !== initialTestRunId || run.isTest !== true) {
          throw new Error('The returned run is not a template test.');
        }
        if (run.templateId !== templateId) {
          throw new Error('This test belongs to a different template.');
        }
        if (cancelled) return;

        setTestRun(run);
        const validation = await runRemoteValidation();
        if (cancelled || !validation?.valid) return;

        setTestContext({
          canvasRevision: validation.canvasRevision,
          clientPathHash,
          graphHash: validation.graphHash,
          templateId,
        });
        if (run.status === 'succeeded') {
          setSuccessMessage('Consumer test restored and passed. Confirm publishing rights to unlock Publish.');
        }
      } catch (restoreError) {
        if (!cancelled) {
          hydratedReturnTestKeyRef.current = null;
          setError(restoreError instanceof Error ? restoreError.message : 'Failed to restore the consumer test.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeCanvasId,
    authHeaders,
    clientPathHash,
    clearMissingTestRun,
    initialTestRunId,
    isOpen,
    localValidation.valid,
    outputNodeId,
    readJson,
    runRemoteValidation,
    templateId,
  ]);

  const saveDraft = useCallback(async (): Promise<TemplateAuthoringRecord | null> => {
    if (!activeCanvasId || !templateName.trim()) {
      setError(!activeCanvasId ? 'Save this workflow before creating a template.' : 'Add a template name.');
      return null;
    }
    const revision = await onEnsureSaved();
    if (revision === null) {
      setError('The workflow could not be saved. Resolve the save error before continuing.');
      return null;
    }

    const response = await fetch(templateId ? `/api/templates/${templateId}` : '/api/templates', {
      method: templateId ? 'PATCH' : 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({
        sourceCanvasId: activeCanvasId,
        name: templateName.trim(),
        description: description.trim() || null,
        category: category.trim() || 'general',
        outputNodeId,
        catalogRevision,
      }),
    });
    const data = await readJson(response);
    const template = data.template as TemplateAuthoringRecord;
    setName(template.name || templateName);
    onTemplateCreated(template);
    return template;
  }, [
    activeCanvasId,
    authHeaders,
    catalogRevision,
    category,
    description,
    onEnsureSaved,
    onTemplateCreated,
    outputNodeId,
    readJson,
    templateName,
    templateId,
  ]);

  const withBusyAction = useCallback(async (
    action: 'validate' | 'save' | 'test' | 'publish',
    task: () => Promise<void>
  ) => {
    setBusyAction(action);
    setError(null);
    setSuccessMessage(null);
    setTestRecoveryMessage(null);
    try {
      await task();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Template request failed.');
    } finally {
      setBusyAction(null);
    }
  }, []);

  if (!isOpen) {
    return null;
  }

  const validationIsCurrent = Boolean(
    remoteValidation
    && remoteValidation.canvasRevision === activeCanvasRevision
    && remoteValidation.valid
    && validatedClientPathHash === clientPathHash
  );
  const displayedIssues = validationIsCurrent && remoteValidation
    ? remoteValidation.issues
    : localValidation.issues;
  const testMatchesCurrentPath = Boolean(
    testContext
    && testContext.canvasRevision === activeCanvasRevision
    && testContext.clientPathHash === clientPathHash
    && (!templateId || testContext.templateId === templateId)
  );
  const testMatchesCurrentValidation = Boolean(
    validationIsCurrent
    && remoteValidation
    && testMatchesCurrentPath
    && testContext?.graphHash === remoteValidation.graphHash
    && testContext?.canvasRevision === remoteValidation.canvasRevision
  );
  const testSucceeded = testRun?.status === 'succeeded' && testMatchesCurrentValidation;
  const testCopy = testRun ? getTestRunCopy(testRun.status, testMatchesCurrentPath) : null;
  const estimatedCredits = remoteValidation?.estimatedTotalCredits ?? null;
  const creditShortfall = typeof estimatedCredits === 'number' && typeof credits === 'number'
    ? Math.max(0, estimatedCredits - credits)
    : 0;
  const hasEnoughCredits = creditShortfall === 0;
  const shouldOpenExistingTest = Boolean(
    testRun
    && testMatchesCurrentPath
    && testRun.status !== 'succeeded'
    && testRun.status !== 'cancelled'
  );
  const publishRequirements = [
    {
      met: Boolean(templateName.trim()),
      label: 'Template name added',
      action: 'Add a template name.',
    },
    {
      met: Boolean(outputNodeId) && localValidation.valid,
      label: 'Execution path is valid',
      action: 'Choose a final result and resolve its graph issues.',
    },
    {
      met: validationIsCurrent,
      label: 'Current saved revision validated',
      action: remoteValidation ? 'The selected path changed. Validate it again.' : 'Validate the current workflow.',
    },
    {
      met: testSucceeded,
      label: 'Consumer test completed successfully',
      action: testRun && isTestRunAttention(testRun.status) && testMatchesCurrentPath
        ? 'Open the test that needs attention and retry the affected step.'
        : testRun && !testMatchesCurrentPath
          ? 'Run a new test for the current workflow revision.'
          : 'Complete one successful consumer test.',
    },
    {
      met: rightsConfirmed,
      label: 'Publishing rights confirmed',
      action: 'Confirm you have permission to publish these assets.',
    },
  ];
  const firstIncompleteRequirement = publishRequirements.find((requirement) => !requirement.met);
  const publishBlockedReason = firstIncompleteRequirement?.action
    ?? (!templateId ? 'Save the template draft before publishing.' : null);
  const testActionLabel = shouldOpenExistingTest
    ? testRun && isTestRunAttention(testRun.status) ? 'Open test issue' : 'Continue test'
    : testRun?.status === 'succeeded' && testMatchesCurrentPath ? 'Retest in new tab' : 'Test in new tab';

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="Publish workflow as template"
      data-testid="workflow-template-publish-drawer"
      className="pointer-events-auto fixed inset-2 z-[80] flex w-auto max-w-none flex-col overflow-hidden rounded-[24px] border border-emerald-500/20 bg-[#050505]/98 shadow-[0_28px_120px_rgba(0,0,0,0.68)] backdrop-blur-xl lg:absolute lg:inset-x-auto lg:inset-y-3 lg:right-3 lg:w-[430px] lg:max-w-[calc(100%-1.5rem)] lg:rounded-[30px]"
    >
      <div className="border-b border-white/10 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-emerald-300">
              <Sparkles className="h-3.5 w-3.5" /> Publish as template
            </div>
            <h2 className="mt-2 text-xl font-semibold text-white">Turn this graph into a reusable format</h2>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">Consumers see uploads and reviews, never your graph or prompts.</p>
          </div>
          <button
            type="button"
            aria-label="Close template publishing"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.07] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <section className="space-y-3">
          <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Listing</div>
          <input
            aria-label="Template name"
            value={templateName}
            maxLength={120}
            onChange={(event) => {
              setHasEditedName(true);
              setName(event.target.value);
            }}
            placeholder="Template name"
            className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-500/40"
          />
          <textarea
            aria-label="Template description"
            value={description}
            maxLength={500}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Explain what this format creates and which uploads work best."
            className="w-full resize-none rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-500/40"
          />
          <input
            aria-label="Template category"
            value={category}
            maxLength={48}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Category"
            className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-500/40"
          />
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Consumer result</div>
            {localValidation.outputKind ? (
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-emerald-200">
                {localValidation.outputKind}
              </span>
            ) : null}
          </div>
          <select
            aria-label="Final output node"
            value={outputNodeId ?? ''}
            onChange={(event) => {
              onOutputNodeChange(event.target.value || null);
              setRemoteValidation(null);
              setValidatedClientPathHash(null);
              setTestRun(null);
              setTestContext(null);
            }}
            className="w-full rounded-2xl border border-white/10 bg-[#0b0b0b] px-4 py-3 text-sm text-white outline-none focus:border-emerald-500/40"
          >
            <option value="">Choose final output</option>
            {outputOptions.map((node) => (
              <option key={node.id} value={node.id}>{node.title} · {node.kind}</option>
            ))}
          </select>
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-3">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>One result · selected execution path</span>
              <span>{localValidation.path.nodeIds.length} nodes</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">
              A template publishes one image or video. Only nodes connected upstream to that result will run.
              Dimmed nodes stay on your canvas but are excluded; connect them into this result to include them.
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Validation</div>
            <span className={`rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] ${
              validationIsCurrent
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                : 'border-amber-500/25 bg-amber-500/10 text-amber-200'
            }`}>
              {validationIsCurrent
                ? 'Validated'
                : displayedIssues.length === 0
                  ? remoteValidation ? 'Changes need validation' : 'Ready to validate'
                  : `${displayedIssues.length} issue${displayedIssues.length === 1 ? '' : 's'}`}
            </span>
          </div>
          {displayedIssues.length > 0 ? (
            <div className="space-y-2">
              {displayedIssues.map((issue, index) => (
                <button
                  key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? index}`}
                  type="button"
                  onClick={() => issue.nodeId && onFocusNode(issue.nodeId)}
                  className="flex w-full items-start gap-2 rounded-2xl border border-amber-500/15 bg-amber-500/[0.06] px-3 py-2.5 text-left text-xs leading-relaxed text-amber-50/85"
                >
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">{issue.message}</span>
                  {issue.nodeId ? <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
                </button>
              ))}
            </div>
          ) : (
            <div className={`flex items-start gap-2 rounded-2xl border px-3 py-3 text-sm ${
              validationIsCurrent
                ? 'border-emerald-500/15 bg-emerald-500/[0.06] text-emerald-100'
                : 'border-amber-500/15 bg-amber-500/[0.06] text-amber-50'
            }`}>
              {validationIsCurrent
                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>
                {validationIsCurrent
                  ? `Saved revision ${remoteValidation?.canvasRevision} is validated.`
                  : remoteValidation
                    ? 'The selected path changed after validation. Validate again before testing or publishing.'
                    : 'The graph is structurally ready. Validate to save and verify this exact revision.'}
              </span>
            </div>
          )}
          {typeof estimatedCredits === 'number' ? (
            <div className={`rounded-2xl border px-3 py-3 ${
              hasEnoughCredits
                ? 'border-white/10 bg-white/[0.03]'
                : 'border-rose-500/25 bg-rose-500/[0.08]'
            }`}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="inline-flex items-center gap-2 text-zinc-300">
                  <CircleDollarSign className="h-4 w-4" /> Full test estimate
                </span>
                <span className="font-semibold text-white">{estimatedCredits} credits</span>
              </div>
              {typeof credits === 'number' ? (
                <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                  <span className={hasEnoughCredits ? 'text-zinc-500' : 'text-rose-100'}>
                    Your balance: {credits} credits
                  </span>
                  {!hasEnoughCredits ? (
                    <a href="/pricing" target="_blank" rel="noreferrer" className="font-medium text-rose-100 underline decoration-rose-300/40 underline-offset-4">
                      Add {creditShortfall} credits
                    </a>
                  ) : null}
                </div>
              ) : null}
              {!hasEnoughCredits ? (
                <p className="mt-2 text-xs leading-relaxed text-rose-100/85">
                  Add credits before starting so the end-to-end test does not stop at a later generation step.
                </p>
              ) : null}
            </div>
          ) : null}
          <p className="text-xs leading-relaxed text-zinc-500">
            Validate and Test save the workflow first. Changes to the selected path require validation and a new successful test.
          </p>
        </section>

        {testRun && testCopy ? (
          <section className={`rounded-3xl border p-4 ${
            !testMatchesCurrentPath
              ? 'border-amber-500/25 bg-amber-500/[0.06]'
              : testRun.status === 'succeeded'
                ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
                : isTestRunAttention(testRun.status)
                  ? 'border-rose-500/25 bg-rose-500/[0.07]'
                  : 'border-violet-500/20 bg-violet-500/[0.05]'
          }`}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-400">Latest consumer test</div>
                <div className="mt-2 text-sm font-semibold text-white">{testCopy.title}</div>
              </div>
              {isTestRunPending(testRun.status) ? (
                <Loader2 className="h-4 w-4 animate-spin text-violet-200" />
              ) : isTestRunAttention(testRun.status) ? (
                <AlertCircle className="h-4 w-4 text-rose-200" />
              ) : testRun.status === 'succeeded' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-200" />
              ) : null}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-300">{testCopy.description}</p>
            {testRun.errorMessage ? (
              <p className="mt-2 rounded-xl border border-rose-500/20 bg-black/20 px-3 py-2 text-xs leading-relaxed text-rose-100">
                {testRun.errorMessage}
              </p>
            ) : null}
            <a
              href={`/template-runs/${testRun.id}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex min-h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3 text-xs font-medium text-zinc-100 transition hover:bg-white/[0.09]"
            >
              {testCopy.action} <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </section>
        ) : null}

        <section className="space-y-3 rounded-3xl border border-white/10 bg-white/[0.025] p-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Publish checklist</div>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">Publish unlocks when every item applies to the same saved workflow revision.</p>
          </div>
          <div className="space-y-2.5">
            {publishRequirements.map((requirement) => (
              <div key={requirement.label} className="flex items-center gap-2.5 text-sm">
                {requirement.met ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-zinc-600" />
                )}
                <span className={requirement.met ? 'text-zinc-200' : 'text-zinc-500'}>{requirement.label}</span>
              </div>
            ))}
          </div>
        </section>

        <label className="flex items-start gap-3 rounded-3xl border border-white/10 bg-white/[0.025] p-4 text-sm leading-relaxed text-zinc-300">
          <input
            type="checkbox"
            checked={rightsConfirmed}
            onChange={(event) => setRightsConfirmed(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-white/20 bg-transparent accent-emerald-500"
          />
          <span>I have permission to use every fixed asset, prompt, demo result, and person shown in this template.</span>
        </label>

        {error ? (
          <div className="flex items-start gap-2 rounded-2xl border border-rose-500/25 bg-rose-500/10 px-3 py-3 text-sm text-rose-100">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </div>
        ) : null}
        {successMessage ? (
          <div className="flex items-start gap-2 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-3 text-sm text-emerald-100">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {successMessage}
          </div>
        ) : null}
        {testRecoveryMessage ? (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-3 py-3 text-sm leading-relaxed text-amber-50">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {testRecoveryMessage}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-white/10 bg-black/35 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
        <div
          id="template-publish-readiness"
          role="status"
          className={`col-span-2 flex items-start gap-2 rounded-2xl border px-3 py-2.5 text-xs leading-relaxed ${
            publishBlockedReason
              ? 'border-amber-500/15 bg-amber-500/[0.06] text-amber-50/90'
              : 'border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-100'
          }`}
        >
          {publishBlockedReason ? (
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>{publishBlockedReason ? `Publish locked — ${publishBlockedReason}` : 'Ready to publish this tested revision.'}</span>
        </div>
        <button
          type="button"
          disabled={Boolean(busyAction)}
          onClick={() => void withBusyAction('validate', async () => {
            const validation = await runRemoteValidation();
            if (validation?.valid) {
              setSuccessMessage(`Saved and validated workflow revision ${validation.canvasRevision}.`);
            }
          })}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busyAction === 'validate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Validate
        </button>
        <button
          type="button"
          disabled={Boolean(busyAction)}
          onClick={() => void withBusyAction('save', async () => {
            const template = await saveDraft();
            if (template) {
              setSuccessMessage('Template draft saved.');
            }
          })}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busyAction === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save draft
        </button>
        <button
          type="button"
          disabled={
            Boolean(busyAction)
            || !localValidation.valid
            || (!shouldOpenExistingTest && validationIsCurrent && !hasEnoughCredits)
          }
          title={
            !shouldOpenExistingTest && validationIsCurrent && !hasEnoughCredits
              ? `Add ${creditShortfall} credits before running the full test.`
              : undefined
          }
          onClick={() => void withBusyAction('test', async () => {
            if (shouldOpenExistingTest && testRun) {
              const opened = window.open(`/template-runs/${testRun.id}`, '_blank', 'noopener,noreferrer');
              setSuccessMessage(opened
                ? 'Consumer test opened in a new tab. This drawer will keep watching its status.'
                : 'Your browser blocked the new tab. Use the Latest consumer test button above.');
              return;
            }

            let consumerWindow: Window | null = null;
            try {
              consumerWindow = window.open('about:blank', 'magicbooklet-template-consumer-test');
              if (consumerWindow) {
                consumerWindow.opener = null;
                renderConsumerTestSetupWindow(consumerWindow, 'preparing');
              }

              const validation = await runRemoteValidation();
              if (!validation?.valid) {
                if (consumerWindow && !consumerWindow.closed) {
                  renderConsumerTestSetupWindow(
                    consumerWindow,
                    'error',
                    'The workflow needs attention before a consumer test can be created. No generation credits were used.'
                  );
                }
                return;
              }
              if (
                typeof validation.estimatedTotalCredits === 'number'
                && typeof credits === 'number'
                && validation.estimatedTotalCredits > credits
              ) {
                const shortfall = validation.estimatedTotalCredits - credits;
                setError(
                  `This full test needs about ${validation.estimatedTotalCredits} credits. Your balance is ${credits}; add ${shortfall} credits before starting.`
                );
                if (consumerWindow && !consumerWindow.closed) {
                  renderConsumerTestSetupWindow(
                    consumerWindow,
                    'error',
                    `Add ${shortfall} credits in the workflow tab before starting this ${validation.estimatedTotalCredits}-credit test.`
                  );
                }
                return;
              }
              const template = await saveDraft();
              const id = template?.id ?? templateId;
              if (!id) {
                if (consumerWindow && !consumerWindow.closed) {
                  renderConsumerTestSetupWindow(
                    consumerWindow,
                    'error',
                    'The template draft could not be saved. Review the workflow tab and try again.'
                  );
                }
                return;
              }
              const response = await fetch(`/api/templates/${id}/test`, {
                method: 'POST',
                headers: await authHeaders(),
                body: JSON.stringify({
                  expectedRevision: validation.canvasRevision,
                  outputNodeId,
                  catalogRevision,
                }),
              });
              const data = await readJson(response);
              const run = data.run as TemplateTestRun;
              const nextTestContext: TemplateTestContext = {
                canvasRevision: validation.canvasRevision,
                clientPathHash,
                graphHash: validation.graphHash,
                templateId: id,
              };
              setTestRun(run);
              setTestContext(nextTestContext);

              const testUrl = `/template-runs/${run.id}`;
              if (consumerWindow && !consumerWindow.closed) {
                consumerWindow.location.replace(testUrl);
                setSuccessMessage('Consumer test opened in a new tab. This drawer will keep watching its status.');
              } else {
                setSuccessMessage('Consumer test created. Your browser blocked the new tab—use Continue consumer test above.');
              }
            } catch (setupError) {
              if (consumerWindow && !consumerWindow.closed) {
                renderConsumerTestSetupWindow(
                  consumerWindow,
                  'error',
                  setupError instanceof Error
                    ? setupError.message
                    : 'The test could not be created. No generation credits were used.'
                );
              }
              throw setupError;
            }
          })}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-violet-500/25 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-100 transition hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busyAction === 'test' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
          {testActionLabel}
        </button>
        <button
          type="button"
          aria-describedby="template-publish-readiness"
          title={publishBlockedReason ?? 'Publish this tested template revision.'}
          disabled={Boolean(busyAction) || Boolean(publishBlockedReason)}
          onClick={() => void withBusyAction('publish', async () => {
            if (!templateId || !testRun || !remoteValidation) {
              return;
            }
            const response = await fetch(`/api/templates/${templateId}/publish`, {
              method: 'POST',
              headers: await authHeaders(),
              body: JSON.stringify({
                testRunId: testRun.id,
                expectedRevision: remoteValidation.canvasRevision,
                graphHash: remoteValidation.graphHash,
                catalogRevision,
                rightsConfirmed: true,
              }),
            });
            await readJson(response);
            setSuccessMessage('Template published. New consumers now use this immutable version.');
          })}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500 px-4 py-2 text-sm font-semibold text-black transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busyAction === 'publish' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Publish
        </button>
      </div>
    </aside>
  );
}
