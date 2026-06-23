'use client';

import { useEffect, useRef } from 'react';
import {
  Bot,
  CheckCircle2,
  Image as ImageIcon,
  Layers3,
  Loader2,
  SendHorizonal,
  Sparkles,
  Trash2,
  Video,
  Volume2,
  Wand2,
  X,
} from 'lucide-react';

import type {
  WorkflowAssistantAvailability,
  WorkflowCanvasAssistantMessageRecord,
  WorkflowCanvasAssistantProposalRecord,
} from '@/lib/workflow-assistant-client';
import type { WorkflowCanvasGraph, WorkflowCanvasNode } from '@/lib/workflow-canvas';

function AssistantMessageBubble({
  message,
}: {
  message: WorkflowCanvasAssistantMessageRecord;
}) {
  const isAssistant = message.role === 'assistant';

  return (
    <div
      className={`rounded-[24px] border px-4 py-3 ${
        isAssistant
          ? 'border-violet-500/25 bg-violet-500/10 text-violet-50'
          : 'border-white/10 bg-white/[0.03] text-zinc-100'
      }`}
    >
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-400">
        {isAssistant ? <Bot className="h-3.5 w-3.5 text-violet-200" /> : <Sparkles className="h-3.5 w-3.5 text-zinc-400" />}
        {isAssistant ? 'AI Builder' : 'You'}
      </div>
      <div className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</div>
    </div>
  );
}

function getAssistantManagedNodes(graph: WorkflowCanvasGraph | null) {
  if (!graph) {
    return [];
  }

  return graph.nodes.filter((node) => node.data.managed);
}

function getProposalSlotNodes(graph: WorkflowCanvasGraph | null) {
  return getAssistantManagedNodes(graph).filter((node) => (
    node.type === 'image-input' ||
    node.type === 'video-input' ||
    node.type === 'audio-input'
  ));
}

function getGeneratorModel(graph: WorkflowCanvasGraph | null, kind: WorkflowCanvasNode['type']) {
  const node = getAssistantManagedNodes(graph).find((candidate) => candidate.type === kind);
  if (!node) {
    return null;
  }

  if ('model' in node.data && typeof node.data.model === 'string') {
    return node.data.model;
  }

  return null;
}

function SlotIcon({ type }: { type: WorkflowCanvasNode['type'] }) {
  if (type === 'video-input') {
    return <Video className="h-4 w-4 text-rose-200" />;
  }

  if (type === 'audio-input') {
    return <Volume2 className="h-4 w-4 text-violet-200" />;
  }

  return <ImageIcon className="h-4 w-4 text-sky-200" />;
}

