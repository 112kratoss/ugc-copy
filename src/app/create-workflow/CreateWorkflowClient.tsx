'use client';

import '@xyflow/react/dist/style.css';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { addEdge, type Connection, type ReactFlowInstance } from '@xyflow/react';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/app/components/AuthProvider';
import {
  DEFAULT_VIEWPORT,
  createStarterGraph,
  createWorkflowNode,
  duplicateWorkflowSelection,
  inspectWorkflowNodeCapabilities,
  isRunnableNode,
  normalizeNodeData,
  syncWorkflowGraphElementBindings,
  validateWorkflowConnectionForGraph,
  type WorkflowCanvasRunRecord,
  type WorkflowCanvasEdge,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type WorkflowCanvasRecord,
  type WorkflowHandleType,
  type WorkflowNodeData,
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import { getClientE2EAuthState } from '@/lib/e2e-auth';
import {
  resolveCatalogModelId,
  useWebGenerationModelCatalog,
} from '@/lib/generation-model-client';
import {
  uploadWorkflowAssetWithSignedIntent,
  type WorkflowAssetUploadBucket,
} from '@/lib/workflow-asset-upload';
import { WorkflowCanvasChrome } from './WorkflowCanvasChrome';
import { WorkflowCanvasLeftRail } from './WorkflowCanvasPanels';
import { WorkflowCanvasShareActions } from './WorkflowCanvasShareActions';
import {
  WORKFLOW_NODE_LIBRARY,
  decorateWorkflowEdge,
  type WorkflowNodeRuntimeData,
} from './WorkflowCanvasNodes';
import { WorkflowAssistantDrawer } from './WorkflowPlannerDrawer';
import { WorkflowCanvasSurface } from './WorkflowCanvasSurface';
import { WorkflowCanvasInspector } from './WorkflowNodeEditors';
import { useWorkflowCanvasAssistant } from './useWorkflowCanvasAssistant';
import { useWorkflowCanvasCanvases } from './useWorkflowCanvasCanvases';
import { useWorkflowCanvasContextMenu } from './useWorkflowCanvasContextMenu';
import { useWorkflowCanvasPersistence } from './useWorkflowCanvasPersistence';
import { mergeWorkflowRunIntoNodes, useWorkflowCanvasRunState } from './useWorkflowCanvasRunState';
import { useWorkflowCanvasSelection } from './useWorkflowCanvasSelection';
import { useWorkflowRunPolling } from './useWorkflowRunPolling';
import type {
  CanvasAnchoredPopupPosition,
  CanvasSelectionState,
  PreviewMediaState,
  WorkflowInspectorPanel,
} from './workflowCanvasUiTypes';
import { getNodeAnchoredPopupPosition, getNodeRunAffordance } from './workflowCanvasUiUtils';
import { WORKFLOW_ASSISTANT_COST } from '@/lib/workflow-assistant-client';

function areViewportsEqual(
  left: { x: number; y: number; zoom: number },
  right: { x: number; y: number; zoom: number }
) {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

function areAnchoredPopupPositionsEqual(
  left: CanvasAnchoredPopupPosition | null,
  right: CanvasAnchoredPopupPosition | null
) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.caretLeft === right.caretLeft
  );
}

type UnsavedDecision = 'save' | 'discard' | 'cancel';

