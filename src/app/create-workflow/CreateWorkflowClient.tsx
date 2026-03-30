'use client';

import '@xyflow/react/dist/style.css';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from '@xyflow/react';
import { Loader2 } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  createWorkflowGraphFromBlueprint,
  type WorkflowBlueprint,
  type WorkflowPlannerInput,
} from '@/lib/workflow-blueprint';
import {
  DEFAULT_VIEWPORT,
  createStarterGraph,
  createWorkflowNode,
  duplicateWorkflowSelection,
  normalizeNodeData,
  validateWorkflowConnection,
  type WorkflowCanvasEdge,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type WorkflowCanvasRecord,
  type WorkflowHandleType,
  type WorkflowNodeData,
  type WorkflowNodeKind,
} from '@/lib/workflow-canvas';
import { getClientE2EAuthState } from '@/lib/e2e-auth';
import { supabase } from '@/lib/supabase';
import { WorkflowCanvasChrome } from './WorkflowCanvasChrome';
import { WORKFLOW_NODE_LIBRARY, decorateWorkflowEdge } from './WorkflowCanvasNodes';
import { WorkflowCanvasSurface } from './WorkflowCanvasSurface';
import {
  DEFAULT_PLANNER_INPUT,
  PlannerAssistantDrawer as WorkflowPlannerAssistantDrawer,
} from './WorkflowPlannerDrawer';
import { useWorkflowCanvasCanvases } from './useWorkflowCanvasCanvases';
import { useWorkflowCanvasContextMenu } from './useWorkflowCanvasContextMenu';
import { useWorkflowCanvasPersistence } from './useWorkflowCanvasPersistence';
import { useWorkflowCanvasRunState, mergePersistedRunStateIntoNodes } from './useWorkflowCanvasRunState';
import { useWorkflowCanvasSelection } from './useWorkflowCanvasSelection';
import { useWorkflowRunPolling } from './useWorkflowRunPolling';
import type {
  CanvasSelectionState,
  PreviewMediaState,
} from './workflowCanvasUiTypes';
import { getNodeRunAffordance } from './workflowCanvasUiUtils';

function areViewportsEqual(
  left: { x: number; y: number; zoom: number },
  right: { x: number; y: number; zoom: number }
) {
  return left.x === right.x && left.y === right.y && left.zoom === right.zoom;
}