function ProposalCard({
  proposal,
  isApplying,
  isDiscarding,
  isProposalStale,
  onApply,
  onDiscard,
}: {
  proposal: WorkflowCanvasAssistantProposalRecord;
  isApplying: boolean;
  isDiscarding: boolean;
  isProposalStale: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const slotNodes = getProposalSlotNodes(proposal.proposed_graph);
  const imageModel = getGeneratorModel(proposal.proposed_graph, 'image-generate');
  const videoModel = getGeneratorModel(proposal.proposed_graph, 'video-generate');
  const motionModel = getGeneratorModel(proposal.proposed_graph, 'motion-generate');
  const totalChangedNodes = proposal.diff.nodes.added.length + proposal.diff.nodes.changed.length + proposal.diff.nodes.removed.length;

  return (
    <div className="rounded-[28px] border border-violet-500/25 bg-violet-500/[0.08] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.28)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-violet-200">Proposal preview</div>
          <div className="mt-2 text-lg font-semibold text-white">{proposal.summary}</div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.16em] text-zinc-200">
            {imageModel ? <span className="rounded-full border border-white/10 bg-black/25 px-3 py-1">Image {imageModel}</span> : null}
            {videoModel ? <span className="rounded-full border border-white/10 bg-black/25 px-3 py-1">Video {videoModel}</span> : null}
            {motionModel ? <span className="rounded-full border border-white/10 bg-black/25 px-3 py-1">Motion {motionModel}</span> : null}
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/25 px-3 py-2 text-right text-xs text-zinc-300">
          <div>{totalChangedNodes} node changes</div>
          <div>{proposal.diff.edges.added + proposal.diff.edges.removed} edge changes</div>
        </div>
      </div>

      {isProposalStale ? (
        <div className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          This proposal was generated for an older saved revision. Regenerate it before applying.
        </div>
      ) : null}

      <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-4">
        <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-zinc-400">
          <Layers3 className="h-3.5 w-3.5" />
          Slot checklist
        </div>
        <div className="space-y-2">
          {slotNodes.length > 0 ? slotNodes.map((node) => (
            <div key={node.id} className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3">
              <div className="rounded-xl border border-white/10 bg-black/25 p-2">
                <SlotIcon type={node.type} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-white">{node.data.title}</div>
                <div className="mt-1 text-xs leading-relaxed text-zinc-400">{node.data.subtitle}</div>
              </div>
            </div>
          )) : (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-4 text-sm text-zinc-400">
              No placeholder slots were inferred for this proposal.
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={isApplying || isDiscarding || isProposalStale}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-2xl border border-emerald-500/35 bg-emerald-500/15 px-4 py-3 text-sm font-medium text-emerald-50 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isApplying ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {isApplying ? 'Applying...' : 'Apply to canvas'}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={isApplying || isDiscarding}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isDiscarding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          {isDiscarding ? 'Discarding...' : 'Discard'}
        </button>
      </div>
    </div>
  );
}

export function WorkflowAssistantDrawer({
  availability,
  creditsLabel,
  error,
  input,
  isApplying,
  isDiscarding,
  isLoading,
  isOpen,
  isProposalStale,
  isSubmitting,
  messages,
  onApplyProposal,
  onClose,
  onDiscardProposal,
  onInputChange,
  onOpen,
  onSendMessage,
  proposal,
  setupMessage,
}: {
  availability: WorkflowAssistantAvailability;
  creditsLabel?: string | null;
  error: string | null;
  input: string;
  isApplying: boolean;
  isDiscarding: boolean;
  isLoading: boolean;
  isOpen: boolean;
  isProposalStale: boolean;
  isSubmitting: boolean;
  messages: WorkflowCanvasAssistantMessageRecord[];
  onApplyProposal: () => void;
  onClose: () => void;
  onDiscardProposal: () => void;
  onInputChange: (value: string) => void;
  onOpen: () => void;
  onSendMessage: () => void;
  proposal: WorkflowCanvasAssistantProposalRecord | null;
  setupMessage: string | null;
}) {
  const isSetupRequired = availability === 'setup_required';
  const popupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  return (
    <div className="pointer-events-none absolute inset-y-4 right-4 z-40 flex justify-end">
      <div ref={popupRef} className="pointer-events-auto flex h-full flex-col items-end gap-3">
        <div className="flex shrink-0 items-center gap-2">
          {creditsLabel ? (
            <div className="rounded-full border border-white/10 bg-black/70 px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] text-zinc-300 shadow-[0_12px_36px_rgba(0,0,0,0.35)] backdrop-blur">
              {creditsLabel}
            </div>
          ) : null}
          <button
            type="button"
            aria-label={isOpen ? 'Close AI Builder' : 'Open AI Builder'}
            data-testid="workflow-assistant-trigger"
            onClick={isOpen ? onClose : onOpen}
            className={`relative inline-flex h-12 w-12 items-center justify-center rounded-full border shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur transition ${
              isOpen
                ? 'border-violet-400/45 bg-violet-500/18 text-violet-50'
                : 'border-white/10 bg-black/72 text-zinc-200 hover:border-violet-500/30 hover:bg-violet-500/12 hover:text-violet-100'
            }`}
          >
            <Bot className="h-5 w-5" />
            {proposal?.status === 'ready' ? (
              <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#050505] bg-emerald-400" />
            ) : null}
          </button>
        </div>

        {isOpen ? (
          <aside
            data-testid="workflow-assistant-popup"
            className="flex min-h-0 flex-1 w-[min(440px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[30px] border border-white/10 bg-[#050505]/96 shadow-[0_30px_120px_rgba(0,0,0,0.58)] backdrop-blur-xl"
          >
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="rounded-2xl border border-violet-500/30 bg-violet-500/10 p-3 text-violet-100">
                  <Bot className="h-5 w-5" />
                </div>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-lg font-semibold text-white">AI Builder</div>
                    <span className="rounded-full border border-violet-500/25 bg-violet-500/10 px-2.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-violet-100">
                      Canvas popup
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-zinc-400">
                    Prompt the workflow, review the proposal, and apply it without leaving the canvas.
                  </div>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close workflow assistant"
                onClick={onClose}
                className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="shrink-0 border-b border-white/10 px-5 py-4">
              <div className="rounded-[24px] border border-violet-500/20 bg-violet-500/10 p-4 text-sm text-violet-50">
                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-black/30 p-2 text-violet-100">
                    <Wand2 className="h-4 w-4" />
                  </div>
                  <div className="leading-relaxed">
                    Ask for a runnable workflow in plain language. The assistant only changes the AI-managed region and leaves the rest of your canvas alone.
                  </div>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="space-y-4">
                {proposal?.status === 'ready' ? (
                  <ProposalCard
                    proposal={proposal}
                    isApplying={isApplying}
                    isDiscarding={isDiscarding}
                    isProposalStale={isProposalStale}
                    onApply={onApplyProposal}
                    onDiscard={onDiscardProposal}
                  />
                ) : null}

                {isSetupRequired ? (
                  <div className="rounded-[24px] border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-100">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-amber-200">Setup required</div>
                    <div className="mt-2 leading-relaxed">
                      {setupMessage || 'AI Builder needs the latest workflow assistant migration before it can create proposals.'}
                    </div>
                  </div>
                ) : null}

                {error ? (
                  <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                    {error}
                  </div>
                ) : null}

                {isLoading ? (
                  <div className="rounded-3xl border border-white/10 bg-white/[0.03] px-5 py-8 text-sm text-zinc-400">
                    Loading assistant history...
                  </div>
                ) : messages.length > 0 ? (
                  messages.map((message) => (
                    <AssistantMessageBubble key={message.id} message={message} />
                  ))
                ) : (
                  <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] p-5 text-sm text-zinc-500">
                    Try: “Build a transformation workflow with a hero reference image, before and after frames, a Seedance transition shot, and an optional lightning SFX placeholder.”
                  </div>
                )}
              </div>
            </div>

            <div className="shrink-0 border-t border-white/10 px-5 py-4">
              <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-3">
                <textarea
                  aria-label="Workflow assistant prompt"
                  value={input}
                  disabled={isSetupRequired}
                  rows={4}
                  onChange={(event) => onInputChange(event.target.value)}
                  placeholder={isSetupRequired
                    ? 'AI Builder is blocked until the workflow assistant migration is applied.'
                    : 'Describe the workflow you want the AI Builder to create or refine...'}
                  className="w-full resize-none bg-transparent px-2 py-2 text-sm leading-relaxed text-white outline-none placeholder:text-zinc-500 disabled:cursor-not-allowed disabled:text-zinc-500"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs uppercase tracking-[0.16em] text-zinc-300">
                    <Layers3 className="h-3.5 w-3.5" />
                    {proposal?.status === 'ready' ? 'Preview active' : 'Live canvas'}
                  </div>
                  <button
                    type="button"
                    onClick={onSendMessage}
                    disabled={isSubmitting || !input.trim() || isSetupRequired}
                    className="inline-flex items-center gap-2 rounded-2xl border border-violet-500/35 bg-violet-500/15 px-4 py-2.5 text-sm font-medium text-violet-50 transition hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizonal className="h-4 w-4" />}
                    {isSubmitting ? 'Generating...' : isSetupRequired ? 'Setup required' : 'Build proposal'}
                  </button>
                </div>
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
