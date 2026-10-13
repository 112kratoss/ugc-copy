'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { requestWebGenerationQuote } from '@/lib/generation-model-client';
import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';
import {
  getExecutionOrder,
  getIncomingEdges,
  getResolvedWorkflowImageReferences,
  getResolvedWorkflowVideoReferences,
  isRunnableNode,
  isSeedance2VideoModel,
  normalizeNodeData,
  type ImageGenerateNodeData,
  type MotionGenerateNodeData,
  type VideoGenerateNodeData,
  type VideoInputNodeData,
  type WorkflowCanvasGraph,
  type WorkflowCanvasNode,
  type WorkflowNodeData,
} from '@/lib/workflow-canvas';
import type { WorkflowRunPrice } from './workflowCanvasUiTypes';

const QUOTE_DELAY_MS = 250;
const UNQUOTED_STEP_REASON = 'Could not calculate the cost of this step.';

/** How the runner prices one step, worked out from the canvas before it runs. */
export type WorkflowStepPricePlan =
  | { kind: 'free' }
  | { kind: 'quote'; input: GenerationModelQuoteInput; approximate: boolean }
  | { kind: 'unavailable'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function countIncomingByHandle(graph: WorkflowCanvasGraph, nodeId: string, targetHandle: string) {
  return getIncomingEdges(graph, nodeId).filter((edge) => edge.targetHandle === targetHandle).length;
}

function shotsTotalSeconds(data: VideoGenerateNodeData) {
  return data.multiPrompts.reduce((total, shot) => total + Math.max(1, Math.round(shot.duration || 0)), 0);
}

/**
 * The length a motion step will be charged for: its clip's, which the runner
 * measures when the step starts. Known beforehand only as the length the upload
 * recorded, or the length the video step before it is set to make.
 */
function expectedMotionClipSeconds(graph: WorkflowCanvasGraph, node: WorkflowCanvasNode): number | null {
  const clipEdge = getIncomingEdges(graph, node.id).find((edge) => edge.sourceHandle === 'video');
  const source = clipEdge ? graph.nodes.find((candidate) => candidate.id === clipEdge.source) : undefined;
  if (source?.type === 'video-input') {
    const seconds = (normalizeNodeData('video-input', source.data as Partial<WorkflowNodeData>) as VideoInputNodeData).durationSeconds;
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  if (source?.type === 'video-generate') {
    const data = normalizeNodeData('video-generate', source.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
    const seconds = data.isMultiShot ? shotsTotalSeconds(data) : data.duration;
    return seconds > 0 ? seconds : null;
  }
  return null;
}

/**
 * The quote the runner asks for each kind of step (workflow-runner.ts), with
 * the inputs counted from the canvas's connections rather than from outputs
 * the steps before it have not made yet.
 */
export function planWorkflowStepPrice(graph: WorkflowCanvasGraph, node: WorkflowCanvasNode): WorkflowStepPricePlan {
  if (!isRunnableNode(node)) return { kind: 'free' };
  const catalogSettings = isRecord(node.data.catalogSettings) ? node.data.catalogSettings : {};

  if (node.type === 'image-generate') {
    const data = normalizeNodeData('image-generate', node.data as Partial<WorkflowNodeData>) as ImageGenerateNodeData;
    return {
      kind: 'quote',
      approximate: false,
      input: {
        kind: 'image',
        modelId: data.model,
        settings: {
          aspectRatio: data.aspectRatio,
          resolution: data.resolution,
          outputFormat: data.outputFormat,
          googleSearch: data.googleSearch,
          ...catalogSettings,
        },
        inputCounts: { images: getResolvedWorkflowImageReferences(graph, node.id).length, videos: 0, audios: 0 },
      },
    };
  }

  if (node.type === 'video-generate') {
    const data = normalizeNodeData('video-generate', node.data as Partial<WorkflowNodeData>) as VideoGenerateNodeData;
    const isSeedance = isSeedance2VideoModel(data.model);
    return {
      kind: 'quote',
      approximate: false,
      input: {
        kind: 'video',
        modelId: data.model,
        settings: {
          mode: data.mode,
          aspectRatio: data.aspectRatio,
          sound: data.sound,
          duration: data.isMultiShot ? shotsTotalSeconds(data) : data.duration,
          resolution: data.resolution,
          fixedLens: data.fixedLens,
          isMultiShot: data.isMultiShot,
          ...catalogSettings,
        },
        inputCounts: {
          images: getResolvedWorkflowImageReferences(graph, node.id).length,
          videos: (isSeedance ? countIncomingByHandle(graph, node.id, 'reference-video') : 0)
            + (data.model === 'kling-3.0-video' ? getResolvedWorkflowVideoReferences(graph, node.id).length : 0),
          audios: isSeedance ? countIncomingByHandle(graph, node.id, 'reference-audio') : 0,
        },
      },
    };
  }

  if (node.type === 'motion-generate') {
    const data = normalizeNodeData('motion-generate', node.data as Partial<WorkflowNodeData>) as MotionGenerateNodeData;
    const incoming = getIncomingEdges(graph, node.id);
    if (!incoming.some((edge) => edge.sourceHandle === 'video') || !incoming.some((edge) => edge.sourceHandle === 'image')) {
      return { kind: 'unavailable', reason: 'Motion control requires both an image input and a video input.' };
    }
    const clipSeconds = expectedMotionClipSeconds(graph, node);
    if (clipSeconds === null) {
      return { kind: 'unavailable', reason: 'A motion step is priced by its clip’s length, which is not known yet.' };
    }
    return {
      kind: 'quote',
      // The runner measures the clip when the step starts and charges that length.
      approximate: true,
      input: {
        kind: 'motion',
        modelId: data.model,
        settings: {
          resolution: data.mode,
          characterOrientation: data.characterOrientation,
          duration: Math.max(1, Math.ceil(clipSeconds)),
          ...catalogSettings,
        },
        inputCounts: { images: 1, videos: 1, audios: 0 },
      },
    };
  }

  if (node.type === 'music-generate') {
    return { kind: 'unavailable', reason: 'Music steps cannot run yet.' };
  }
  // Voiceover and sound effects are priced by the server's audio tables, which
  // no quote route serves.
  return { kind: 'unavailable', reason: 'Audio steps are priced when they start.' };
}

type QuoteAnswer = { status: 'ready'; costCredits: number } | { status: 'error'; reason: string };

function quoteKey(input: GenerationModelQuoteInput, catalogRevision: string | null) {
  return JSON.stringify({ catalogRevision, input });
}

/**
 * Prices Run node and Run branch for the nodes whose Run controls are on screen,
 * one quote per step and each quote asked once. Quotes go to the active
 * revision, the one the run will be priced at.
 */
export function useWorkflowRunPrices({
  graph,
  nodeIds,
  catalogRevision,
  accessToken,
  enabled,
}: {
  graph: WorkflowCanvasGraph;
  nodeIds: string[];
  /** The page's revision, only so a release quotes everything again. */
  catalogRevision: string | null;
  accessToken: string | null;
  enabled: boolean;
}) {
  const nodeIdsKey = nodeIds.join(',');
  const plans = useMemo(() => {
    const result = new Map<string, WorkflowStepPricePlan>();
    if (!enabled) return result;
    for (const nodeId of nodeIdsKey.split(',').filter(Boolean)) {
      if (!graph.nodes.some((node) => node.id === nodeId)) continue;
      for (const stepId of getExecutionOrder(graph, nodeId, 'branch')) {
        const step = graph.nodes.find((node) => node.id === stepId);
        if (step && !result.has(stepId)) result.set(stepId, planWorkflowStepPrice(graph, step));
      }
    }
    return result;
  }, [enabled, graph, nodeIdsKey]);

  const requestKeysJoined = useMemo(() => [...new Set([...plans.values()].flatMap((plan) => (
    plan.kind === 'quote' ? [quoteKey(plan.input, catalogRevision)] : []
  )))].join('\n'), [catalogRevision, plans]);

  const [answers, setAnswers] = useState<Record<string, QuoteAnswer>>({});
  const requestedKeysRef = useRef(new Set<string>());
  const answeredKeysRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !requestKeysJoined) return;
    const requestedKeys = requestedKeysRef.current;
    const answeredKeys = answeredKeysRef.current;
    const missing = requestKeysJoined.split('\n').filter((key) => !requestedKeys.has(key));
    if (missing.length === 0) return;
    const controller = new AbortController();
    const settle = (key: string, answer: QuoteAnswer) => {
      answeredKeys.add(key);
      setAnswers((current) => ({ ...current, [key]: answer }));
    };
    const timer = window.setTimeout(() => {
      for (const key of missing) {
        requestedKeys.add(key);
        const { input } = JSON.parse(key) as { input: GenerationModelQuoteInput };
        void requestWebGenerationQuote(input, accessToken, controller.signal)
          .then((quote) => {
            const cost = quote?.costCredits;
            settle(key, typeof cost === 'number' && Number.isFinite(cost)
              ? { status: 'ready', costCredits: cost }
              : { status: 'error', reason: UNQUOTED_STEP_REASON });
          })
          .catch((quoteError: unknown) => {
            if (controller.signal.aborted) return;
            settle(key, {
              status: 'error',
              reason: quoteError instanceof Error && quoteError.message ? quoteError.message : UNQUOTED_STEP_REASON,
            });
          });
      }
    }, QUOTE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      // Cut short, not answered: the next run of this effect asks again.
      for (const key of missing) {
        if (!answeredKeys.has(key)) requestedKeys.delete(key);
      }
    };
  }, [accessToken, enabled, requestKeysJoined]);

  return useCallback((nodeId: string, mode: 'node' | 'branch'): WorkflowRunPrice | null => {
    if (!enabled) return null;
    let costCredits = 0;
    let approximate = false;
    let pending = false;
    for (const stepId of mode === 'node' ? [nodeId] : getExecutionOrder(graph, nodeId, 'branch')) {
      const plan = plans.get(stepId);
      if (!plan) {
        pending = true;
        continue;
      }
      if (plan.kind === 'free') continue;
      if (plan.kind === 'unavailable') return { status: 'unavailable', reason: plan.reason };
      const answer = answers[quoteKey(plan.input, catalogRevision)];
      if (!answer) {
        pending = true;
        continue;
      }
      if (answer.status === 'error') return { status: 'unavailable', reason: answer.reason };
      costCredits += answer.costCredits;
      approximate ||= plan.approximate;
    }
    return pending ? { status: 'pending' } : { status: 'ready', costCredits, approximate };
  }, [answers, catalogRevision, enabled, graph, plans]);
}