export default function CreateWorkflowClient() {
  const { credits, session } = useAuth();
  const e2eAuth = useMemo(() => getClientE2EAuthState(), []);
  const effectiveSession = session ?? e2eAuth?.session ?? null;
  const effectiveCredits = credits ?? e2eAuth?.credits ?? null;
  const canvasSectionRef = useRef<HTMLElement | null>(null);
  const beforeCanvasTransitionRef = useRef<() => Promise<boolean>>(async () => true);
  const syncPersistedCanvasRef = useRef<(canvas: WorkflowCanvasRecord) => void>(() => undefined);
  const resetSelectionRef = useRef<() => void>(() => undefined);
  const resetTransientUiRef = useRef<() => void>(() => undefined);
  const clearRunStateOverlayRef = useRef<() => void>(() => undefined);
  const skipNextViewportSyncRef = useRef(false);
  const starter = useMemo(() => createStarterGraph(), []);

  const [error, setError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [isPlannerOpen, setIsPlannerOpen] = useState(false);
  const [plannerInput, setPlannerInput] = useState<WorkflowPlannerInput>(DEFAULT_PLANNER_INPUT);
  const [plannerError, setPlannerError] = useState<string | null>(null);
  const [generatedBlueprint, setGeneratedBlueprint] = useState<WorkflowBlueprint | null>(null);
  const [generatedBlueprintInput, setGeneratedBlueprintInput] = useState<WorkflowPlannerInput | null>(null);
  const [remainingPlannerCredits, setRemainingPlannerCredits] = useState<number | null>(null);
  const [isGeneratingBlueprint, setIsGeneratingBlueprint] = useState(false);
  const [isApplyingBlueprint, setIsApplyingBlueprint] = useState(false);
  const [previewMedia, setPreviewMedia] = useState<PreviewMediaState | null>(null);
  const [nodes, setNodes] = useState<WorkflowCanvasNode[]>(starter.nodes);
  const [edges, setEdges] = useState<WorkflowCanvasEdge[]>(starter.edges.map(decorateWorkflowEdge));
  const [autosaveKey, setAutosaveKey] = useState(0);
  const viewportRef = useRef(viewport);

  const markCanvasChanged = useCallback(() => {
    setAutosaveKey((current) => current + 1);
  }, []);

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

  const syncCanvasState = useCallback((canvas: WorkflowCanvasRecord) => {
    syncPersistedCanvasRef.current(canvas);
    setNodes(canvas.graph.nodes.map((node) => ({ ...node, selected: false })));
    setEdges(canvas.graph.edges.map((edge) => decorateWorkflowEdge({ ...edge, selected: false })));
    setViewport(canvas.graph.viewport || DEFAULT_VIEWPORT);
    resetSelectionRef.current();
    clearRunStateOverlayRef.current();
    setActiveRunId(null);
    setError(null);
    resetTransientUiRef.current();
  }, []);

  const {
    activeCanvasId,
    canvasTitle,
    canvases,
    createCanvas,
    deleteCanvas,
    isCanvasTransitionPending,
    isLoading,
    refreshActiveCanvasRecord,
    replaceActiveCanvas,
    selectCanvas,
    setCanvasTitle,
    syncSavedCanvasMetadata,
  } = useWorkflowCanvasCanvases({
    authHeaders,
    beforeCanvasTransitionRef,
    onActivateCanvas: syncCanvasState,
    onError: setError,
    sessionToken: effectiveSession?.access_token ?? null,
  });

  const graph = useMemo<WorkflowCanvasGraph>(() => ({
    version: starter.version,
    nodes,
    edges,
    viewport,
  }), [edges, nodes, starter.version, viewport]);

  const {
    flushActiveCanvasBeforeTransition,
    persistCanvas,
    saveState,
    syncPersistedCanvas,
  } = useWorkflowCanvasPersistence({
    activeCanvasId,
    canvasTitle,
    graph,
    autosaveKey,
    isLoading,
    authHeaders,
    onSavedCanvas: syncSavedCanvasMetadata,
    onConflictCanvas: replaceActiveCanvas,
    onError: setError,
  });

  syncPersistedCanvasRef.current = syncPersistedCanvas;
  beforeCanvasTransitionRef.current = flushActiveCanvasBeforeTransition;

  const handleNodesChange = useCallback((changes: NodeChange<WorkflowCanvasNode>[]) => {
    const nextChanges = changes.filter((change) => change.type !== 'dimensions');
    if (nextChanges.length > 0) {
      setNodes((current) => applyNodeChanges(nextChanges, current));
    }

    if (changes.some((change) => change.type !== 'select' && change.type !== 'dimensions')) {
      markCanvasChanged();
    }
  }, [markCanvasChanged]);

  const handleEdgesChange = useCallback((changes: EdgeChange<WorkflowCanvasEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
    if (changes.some((change) => change.type !== 'select')) {
      markCanvasChanged();
    }
  }, [markCanvasChanged]);

  const {
    clearSelection: clearSelectionState,
    resetSelection,
    selectAllElements: selectAllElementsState,
    selectedEdgeIds,
    selectedNodeIds,
    selection,
    selectionCount,
    setManualSelection,
    syncSelectionFromCanvas,
  } = useWorkflowCanvasSelection({
    nodes,
    edges,
    setNodes,
    setEdges,
  });

  resetSelectionRef.current = resetSelection;

  const {
    applyRunUpdate,
    clearRunStateOverlay,
    renderNodes,
  } = useWorkflowCanvasRunState(nodes);

  clearRunStateOverlayRef.current = clearRunStateOverlay;

  const renderEdges = edges;
  const renderGraph = useMemo<WorkflowCanvasGraph>(() => ({
    version: starter.version,
    nodes: renderNodes,
    edges: renderEdges,
    viewport,
  }), [renderEdges, renderNodes, starter.version, viewport]);

  const renderNodeById = useMemo(
    () => new Map(renderNodes.map((node) => [node.id, node])),
    [renderNodes]
  );
  const renderEdgeById = useMemo(
    () => new Map(renderEdges.map((edge) => [edge.id, edge])),
    [renderEdges]
  );

  const selectedNode = useMemo(() => {
    if (selectedNodeIds.length !== 1 || selectedEdgeIds.length > 0) {
      return null;
    }

    return renderNodeById.get(selectedNodeIds[0]) || null;
  }, [renderNodeById, selectedEdgeIds.length, selectedNodeIds]);

  const selectedEdge = useMemo(() => {
    if (selectedEdgeIds.length !== 1 || selectedNodeIds.length > 0) {
      return null;
    }

    return renderEdgeById.get(selectedEdgeIds[0]) || null;
  }, [renderEdgeById, selectedEdgeIds, selectedNodeIds.length]);

  const selectedKind = selectedNode?.type;

  const {
    clearEdgeFloatingEditor,
    closeContextMenu,
    contextMenu,
    edgeEditorPosition,
    editorPosition,
    handleEdgeClick,
    handleEdgeContextMenu,
    handleNodeContextMenu,
    handlePaneContextMenu,
    resetCanvasTransientUi,
  } = useWorkflowCanvasContextMenu({
    canvasSectionRef,
    reactFlowInstance,
    nodes: renderNodes,
    selection,
    selectedEdge,
    selectedKind,
    selectedNode,
    setManualSelection,
  });

  resetTransientUiRef.current = resetCanvasTransientUi;

  const runAffordance = useMemo(() => getNodeRunAffordance({
    credits: effectiveCredits,
    graph: renderGraph,
    node: selectedNode,
  }), [effectiveCredits, renderGraph, selectedNode]);

  const openPreviewMedia = useCallback((preview: PreviewMediaState) => {
    setPreviewMedia(preview);
  }, []);

  const closePreviewMedia = useCallback(() => {
    setPreviewMedia(null);
  }, []);

  const clearSelection = useCallback(() => {
    clearEdgeFloatingEditor();
    clearSelectionState();
  }, [clearEdgeFloatingEditor, clearSelectionState]);

  const handleCanvasTitleChange = useCallback((title: string) => {
    setCanvasTitle(title);
    markCanvasChanged();
  }, [markCanvasChanged, setCanvasTitle]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

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
    if (!previewMedia) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewMedia(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewMedia]);

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
    if (!validateWorkflowConnection(connection.sourceHandle as WorkflowHandleType | null, connection.targetHandle as WorkflowHandleType | null)) {
      setError('That connection is not supported. Try matching prompt, image, or video handles.');
      return;
    }

    setEdges((current) => addEdge(decorateWorkflowEdge({
      ...connection,
    } as WorkflowCanvasEdge), current));
    closeContextMenu();
    markCanvasChanged();
  }, [closeContextMenu, markCanvasChanged]);

  const addNode = useCallback((type: WorkflowNodeKind, position?: { x: number; y: number }) => {
    const canvasBounds = canvasSectionRef.current?.getBoundingClientRect();
    const nextPosition = position ?? (
      reactFlowInstance && canvasBounds
        ? reactFlowInstance.screenToFlowPosition({
            x: canvasBounds.left + Math.min(canvasBounds.width * 0.45, 520),
            y: canvasBounds.top + Math.min(canvasBounds.height * 0.4, 360),
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
    resetCanvasTransientUi();
    markCanvasChanged();
    return nextNode;
  }, [markCanvasChanged, reactFlowInstance, resetCanvasTransientUi, syncSelectionFromCanvas]);

  const deleteSelection = useCallback((targetSelection?: CanvasSelectionState) => {
    const nextSelection = targetSelection ?? selection;
    if (nextSelection.nodeIds.length === 0 && nextSelection.edgeIds.length === 0) {
      return;
    }

    const nodeIdSet = new Set(nextSelection.nodeIds);
    const edgeIdSet = new Set(nextSelection.edgeIds);
    setNodes((current) => current.filter((node) => !nodeIdSet.has(node.id)));
    setEdges((current) => current.filter((edge) => (
      !edgeIdSet.has(edge.id) &&
      !nodeIdSet.has(edge.source) &&
      !nodeIdSet.has(edge.target)
    )));
    syncSelectionFromCanvas({ nodeIds: [], edgeIds: [] });
    resetCanvasTransientUi();
    markCanvasChanged();
  }, [markCanvasChanged, resetCanvasTransientUi, selection, syncSelectionFromCanvas]);

  const duplicateSelection = useCallback((targetSelection?: CanvasSelectionState) => {
    const nextSelection = targetSelection ?? selection;
    if (nextSelection.nodeIds.length === 0) {
      return;
    }

    const result = duplicateWorkflowSelection({ nodes, edges }, nextSelection.nodeIds);
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...result.duplicatedNodes.map((node) => ({ ...node, selected: true })),
    ]);
    setEdges((current) => [
      ...current.map((edge) => decorateWorkflowEdge({ ...edge, selected: false })),
      ...result.duplicatedEdges.map((edge) => decorateWorkflowEdge({ ...edge, selected: true })),
    ]);
    syncSelectionFromCanvas({
      nodeIds: result.duplicatedNodes.map((node) => node.id),
      edgeIds: result.duplicatedEdges.map((edge) => edge.id),
    });
    resetCanvasTransientUi();
    markCanvasChanged();
  }, [edges, markCanvasChanged, nodes, resetCanvasTransientUi, selection, syncSelectionFromCanvas]);

  const selectAllElements = useCallback(() => {
    selectAllElementsState();
    resetCanvasTransientUi();
  }, [resetCanvasTransientUi, selectAllElementsState]);

  const updatePlannerInput = useCallback((
    field: keyof WorkflowPlannerInput,
    value: WorkflowPlannerInput[keyof WorkflowPlannerInput]
  ) => {
    setPlannerInput((current) => ({ ...current, [field]: value }));
  }, []);

  const generateBlueprint = useCallback(async () => {
    setPlannerError(null);
    setError(null);
    setIsGeneratingBlueprint(true);

    try {
      const response = await fetch('/api/workflow-blueprint', {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(plannerInput),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate workflow blueprint');
      }

      const snapshot = { ...plannerInput };
      setGeneratedBlueprint(data.blueprint as WorkflowBlueprint);
      setGeneratedBlueprintInput(snapshot);
      setRemainingPlannerCredits(typeof data.remainingCredits === 'number' ? data.remainingCredits : null);
    } catch (generationError) {
      setPlannerError(generationError instanceof Error ? generationError.message : 'Failed to generate workflow blueprint');
    } finally {
      setIsGeneratingBlueprint(false);
    }
  }, [authHeaders, plannerInput]);

  const applyBlueprintToCanvas = useCallback(async () => {
    if (!generatedBlueprint || !generatedBlueprintInput) {
      return;
    }

    setPlannerError(null);
    setIsApplyingBlueprint(true);

    const createdCanvas = await createCanvas({
      title: generatedBlueprint.title,
      graph: createWorkflowGraphFromBlueprint(generatedBlueprint, generatedBlueprintInput.aspectRatio),
    });

    if (createdCanvas) {
      setIsPlannerOpen(false);
    } else {
      setPlannerError('Failed to create canvas from blueprint.');
    }

    setIsApplyingBlueprint(false);
  }, [createCanvas, generatedBlueprint, generatedBlueprintInput]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditableTarget = Boolean(
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      );

      if (event.key === 'Escape') {
        event.preventDefault();
        if (previewMedia) {
          setPreviewMedia(null);
          return;
        }
        if (contextMenu) {
          closeContextMenu();
          return;
        }
        if (isPlannerOpen) {
          setIsPlannerOpen(false);
          return;
        }
        if (selection.nodeIds.length > 0 || selection.edgeIds.length > 0) {
          clearSelection();
        }
        return;
      }

      if (isEditableTarget) {
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selection.nodeIds.length > 0 || selection.edgeIds.length > 0) {
          event.preventDefault();
          deleteSelection();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        if (selection.nodeIds.length > 0) {
          event.preventDefault();
          duplicateSelection();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAllElements();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, closeContextMenu, contextMenu, deleteSelection, duplicateSelection, isPlannerOpen, previewMedia, selectAllElements, selection]);

  const uploadAssetToBucket = useCallback(async (file: File, bucket: 'generated_images' | 'generated_videos' | 'generated_audio') => {
    const user = effectiveSession?.user ?? null;
    if (!user) {
      throw new Error('Please log in to upload media.');
    }

    const extension = file.name.split('.').pop() || (bucket === 'generated_images' ? 'jpg' : bucket === 'generated_audio' ? 'mp3' : 'mp4');
    const filePath = `${user.id}/workflow-input-${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from(bucket).upload(filePath, file, { upsert: true });
    if (uploadError) {
      throw new Error(uploadError.message);
    }

    const { data: signed, error: signedError } = await supabase.storage.from(bucket).createSignedUrl(filePath, 3600);
    if (signedError || !signed?.signedUrl) {
      throw new Error(signedError?.message || 'Failed to sign upload');
    }

    return {
      signedUrl: signed.signedUrl,
      storagePath: `${bucket}/${filePath}`,
    };
  }, [effectiveSession]);

  const handleRunComplete = useCallback(async () => {
    try {
      const refreshedCanvas = await refreshActiveCanvasRecord();
      if (refreshedCanvas) {
        setNodes((current) => mergePersistedRunStateIntoNodes(current, refreshedCanvas.graph.nodes));
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Failed to refresh workflow run');
    } finally {
      clearRunStateOverlay();
      setActiveRunId(null);
    }
  }, [clearRunStateOverlay, refreshActiveCanvasRecord]);

  useWorkflowRunPolling({
    activeCanvasId,
    activeRunId,
    authHeaders,
    onRunUpdate: applyRunUpdate,
    onRunComplete: () => {
      void handleRunComplete();
    },
  });

  const runCanvas = useCallback(async (mode: 'node' | 'branch', startNodeId?: string) => {
    const nodeId = startNodeId ?? selectedNodeIds[0];
    if (!activeCanvasId || !nodeId) {
      setError('Select a node to run this workflow.');
      return;
    }

    const node = renderNodeById.get(nodeId) || null;
    const nodeRunAffordance = getNodeRunAffordance({
      credits: effectiveCredits,
      graph: renderGraph,
      node,
    });
    if (nodeRunAffordance?.runNodeDisabled || nodeRunAffordance?.runBranchDisabled) {
      setError(nodeRunAffordance.message);
      return;
    }

    try {
      const response = await fetch(`/api/workflow-canvases/${activeCanvasId}/run`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          startNodeId: nodeId,
          mode,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to run workflow');
      }

      clearRunStateOverlay();
      setError(null);
      setActiveRunId(data.runId as string);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Failed to run workflow');
    }
  }, [activeCanvasId, authHeaders, clearRunStateOverlay, effectiveCredits, renderGraph, renderNodeById, selectedNodeIds]);

  const handlePaneClick = useCallback(() => {
    clearSelection();
    closeContextMenu();
  }, [clearSelection, closeContextMenu]);

  const handleMoveEnd = useCallback((nextViewport: { x: number; y: number; zoom: number }) => {
    if (areViewportsEqual(viewportRef.current, nextViewport)) {
      return;
    }

    skipNextViewportSyncRef.current = true;
    setViewport(nextViewport);
    markCanvasChanged();
  }, [markCanvasChanged]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <>
      <div className="min-h-[calc(100vh-4rem)] bg-[#060606] text-white">
        <div className="flex h-[calc(100vh-4rem)]">
          <WorkflowCanvasChrome
            activeCanvasId={activeCanvasId}
            canvasTitle={canvasTitle}
            canvases={canvases}
            hasSelectedNode={Boolean(selectedNode)}
            hasNodeSelection={selection.nodeIds.length > 0}
            isCanvasTransitionPending={isCanvasTransitionPending}
            nodeLibrary={WORKFLOW_NODE_LIBRARY}
            onAddNode={addNode}
            onCanvasTitleBlur={() => {
              void persistCanvas();
            }}
            onCanvasTitleChange={handleCanvasTitleChange}
            onCreateCanvas={() => {
              void createCanvas();
            }}
            onDeleteCanvas={(canvasId) => {
              void deleteCanvas(canvasId);
            }}
            onDeleteSelection={() => deleteSelection()}
            onDuplicateSelection={() => duplicateSelection()}
            onOpenPlanner={() => setIsPlannerOpen(true)}
            onRunBranch={() => {
              void runCanvas('branch');
            }}
            onRunNode={() => {
              void runCanvas('node');
            }}
            onSave={() => {
              void persistCanvas();
            }}
            onSelectCanvas={(canvas) => {
              void selectCanvas(canvas);
            }}
            runAffordance={runAffordance}
            saveState={saveState}
            selectionCount={selectionCount}
          >
            <WorkflowCanvasSurface
              canvasSectionRef={canvasSectionRef}
              contextMenu={contextMenu}
              edgeEditorPosition={edgeEditorPosition}
              editorPosition={editorPosition}
              edges={renderEdges}
              error={error}
              onAddNote={(position) => addNode('note', position)}
              onClearSelection={clearSelection}
              onCloseContextMenu={closeContextMenu}
              onClosePreview={closePreviewMedia}
              onConnect={handleConnect}
              onDeleteEdge={(edgeId) => deleteSelection({ nodeIds: [], edgeIds: [edgeId] })}
              onDeleteNode={(nodeId) => deleteSelection({ nodeIds: [nodeId], edgeIds: [] })}
              onDeleteSelection={() => deleteSelection()}
              onDuplicateSelection={() => duplicateSelection()}
              onEdgeClick={handleEdgeClick}
              onEdgeContextMenu={handleEdgeContextMenu}
              onEdgesChange={handleEdgesChange}
              onFitView={() => {
                void reactFlowInstance?.fitView({ padding: 0.16, duration: 240 });
              }}
              onMoveEnd={handleMoveEnd}
              onNodeContextMenu={handleNodeContextMenu}
              onNodesChange={handleNodesChange}
              onOpenPlanner={() => setIsPlannerOpen(true)}
              onOpenPreview={openPreviewMedia}
              onPaneClick={handlePaneClick}
              onPaneContextMenu={handlePaneContextMenu}
              onRunBranch={(nodeId) => {
                void runCanvas('branch', nodeId);
              }}
              onRunNode={(nodeId) => {
                void runCanvas('node', nodeId);
              }}
              onSelectAll={selectAllElements}
              onSelectionChange={syncSelectionFromCanvas}
              onSetError={setError}
              onUploadAsset={uploadAssetToBucket}
              onUpdateNode={updateNode}
              previewMedia={previewMedia}
              renderNodes={renderNodes}
              runAffordance={runAffordance}
              selectedEdge={selectedEdge}
              selectedKind={selectedKind}
              selectedNode={selectedNode}
              selection={selection}
              selectionCount={selectionCount}
              setReactFlowInstance={setReactFlowInstance}
            />
          </WorkflowCanvasChrome>
        </div>
      </div>
      <WorkflowPlannerAssistantDrawer
        isOpen={isPlannerOpen}
        plannerInput={plannerInput}
        plannerError={plannerError}
        generatedBlueprint={generatedBlueprint}
        generatedBlueprintInput={generatedBlueprintInput}
        remainingPlannerCredits={remainingPlannerCredits}
        isGeneratingBlueprint={isGeneratingBlueprint}
        isApplyingBlueprint={isApplyingBlueprint}
        onClose={() => setIsPlannerOpen(false)}
        onInputChange={updatePlannerInput}
        onGenerateBlueprint={generateBlueprint}
        onApplyBlueprint={applyBlueprintToCanvas}
      />
    </>
  );
}