function UnsavedChangesDialog({
  isOpen,
  onCancel,
  onDiscard,
  onSave,
  reason,
}: {
  isOpen: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
  reason: string;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-[#050505] p-6 shadow-[0_32px_120px_rgba(0,0,0,0.65)]">
        <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Unsaved changes</div>
        <div className="mt-3 text-xl font-semibold text-white">Save before continuing?</div>
        <div className="mt-2 text-sm leading-relaxed text-zinc-400">{reason}</div>

        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 transition hover:bg-white/[0.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-100 transition hover:bg-rose-500/20"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100 transition hover:bg-emerald-500/20"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CreateWorkflowClient({
  initialImportShareId = null,
}: {
  initialImportShareId?: string | null;
}) {
  const router = useRouter();
  const { credits, refreshSessionState, session, updateCredits } = useAuth();
  const modelCatalog = useWebGenerationModelCatalog();
  const e2eAuth = useMemo(() => getClientE2EAuthState(), []);
  const effectiveSession = session ?? e2eAuth?.session ?? null;
  const canvasSectionRef = useRef<HTMLElement | null>(null);
  const beforeCanvasTransitionRef = useRef<() => Promise<boolean>>(async () => true);
  const hasUnsavedChangesRef = useRef(false);
  const syncPersistedCanvasRef = useRef<(canvas: WorkflowCanvasRecord) => void>(() => undefined);
  const resetSelectionRef = useRef<() => void>(() => undefined);
  const resetTransientUiRef = useRef<() => void>(() => undefined);
  const skipNextViewportSyncRef = useRef(false);
  const viewportRef = useRef(DEFAULT_VIEWPORT);
  const nodeLibrarySearchInputRef = useRef<HTMLInputElement | null>(null);
  const clipboardRef = useRef<{
    nodes: WorkflowCanvasNode[];
    edges: WorkflowCanvasEdge[];
  } | null>(null);
  const unsavedDecisionResolverRef = useRef<((decision: UnsavedDecision) => void) | null>(null);
  const starter = useMemo(() => createStarterGraph(), []);

  const [error, setError] = useState<string | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [previewMedia, setPreviewMedia] = useState<PreviewMediaState | null>(null);
  const [activeInspectorPanel, setActiveInspectorPanel] = useState<WorkflowInspectorPanel | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [nodePopupPosition, setNodePopupPosition] = useState<CanvasAnchoredPopupPosition | null>(null);
  const [nodes, setNodes] = useState<WorkflowCanvasNode[]>(starter.nodes);
  const [edges, setEdges] = useState<WorkflowCanvasEdge[]>(starter.edges.map((edge) => decorateWorkflowEdge(edge)));
  const [changeKey, setChangeKey] = useState(0);
  const [openNodeRunMenuId, setOpenNodeRunMenuId] = useState<string | null>(null);
  const [unsavedReason, setUnsavedReason] = useState<string | null>(null);

  const markCanvasChanged = useCallback(() => {
    setChangeKey((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!modelCatalog.catalog) {
      return;
    }

    let migratedCount = 0;
    const nextNodes = nodes.map((node) => {
      const kind = node.type === 'image-generate'
        ? 'image'
        : node.type === 'video-generate'
          ? 'video'
          : node.type === 'motion-generate'
            ? 'motion'
            : null;
      if (!kind) {
        return node;
      }

      const selectedModel = typeof node.data.model === 'string' ? node.data.model : '';
      const replacementModel = resolveCatalogModelId(modelCatalog.catalog!, kind, selectedModel);
      if (!replacementModel || replacementModel === selectedModel) {
        return node;
      }

      migratedCount += 1;
      return {
        ...node,
        data: normalizeNodeData(node.type, {
          ...node.data,
          model: replacementModel,
        } as Partial<WorkflowNodeData>),
      };
    });

    if (migratedCount > 0) {
      setNodes(nextNodes);
      markCanvasChanged();
      setError(`${migratedCount} retired workflow model${migratedCount === 1 ? ' was' : 's were'} replaced with current defaults. Review settings before running.`);
    }
  }, [markCanvasChanged, modelCatalog.catalog, nodes]);

  const authHeaders = useCallback(async () => {
    const token = effectiveSession?.access_token;
    if (!token) {
      throw new Error('Please log in to use the workflow canvas.');
    }

    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }, [effectiveSession?.access_token]);

  const graph = useMemo<WorkflowCanvasGraph>(() => ({
    version: starter.version,
    nodes,
    edges,
    viewport,
  }), [edges, nodes, starter.version, viewport]);

  const syncElementBindingNodes = useCallback((
    nextNodes: WorkflowCanvasNode[],
    nextEdges: WorkflowCanvasEdge[]
  ) => syncWorkflowGraphElementBindings({
    version: starter.version,
    nodes: nextNodes,
    edges: nextEdges,
    viewport: viewportRef.current,
  }).nodes, [starter.version]);

  const {
    applyRunUpdate,
    clearRunStateOverlay,
    renderNodes,
  } = useWorkflowCanvasRunState(nodes);

  const syncCanvasState = useCallback((canvas: WorkflowCanvasRecord) => {
    syncPersistedCanvasRef.current(canvas);
    const syncedGraph = syncWorkflowGraphElementBindings(canvas.graph);
    setNodes(syncedGraph.nodes.map((node) => ({ ...node, selected: false })));
    setEdges(syncedGraph.edges.map((edge) => decorateWorkflowEdge({ ...edge, selected: false })));
    setViewport(canvas.graph.viewport || DEFAULT_VIEWPORT);
    setActiveInspectorPanel(null);
    setActiveRunId(null);
    setOpenNodeRunMenuId(null);
    clearRunStateOverlay();
    resetSelectionRef.current();
    setError(null);
    resetTransientUiRef.current();
  }, [clearRunStateOverlay]);

  const {
    activeCanvasId,
    canvasTitle,
    canvases,
    createCanvas,
    deleteCanvas,
    isCanvasTransitionPending,
    isLoading,
    replaceActiveCanvas,
    refreshActiveCanvasRecord,
    selectCanvas,
    setCanvasTitle,
    syncSavedCanvasMetadata,
  } = useWorkflowCanvasCanvases({
    authHeaders,
    beforeCanvasTransitionRef,
    hasUnsavedChangesRef,
    onActivateCanvas: syncCanvasState,
    onError: setError,
    sessionUserId: effectiveSession?.user?.id ?? null,
  });

  const {
    activeCanvasRevision,
    hasUnsavedChanges,
    persistCanvas,
    saveState,
    syncPersistedCanvas,
  } = useWorkflowCanvasPersistence({
    activeCanvasId,
    canvasTitle,
    graph,
    changeKey,
    isLoading,
    authHeaders,
    onSavedCanvas: syncSavedCanvasMetadata,
    onConflictCanvas: syncCanvasState,
    onError: setError,
  });

  const activeCanvasHasUnsavedChanges = saveState === 'dirty' || hasUnsavedChanges();

  const workflowAssistant = useWorkflowCanvasAssistant({
    activeCanvasId,
    activeCanvasRevision,
    authHeaders,
    canvasTitle,
    graph,
    hasUnsavedChanges: activeCanvasHasUnsavedChanges,
    onApplyCanvas: replaceActiveCanvas,
    onPersistCanvas: persistCanvas,
    onUpdateCredits: updateCredits,
  });

  useEffect(() => {
    hasUnsavedChangesRef.current = saveState === 'dirty' || hasUnsavedChanges();
  }, [hasUnsavedChanges, saveState]);

  const {
    clearSelection: clearSelectionState,
    resetSelection,
    selectAllElements,
    selectedEdgeIds,
    selectedNodeIds,
    selection,
    setManualSelection,
    syncSelectionFromCanvas,
  } = useWorkflowCanvasSelection({
    nodes,
    edges,
    setNodes,
    setEdges,
  });

  const selectedNode = useMemo(() => {
    if (selectedNodeIds.length !== 1 || selectedEdgeIds.length > 0) {
      return null;
    }

    return nodes.find((node) => node.id === selectedNodeIds[0]) || null;
  }, [nodes, selectedEdgeIds.length, selectedNodeIds]);

  const selectedEdge = useMemo(() => {
    if (selectedEdgeIds.length !== 1 || selectedNodeIds.length > 0) {
      return null;
    }

    return edges.find((edge) => edge.id === selectedEdgeIds[0]) || null;
  }, [edges, selectedEdgeIds, selectedNodeIds.length]);

  const selectedNodeRunAffordance = useMemo(() => {
    if (!selectedNode) {
      return null;
    }

    return getNodeRunAffordance({
      credits,
      graph,
      node: selectedNode,
    });
  }, [credits, graph, selectedNode]);

  const {
    closeContextMenu,
    contextMenu,
    handleEdgeClick,
    handleEdgeContextMenu,
    handleNodeContextMenu,
    handlePaneContextMenu,
    resetCanvasTransientUi,
  } = useWorkflowCanvasContextMenu({
    reactFlowInstance,
    selection,
    setManualSelection,
  });

  const handleNodeContextMenuWithCleanup = useCallback((event: ReactMouseEvent, node: WorkflowCanvasNode) => {
    setOpenNodeRunMenuId(null);
    handleNodeContextMenu(event, node);
  }, [handleNodeContextMenu]);

  const handleEdgeContextMenuWithCleanup = useCallback((event: ReactMouseEvent, edge: WorkflowCanvasEdge) => {
    setOpenNodeRunMenuId(null);
    handleEdgeContextMenu(event, edge);
  }, [handleEdgeContextMenu]);

  const handleEdgeClickWithCleanup = useCallback((event: ReactMouseEvent, edge: WorkflowCanvasEdge) => {
    setOpenNodeRunMenuId(null);
    handleEdgeClick(event, edge);
  }, [handleEdgeClick]);

  const handlePaneContextMenuWithCleanup = useCallback((event: MouseEvent | ReactMouseEvent) => {
    setOpenNodeRunMenuId(null);
    handlePaneContextMenu(event);
  }, [handlePaneContextMenu]);

  const requestUnsavedDecision = useCallback((reason: string) => new Promise<UnsavedDecision>((resolve) => {
    unsavedDecisionResolverRef.current = resolve;
    setUnsavedReason(reason);
  }), []);

  const resolveUnsavedDecision = useCallback((decision: UnsavedDecision) => {
    const resolver = unsavedDecisionResolverRef.current;
    unsavedDecisionResolverRef.current = null;
    setUnsavedReason(null);
    resolver?.(decision);
  }, []);

  const confirmBeforeTransition = useCallback(async (reason: string) => {
    if (saveState === 'saving') {
      const result = await persistCanvas(canvasTitle, graph);
      return result.status === 'saved' || result.status === 'noop';
    }

    if (saveState !== 'dirty' && !hasUnsavedChanges()) {
      return true;
    }

    const decision = await requestUnsavedDecision(reason);
    if (decision === 'cancel') {
      return false;
    }

    if (decision === 'discard') {
      return true;
    }

    const result = await persistCanvas(canvasTitle, graph);
    return result.status === 'saved' || result.status === 'noop';
  }, [canvasTitle, graph, hasUnsavedChanges, persistCanvas, requestUnsavedDecision, saveState]);

  const openPreviewMedia = useCallback((preview: PreviewMediaState) => {
    setPreviewMedia(preview);
  }, []);

  const closePreviewMedia = useCallback(() => {
    setPreviewMedia(null);
  }, []);

  const openNodeEditor = useCallback((nodeId: string) => {
    setManualSelection({ nodeIds: [nodeId], edgeIds: [] });
    setOpenNodeRunMenuId(null);
    setActiveInspectorPanel('parameters');
  }, [setManualSelection]);

  const clearSelection = useCallback(() => {
    setActiveInspectorPanel(null);
    setOpenNodeRunMenuId(null);
    clearSelectionState();
  }, [clearSelectionState]);

  const focusNodeLibrary = useCallback(() => {
    nodeLibrarySearchInputRef.current?.focus();
  }, []);

  const handleSelectionChange = useCallback((nextSelection: CanvasSelectionState) => {
    const nextSelectedNodeId = nextSelection.nodeIds.length === 1 && nextSelection.edgeIds.length === 0
      ? nextSelection.nodeIds[0]
      : null;
    const nextSelectedEdgeId = nextSelection.edgeIds.length === 1 && nextSelection.nodeIds.length === 0
      ? nextSelection.edgeIds[0]
      : null;
    const shouldKeepActivePanel = (
      activeInspectorPanel === 'parameters' &&
      selectedNodeIds.length === 1 &&
      selectedEdgeIds.length === 0 &&
      selectedNodeIds[0] === nextSelectedNodeId
    ) || (
      activeInspectorPanel === 'connection' &&
      selectedEdgeIds.length === 1 &&
      selectedNodeIds.length === 0 &&
      selectedEdgeIds[0] === nextSelectedEdgeId
    );

    if (!shouldKeepActivePanel) {
      setActiveInspectorPanel(null);
    }

    if (
      openNodeRunMenuId &&
      (nextSelection.nodeIds.length !== 1 || nextSelection.nodeIds[0] !== openNodeRunMenuId || nextSelection.edgeIds.length > 0)
    ) {
      setOpenNodeRunMenuId(null);
    }

    syncSelectionFromCanvas(nextSelection);
  }, [activeInspectorPanel, openNodeRunMenuId, selectedEdgeIds, selectedNodeIds, syncSelectionFromCanvas]);

  const handleCanvasTitleChange = useCallback((title: string) => {
    setCanvasTitle(title);
    markCanvasChanged();
  }, [markCanvasChanged, setCanvasTitle]);

  useEffect(() => {
    syncPersistedCanvasRef.current = syncPersistedCanvas;
  }, [syncPersistedCanvas]);

  useEffect(() => {
    resetSelectionRef.current = resetSelection;
  }, [resetSelection]);

  useEffect(() => {
    resetTransientUiRef.current = () => {
      setOpenNodeRunMenuId(null);
      resetCanvasTransientUi();
    };
  }, [resetCanvasTransientUi]);

  useEffect(() => {
    beforeCanvasTransitionRef.current = () => confirmBeforeTransition('Save your changes before switching workflows?');
  }, [confirmBeforeTransition]);

  const handleRunUpdate = useCallback((run: WorkflowCanvasRunRecord) => {
    applyRunUpdate(run);
    setNodes((current) => mergeWorkflowRunIntoNodes(current, run));
  }, [applyRunUpdate]);

  const handleRunComplete = useCallback(() => {
    setActiveRunId(null);
    clearRunStateOverlay();
    void refreshActiveCanvasRecord();
    void refreshSessionState();
  }, [clearRunStateOverlay, refreshActiveCanvasRecord, refreshSessionState]);

  useWorkflowRunPolling({
    activeCanvasId,
    activeRunId,
    authHeaders,
    onRunUpdate: handleRunUpdate,
    onRunComplete: handleRunComplete,
  });

  useEffect(() => {
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, []);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    if (activeInspectorPanel !== 'parameters' || !selectedNode) {
      return;
    }

    let isDisposed = false;
    let frameId = 0;

    const measurePosition = () => {
      if (isDisposed) {
        return;
      }

      const canvasElement = canvasSectionRef.current;
      if (!canvasElement) {
        frameId = window.requestAnimationFrame(measurePosition);
        return;
      }

      const canvasBounds = canvasElement.getBoundingClientRect();
      const flowNode = reactFlowInstance?.getNode(selectedNode.id) as
        | {
            position?: { x: number; y: number };
            positionAbsolute?: { x: number; y: number };
            measured?: { width?: number; height?: number };
            width?: number;
            height?: number;
          }
        | undefined;
      const escapedNodeId = selectedNode.id.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      const nodeElement = canvasElement.querySelector<HTMLElement>(`.react-flow__node[data-id="${escapedNodeId}"]`);
      const nodeBounds = nodeElement?.getBoundingClientRect();
      const fallbackNodePosition = flowNode?.positionAbsolute ?? flowNode?.position ?? selectedNode.position;
      const screenPosition = reactFlowInstance?.flowToScreenPosition
        ? reactFlowInstance.flowToScreenPosition(fallbackNodePosition)
        : fallbackNodePosition;
      const nextPosition = getNodeAnchoredPopupPosition({
        canvasBounds,
        nodeBounds: {
          left: nodeBounds?.left ?? screenPosition.x,
          top: nodeBounds?.top ?? screenPosition.y,
          width: nodeBounds?.width ?? flowNode?.measured?.width ?? flowNode?.width ?? 248,
          height: nodeBounds?.height ?? flowNode?.measured?.height ?? flowNode?.height ?? 136,
        },
        popupWidth: 420,
        popupHeight: 480,
      });

      setNodePopupPosition((current) => (
        areAnchoredPopupPositionsEqual(current, nextPosition) ? current : nextPosition
      ));

      frameId = window.requestAnimationFrame(measurePosition);
    };

    frameId = window.requestAnimationFrame(measurePosition);

    return () => {
      isDisposed = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [activeInspectorPanel, reactFlowInstance, selectedNode]);

  useEffect(() => {
    if (!reactFlowInstance) {
      return;
    }

    if (skipNextViewportSyncRef.current) {
      skipNextViewportSyncRef.current = false;
      return;
    }

    void reactFlowInstance.setViewport(viewport, { duration: 0 });
  }, [reactFlowInstance, viewport]);

  useEffect(() => {
    const canvasSection = canvasSectionRef.current;
    if (!canvasSection || !reactFlowInstance) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      if (!event.shiftKey) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;

      const nextViewport = {
        ...viewport,
        x: viewport.x - (horizontalDelta / Math.max(viewport.zoom, 0.1)) * 0.65,
      };

      skipNextViewportSyncRef.current = true;
      setViewport(nextViewport);
      void reactFlowInstance.setViewport(nextViewport, { duration: 0 });
    };

    canvasSection.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => canvasSection.removeEventListener('wheel', onWheel, true);
  }, [reactFlowInstance, viewport]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges()) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => (
    () => {
      if (unsavedDecisionResolverRef.current) {
        unsavedDecisionResolverRef.current('cancel');
        unsavedDecisionResolverRef.current = null;
      }
    }
  ), []);

  const updateNode = useCallback((nodeId: string, updates: Partial<WorkflowNodeData>) => {
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        changed = true;
        return {
          ...node,
          data: normalizeNodeData(node.type as WorkflowNodeKind, {
            ...node.data,
            ...updates,
          }),
        };
      });

      return changed ? next : current;
    });
    markCanvasChanged();
  }, [markCanvasChanged]);

  const handleConnect = useCallback((connection: Connection) => {
    const validation = validateWorkflowConnectionForGraph({
      graph,
      sourceNodeId: connection.source,
      sourceHandle: connection.sourceHandle as WorkflowHandleType | null,
      targetNodeId: connection.target,
      targetHandle: connection.targetHandle as WorkflowHandleType | null,
    });

    if (!validation.valid) {
      setError(validation.message || 'That connection is not supported.');
      return;
    }

    const nextEdges = addEdge(decorateWorkflowEdge({
      ...connection,
    } as WorkflowCanvasEdge), edges);
    setNodes(syncElementBindingNodes(graph.nodes, nextEdges));
    setEdges(nextEdges);
    closeContextMenu();
    markCanvasChanged();
  }, [closeContextMenu, edges, graph, markCanvasChanged, syncElementBindingNodes]);

  const addNode = useCallback((type: WorkflowNodeKind, position?: { x: number; y: number }) => {
    const canvasBounds = canvasSectionRef.current?.getBoundingClientRect();
    const nextPosition = position ?? (
      reactFlowInstance && canvasBounds
        ? reactFlowInstance.screenToFlowPosition({
            x: canvasBounds.left + Math.min(canvasBounds.width * 0.45, 520),
            y: canvasBounds.top + Math.min(canvasBounds.height * 0.28, 220),
          })
        : { x: 300, y: 220 }
    );

    const nextNode = createWorkflowNode(type, nextPosition);
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      { ...nextNode, selected: true },
    ]);
    setEdges((current) => current.map((edge) => decorateWorkflowEdge({ ...edge, selected: false })));
    syncSelectionFromCanvas({ nodeIds: [nextNode.id], edgeIds: [] });
    setActiveInspectorPanel(null);
    resetCanvasTransientUi();
    markCanvasChanged();
  }, [markCanvasChanged, reactFlowInstance, resetCanvasTransientUi, syncSelectionFromCanvas]);

  const deleteSelection = useCallback((targetSelection?: CanvasSelectionState) => {
    const nextSelection = targetSelection ?? selection;
    if (nextSelection.nodeIds.length === 0 && nextSelection.edgeIds.length === 0) {
      return;
    }

    const nodeIdSet = new Set(nextSelection.nodeIds);
    const edgeIdSet = new Set(nextSelection.edgeIds);
    const nextNodes = nodes.filter((node) => !nodeIdSet.has(node.id));
    const nextEdges = edges.filter((edge) => (
      !edgeIdSet.has(edge.id) &&
      !nodeIdSet.has(edge.source) &&
      !nodeIdSet.has(edge.target)
    ));
    setNodes(syncElementBindingNodes(nextNodes, nextEdges));
    setEdges(nextEdges);
    syncSelectionFromCanvas({ nodeIds: [], edgeIds: [] });
    setActiveInspectorPanel(null);
    setOpenNodeRunMenuId(null);
    resetCanvasTransientUi();
    markCanvasChanged();
  }, [edges, markCanvasChanged, nodes, resetCanvasTransientUi, selection, syncElementBindingNodes, syncSelectionFromCanvas]);

  const handleDeleteNode = useCallback((nodeId: string) => {
    const removedEdgeIds = edges
      .filter((edge) => edge.source === nodeId || edge.target === nodeId)
      .map((edge) => edge.id);

    const nextNodes = nodes.filter((node) => node.id !== nodeId);
    const didDelete = nextNodes.length !== nodes.length;
    const nextEdges = edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);

    setNodes(syncElementBindingNodes(nextNodes, nextEdges));
    setEdges(nextEdges);

    if (!didDelete) {
      return;
    }

    const nextSelection = {
      nodeIds: selectedNodeIds.filter((selectedId) => selectedId !== nodeId),
      edgeIds: selectedEdgeIds.filter((selectedId) => !removedEdgeIds.includes(selectedId)),
    };

    setManualSelection(nextSelection);
    setActiveInspectorPanel(null);
    setOpenNodeRunMenuId((current) => (current === nodeId ? null : current));
    closeContextMenu();
    markCanvasChanged();
  }, [closeContextMenu, edges, markCanvasChanged, nodes, selectedEdgeIds, selectedNodeIds, setManualSelection, syncElementBindingNodes]);

  const handleDeleteEdge = useCallback((edgeId: string) => {
    const nextEdges = edges.filter((edge) => edge.id !== edgeId);
    const didDelete = nextEdges.length !== edges.length;
    setNodes(syncElementBindingNodes(nodes, nextEdges));
    setEdges(nextEdges);

    if (!didDelete) {
      return;
    }

    if (selectedEdgeIds.includes(edgeId)) {
      setManualSelection({
        nodeIds: selectedNodeIds,
        edgeIds: selectedEdgeIds.filter((selectedId) => selectedId !== edgeId),
      });
      setActiveInspectorPanel(null);
    }

    setOpenNodeRunMenuId(null);
    closeContextMenu();
    markCanvasChanged();
  }, [closeContextMenu, edges, markCanvasChanged, nodes, selectedEdgeIds, selectedNodeIds, setManualSelection, syncElementBindingNodes]);

  const startWorkflowRun = useCallback(async (nodeId: string, mode: 'node' | 'branch') => {
    if (!activeCanvasId || activeRunId) {
      return;
    }

    setError(null);
    setActiveInspectorPanel(null);
    setOpenNodeRunMenuId(null);
    closeContextMenu();
    setManualSelection({ nodeIds: [nodeId], edgeIds: [] });

    if (saveState === 'saving' || hasUnsavedChanges()) {
      const saveResult = await persistCanvas(canvasTitle, graph);
      if (saveResult.status !== 'saved' && saveResult.status !== 'noop') {
        return;
      }
    }

    try {
      const response = await fetch(`/api/workflow-canvases/${activeCanvasId}/run`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          startNodeId: nodeId,
          mode,
          catalogRevision: modelCatalog.catalog?.revision ?? null,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to start workflow run.');
      }

      if (typeof data.runId === 'string' && data.runId.length > 0) {
        setActiveRunId(data.runId);
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Failed to start workflow run.');
    }
  }, [
    activeCanvasId,
    activeRunId,
    authHeaders,
    canvasTitle,
    closeContextMenu,
    graph,
    hasUnsavedChanges,
    modelCatalog.catalog?.revision,
    persistCanvas,
    saveState,
    setManualSelection,
  ]);

  const handleRunNodeFromNode = useCallback((nodeId: string) => {
    void startWorkflowRun(nodeId, 'node');
  }, [startWorkflowRun]);

  const handleRunBranchFromNode = useCallback((nodeId: string) => {
    void startWorkflowRun(nodeId, 'branch');
  }, [startWorkflowRun]);

  const nodeRunStateById = useMemo(() => {
    return Object.fromEntries(nodes.map((node) => {
      if (node.type === 'note' || node.type === 'group') {
        return [node.id, undefined];
      }

      const runAffordance = getNodeRunAffordance({
        credits,
        graph,
        node,
      });

      return [node.id, {
        canRunBranch: true,
        canRunNode: isRunnableNode(node),
        runBranchDisabled: Boolean(activeRunId) || Boolean(runAffordance?.runBranchDisabled),
        runNodeDisabled: Boolean(activeRunId) || Boolean(runAffordance?.runNodeDisabled),
      }];
    }));
  }, [activeRunId, credits, graph, nodes]);

  const nodeActionRuntimeById = useMemo<Record<string, WorkflowNodeRuntimeData | undefined>>(() => {
    return Object.fromEntries(nodes.map((node) => {
      const runState = nodeRunStateById[node.id];
      const runAffordance = getNodeRunAffordance({
        credits,
        graph,
        node,
      });
      const capabilityValidation = inspectWorkflowNodeCapabilities(graph, node);

      return [node.id, {
        assistantManaged: Boolean(node.data.managed),
        capabilityValidation,
        isRunControlDisabled: Boolean(activeRunId),
        isRunMenuOpen: openNodeRunMenuId === node.id,
        onCloseRunMenu: () => {
          setOpenNodeRunMenuId((current) => (current === node.id ? null : current));
        },
        onDeleteNode: () => {
          handleDeleteNode(node.id);
        },
        onOpenRunMenu: runState
          ? () => {
              setManualSelection({ nodeIds: [node.id], edgeIds: [] });
              setActiveInspectorPanel(null);
              setOpenNodeRunMenuId((current) => (current === node.id ? null : node.id));
            }
          : undefined,
        onRunBranch: runState?.canRunBranch
          ? () => {
              handleRunBranchFromNode(node.id);
            }
          : undefined,
        onRunNode: runState?.canRunNode
          ? () => {
              handleRunNodeFromNode(node.id);
            }
          : undefined,
        runBranchDisabled: runState?.runBranchDisabled,
        runMessage: activeRunId
          ? 'A workflow run is already in progress.'
          : runAffordance?.message ?? null,
        runNodeDisabled: runState?.runNodeDisabled,
        showPlayControl: node.type !== 'note' && node.type !== 'group',
      }];
    }));
  }, [
    activeRunId,
    credits,
    graph,
    handleDeleteNode,
    handleRunBranchFromNode,
    handleRunNodeFromNode,
    nodeRunStateById,
    nodes,
    openNodeRunMenuId,
    setManualSelection,
  ]);

  const assistantPreviewRuntimeById = useMemo<Record<string, WorkflowNodeRuntimeData | undefined>>(() => {
    if (!workflowAssistant.previewGraph) {
      return {};
    }

    return Object.fromEntries(workflowAssistant.previewGraph.nodes.map((node) => [node.id, {
      assistantManaged: Boolean(node.data.managed),
      assistantPreviewState: workflowAssistant.previewNodeStates[node.id] ?? null,
      showPlayControl: false,
    } satisfies WorkflowNodeRuntimeData]));
  }, [workflowAssistant.previewGraph, workflowAssistant.previewNodeStates]);

  const visibleNodes = workflowAssistant.previewGraph?.nodes ?? renderNodes;
  const visibleEdges = workflowAssistant.previewGraph?.edges ?? edges;
  const visibleNodeActionRuntimeById = workflowAssistant.previewGraph
    ? assistantPreviewRuntimeById
    : nodeActionRuntimeById;
  const visibleNodeRunStateById = workflowAssistant.previewGraph ? {} : nodeRunStateById;
  const assistantCreditsLabel = credits !== null
    ? `${credits} credits`
    : `${WORKFLOW_ASSISTANT_COST} credits / prompt`;

  const copySelection = useCallback((targetSelection?: CanvasSelectionState) => {
    const nextSelection = targetSelection ?? selection;
    if (nextSelection.nodeIds.length === 0) {
      return false;
    }

    const nodeIdSet = new Set(nextSelection.nodeIds);
    clipboardRef.current = {
      nodes: nodes
        .filter((node) => nodeIdSet.has(node.id))
        .map((node) => ({ ...node, selected: false })),
      edges: edges
        .filter((edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target))
        .map((edge) => ({ ...edge, selected: false })),
    };

    return true;
  }, [edges, nodes, selection]);

  const pasteClipboard = useCallback(() => {
    const snapshot = clipboardRef.current;
    if (!snapshot || snapshot.nodes.length === 0) {
      return;
    }

    const result = duplicateWorkflowSelection(snapshot, snapshot.nodes.map((node) => node.id));
    const nextEdges = [
      ...edges.map((edge) => decorateWorkflowEdge({ ...edge, selected: false })),
      ...result.duplicatedEdges.map((edge) => decorateWorkflowEdge({ ...edge, selected: true })),
    ];
    const nextNodes = syncElementBindingNodes([
      ...nodes.map((node) => ({ ...node, selected: false })),
      ...result.duplicatedNodes.map((node) => ({ ...node, selected: true })),
    ], nextEdges);
    setNodes(nextNodes);
    setEdges(nextEdges);
    syncSelectionFromCanvas({
      nodeIds: result.duplicatedNodes.map((node) => node.id),
      edgeIds: result.duplicatedEdges.map((edge) => edge.id),
    });
    setActiveInspectorPanel(null);
    resetCanvasTransientUi();
    markCanvasChanged();
  }, [edges, markCanvasChanged, nodes, resetCanvasTransientUi, syncElementBindingNodes, syncSelectionFromCanvas]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditableTarget = Boolean(
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      );

      if (event.key === 'Escape') {
        if (previewMedia) {
          event.preventDefault();
          setPreviewMedia(null);
          return;
        }

        if (contextMenu) {
          event.preventDefault();
          closeContextMenu();
          return;
        }

        if (openNodeRunMenuId) {
          event.preventDefault();
          setOpenNodeRunMenuId(null);
          return;
        }

        if (activeInspectorPanel) {
          event.preventDefault();
          setActiveInspectorPanel(null);
          return;
        }

        if (selection.nodeIds.length > 0 || selection.edgeIds.length > 0) {
          event.preventDefault();
          clearSelection();
        }
        return;
      }

      if (isEditableTarget) {
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        focusNodeLibrary();
        return;
      }

      if (event.key === 'Enter' && selection.nodeIds.length === 1 && selection.edgeIds.length === 0) {
        event.preventDefault();
        openNodeEditor(selection.nodeIds[0]);
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection.nodeIds.length > 0 || selection.edgeIds.length > 0) {
          event.preventDefault();
          deleteSelection();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        copySelection();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'x') {
        if (selection.nodeIds.length > 0 || selection.edgeIds.length > 0) {
          event.preventDefault();
          copySelection();
          deleteSelection();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        pasteClipboard();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllElements();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeInspectorPanel,
    clearSelection,
    closeContextMenu,
    contextMenu,
    copySelection,
    deleteSelection,
    focusNodeLibrary,
    openNodeRunMenuId,
    openNodeEditor,
    pasteClipboard,
    previewMedia,
    selectAllElements,
    selection,
  ]);

  const handleNodeClick = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    closeContextMenu();
    setOpenNodeRunMenuId(null);
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      return;
    }

    setActiveInspectorPanel(null);
  }, [closeContextMenu]);

  const handleNodeDoubleClick = useCallback((event: ReactMouseEvent, node: WorkflowCanvasNode) => {
    event.stopPropagation();
    closeContextMenu();
    openNodeEditor(node.id);
  }, [closeContextMenu, openNodeEditor]);

  const handleNodeDragStart = useCallback(() => {
    closeContextMenu();
    setOpenNodeRunMenuId(null);
    setActiveInspectorPanel(null);
  }, [closeContextMenu]);

  const handleCommitNodePositions = useCallback((updates: Array<{ id: string; position: { x: number; y: number } }>) => {
    if (updates.length === 0) {
      return;
    }

    const positionById = new Map(updates.map((update) => [update.id, update.position]));
    let didChange = false;

    setNodes((current) => {
      const next = current.map((node) => {
        const nextPosition = positionById.get(node.id);
        if (!nextPosition || (node.position.x === nextPosition.x && node.position.y === nextPosition.y)) {
          return node;
        }

        didChange = true;
        return {
          ...node,
          position: nextPosition,
        };
      });

      return didChange ? next : current;
    });

    if (didChange) {
      markCanvasChanged();
    }
  }, [markCanvasChanged]);

  const handleMoveEnd = useCallback((nextViewport: { x: number; y: number; zoom: number }) => {
    if (areViewportsEqual(viewportRef.current, nextViewport)) {
      return;
    }

    skipNextViewportSyncRef.current = true;
    setViewport(nextViewport);
    markCanvasChanged();
  }, [markCanvasChanged]);

  const uploadAssetToBucket = useCallback(async (
    file: File,
    bucket: WorkflowAssetUploadBucket
  ) => {
    return uploadWorkflowAssetWithSignedIntent(file, bucket);
  }, []);

  const handlePaneClick = useCallback(() => {
    clearSelection();
    closeContextMenu();
    setOpenNodeRunMenuId(null);
  }, [clearSelection, closeContextMenu]);

  const handleNavigateBack = useCallback(async () => {
    const canLeave = await confirmBeforeTransition('Save your changes before leaving this workflow?');
    if (canLeave) {
      router.push('/create');
    }
  }, [confirmBeforeTransition, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <>
      <div className="h-[calc(100vh-4rem)] overflow-hidden bg-[#060606] text-white">
        <div className="flex h-full">
          <WorkflowCanvasChrome
            canvasTitle={canvasTitle}
            canvasOverlay={(
              <>
                <WorkflowCanvasInspector
                  activePanel={activeInspectorPanel}
                  graph={graph}
                  nodePopupPosition={nodePopupPosition}
                  nodes={nodes}
                  onCreditsUpdate={updateCredits}
                  runAffordance={selectedNodeRunAffordance}
                  selectedEdge={selectedEdge}
                  selectedNode={selectedNode}
                  selection={selection}
                  onClearSelection={clearSelection}
                  onDeleteEdge={(edgeId) => {
                    const targetEdgeId = edgeId ?? selectedEdge?.id;
                    if (targetEdgeId) {
                      handleDeleteEdge(targetEdgeId);
                    }
                  }}
                  onDeleteNode={() => {
                    if (selectedNode) {
                      handleDeleteNode(selectedNode.id);
                    }
                  }}
                  onDeleteSelection={() => deleteSelection()}
                  onDuplicateSelection={() => undefined}
                  onOpenPreview={openPreviewMedia}
                  onRunBranch={() => {
                    if (selectedNode) {
                      handleRunBranchFromNode(selectedNode.id);
                    }
                  }}
                  onRunNode={() => {
                    if (selectedNode) {
                      handleRunNodeFromNode(selectedNode.id);
                    }
                  }}
                  onSetError={setError}
                  onPanelChange={setActiveInspectorPanel}
                  onUpdateNode={updateNode}
                  onUploadAsset={uploadAssetToBucket}
                />
                <WorkflowAssistantDrawer
                  availability={workflowAssistant.availability}
                  creditsLabel={assistantCreditsLabel}
                  error={workflowAssistant.error}
                  input={workflowAssistant.input}
                  isApplying={workflowAssistant.isApplying}
                  isDiscarding={workflowAssistant.isDiscarding}
                  isLoading={workflowAssistant.isLoading}
                  isOpen={workflowAssistant.isOpen}
                  isProposalStale={workflowAssistant.isProposalStale}
                  isSubmitting={workflowAssistant.isSubmitting}
                  messages={workflowAssistant.messages}
                  onApplyProposal={() => {
                    void workflowAssistant.applyProposal();
                  }}
                  onClose={workflowAssistant.closeAssistant}
                  onDiscardProposal={() => {
                    void workflowAssistant.discardProposal();
                  }}
                  onInputChange={workflowAssistant.setInput}
                  onOpen={workflowAssistant.openAssistant}
                  onSendMessage={() => {
                    void workflowAssistant.sendMessage();
                  }}
                  proposal={workflowAssistant.proposal}
                  setupMessage={workflowAssistant.setupMessage}
                />
              </>
            )}
            leftRail={(
              <WorkflowCanvasLeftRail
                activeCanvasId={activeCanvasId}
                activeCanvasHasUnsavedChanges={activeCanvasHasUnsavedChanges}
                canvases={canvases}
                isCanvasTransitionPending={isCanvasTransitionPending}
                nodeLibrary={WORKFLOW_NODE_LIBRARY}
                onAddNode={addNode}
                onCreateCanvas={() => {
                  void createCanvas();
                }}
                onDeleteCanvas={(canvasId) => {
                  void deleteCanvas(canvasId);
                }}
                onSelectCanvas={(canvas) => {
                  void selectCanvas(canvas);
                }}
                searchInputRef={nodeLibrarySearchInputRef}
              />
            )}
            headerActions={(
              <WorkflowCanvasShareActions
                activeCanvasId={activeCanvasId}
                activeCanvasHasUnsavedChanges={activeCanvasHasUnsavedChanges}
                authHeaders={authHeaders}
                canvasTitle={canvasTitle}
                graph={graph}
                initialImportShareId={initialImportShareId}
                onBeforeImport={() => confirmBeforeTransition('Save your changes before importing another workflow?')}
                onImportComplete={replaceActiveCanvas}
                onPersistCanvas={persistCanvas}
              />
            )}
            onCanvasTitleChange={handleCanvasTitleChange}
            onNavigateBack={() => {
              void handleNavigateBack();
            }}
            onSave={() => {
              void persistCanvas(canvasTitle, graph);
            }}
            saveState={saveState}
          >
            <WorkflowCanvasSurface
              canvasSectionRef={canvasSectionRef}
              contextMenu={workflowAssistant.previewGraph ? null : contextMenu}
              edges={visibleEdges}
              error={error}
              isReadOnly={Boolean(workflowAssistant.previewGraph)}
              nodeActionRuntimeById={visibleNodeActionRuntimeById}
              nodeRunStateById={visibleNodeRunStateById}
              onAddNote={(position) => addNode('note', position)}
              onClearSelection={clearSelection}
              onCloseContextMenu={closeContextMenu}
              onClosePreview={closePreviewMedia}
              onCommitNodePositions={handleCommitNodePositions}
              onConnect={handleConnect}
              onDeleteEdge={handleDeleteEdge}
              onDeleteSelection={() => deleteSelection()}
              onEditNode={openNodeEditor}
              onEdgeClick={handleEdgeClickWithCleanup}
              onEdgeContextMenu={handleEdgeContextMenuWithCleanup}
              onFitView={() => {
                void reactFlowInstance?.fitView({ padding: 0.16, duration: 240 });
              }}
              onMoveEnd={handleMoveEnd}
              onNodeClick={handleNodeClick}
              onNodeContextMenu={handleNodeContextMenuWithCleanup}
              onNodeDoubleClick={handleNodeDoubleClick}
              onNodeDragStart={handleNodeDragStart}
              onOpenPreview={openPreviewMedia}
              onPaneClick={handlePaneClick}
              onPaneContextMenu={handlePaneContextMenuWithCleanup}
              onRunBranch={handleRunBranchFromNode}
              onRunNode={handleRunNodeFromNode}
              onSelectAll={selectAllElements}
              onSelectionChange={handleSelectionChange}
              previewMedia={previewMedia}
              renderNodes={visibleNodes}
              selection={selection}
              setReactFlowInstance={setReactFlowInstance}
            />
          </WorkflowCanvasChrome>
        </div>
      </div>

      <UnsavedChangesDialog
        isOpen={Boolean(unsavedReason)}
        reason={unsavedReason ?? ''}
        onCancel={() => resolveUnsavedDecision('cancel')}
        onDiscard={() => resolveUnsavedDecision('discard')}
        onSave={() => resolveUnsavedDecision('save')}
      />
    </>
  );
}
