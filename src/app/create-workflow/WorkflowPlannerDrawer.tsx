'use client';

import Link from 'next/link';
import { Bot, Clapperboard, Loader2, Wand2, X } from 'lucide-react';
import {
  buildImageLaunchUrl,
  buildMotionLaunchUrl,
  buildVideoLaunchUrl,
  WORKFLOW_BLUEPRINT_COST,
  type WorkflowAspectRatio,
  type WorkflowBlueprint,
  type WorkflowObjective,
  type WorkflowPlannerInput,
} from '@/lib/workflow-blueprint';

export const DEFAULT_PLANNER_INPUT: WorkflowPlannerInput = {
  brandName: '',
  productName: '',
  audience: '',
  objective: 'ugc-ad',
  primaryMessage: '',
  offer: '',
  callToAction: 'Shop now',
  visualStyle: 'Creator-style UGC, natural light, product-forward framing',
  tone: 'Confident, direct, trustworthy',
  aspectRatio: '9:16',
  durationSeconds: 20,
  platform: 'TikTok and Instagram Reels',
  notes: '',
};

const WORKFLOW_OBJECTIVE_OPTIONS: Array<{ value: WorkflowObjective; label: string }> = [
  { value: 'ugc-ad', label: 'UGC ad' },
  { value: 'product-video', label: 'Product video' },
  { value: 'social-campaign', label: 'Social campaign' },
];

const WORKFLOW_OBJECTIVE_LABELS: Record<WorkflowObjective, string> = {
  'ugc-ad': 'UGC ad',
  'product-video': 'Product video',
  'social-campaign': 'Social campaign',
};

const WORKFLOW_ASPECT_RATIO_OPTIONS: Array<{ value: WorkflowAspectRatio; label: string }> = [
  { value: '9:16', label: '9:16 vertical' },
  { value: '16:9', label: '16:9 widescreen' },
  { value: '1:1', label: '1:1 square' },
];

type SelectOption = string | { value: string; label: string };

function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <input
        type="text"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      />
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <textarea
        aria-label={label}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      >
        {options.map((option) => {
          const normalized = typeof option === 'string' ? { value: option, label: option } : option;
          return <option key={normalized.value} value={normalized.value}>{normalized.label}</option>;
        })}
      </select>
    </div>
  );
}

function NumberField({
  label,
  value,
  min = 1,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="mb-2 block text-xs uppercase tracking-[0.18em] text-zinc-500">{label}</label>
      <input
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-500/40"
      />
    </div>
  );
}

function PlannerSummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-3">
      <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">{label}</div>
      <div className="mt-2 leading-relaxed text-zinc-200">{value}</div>
    </div>
  );
}

function WorkflowPlannerTab({
  plannerInput,
  plannerError,
  generatedBlueprint,
  generatedBlueprintInput,
  remainingPlannerCredits,
  isGeneratingBlueprint,
  isApplyingBlueprint,
  onInputChange,
  onGenerateBlueprint,
  onApplyBlueprint,
}: {
  plannerInput: WorkflowPlannerInput;
  plannerError: string | null;
  generatedBlueprint: WorkflowBlueprint | null;
  generatedBlueprintInput: WorkflowPlannerInput | null;
  remainingPlannerCredits: number | null;
  isGeneratingBlueprint: boolean;
  isApplyingBlueprint: boolean;
  onInputChange: (field: keyof WorkflowPlannerInput, value: WorkflowPlannerInput[keyof WorkflowPlannerInput]) => void;
  onGenerateBlueprint: () => Promise<void>;
  onApplyBlueprint: () => Promise<void>;
}) {
  const previewInput = generatedBlueprintInput ?? plannerInput;

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-50">
        Generate a production-ready workflow plan from a campaign brief, then turn it into a brand-new canvas without replacing the graph you already have open.
      </div>

      <div className="grid gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Campaign brief</div>
            <div className="mt-1 text-sm text-zinc-300">Each generation costs {WORKFLOW_BLUEPRINT_COST} credits.</div>
          </div>
          {remainingPlannerCredits !== null && (
            <div className="rounded-full border border-white/10 bg-black/40 px-3 py-1 text-xs text-zinc-200">
              {remainingPlannerCredits} credits left
            </div>
          )}
        </div>

        <TextField label="Brand name" value={plannerInput.brandName} onChange={(value) => onInputChange('brandName', value)} placeholder="Acme Labs" />
        <TextField label="Product name" value={plannerInput.productName} onChange={(value) => onInputChange('productName', value)} placeholder="Hydrating face mist" />
        <TextAreaField label="Audience" value={plannerInput.audience} onChange={(value) => onInputChange('audience', value)} placeholder="Busy skincare buyers who want fast proof before purchasing" />
        <SelectField label="Objective" value={plannerInput.objective} onChange={(value) => onInputChange('objective', value as WorkflowObjective)} options={WORKFLOW_OBJECTIVE_OPTIONS} />
        <TextAreaField label="Primary message" value={plannerInput.primaryMessage} onChange={(value) => onInputChange('primaryMessage', value)} placeholder="Instant glow without heavy makeup or a long routine" />
        <TextField label="Offer" value={plannerInput.offer} onChange={(value) => onInputChange('offer', value)} placeholder="20% off first order" />
        <TextField label="Call to action" value={plannerInput.callToAction} onChange={(value) => onInputChange('callToAction', value)} placeholder="Shop now" />
        <TextField label="Visual style" value={plannerInput.visualStyle} onChange={(value) => onInputChange('visualStyle', value)} placeholder="Creator-style UGC, natural window light, handheld realism" />
        <TextField label="Tone" value={plannerInput.tone} onChange={(value) => onInputChange('tone', value)} placeholder="Direct, persuasive, warm" />
        <SelectField label="Aspect ratio" value={plannerInput.aspectRatio} onChange={(value) => onInputChange('aspectRatio', value as WorkflowAspectRatio)} options={WORKFLOW_ASPECT_RATIO_OPTIONS} />
        <NumberField label="Target duration" value={plannerInput.durationSeconds} min={5} max={60} onChange={(value) => onInputChange('durationSeconds', value)} />
        <TextField label="Platform" value={plannerInput.platform} onChange={(value) => onInputChange('platform', value)} placeholder="TikTok, Reels, landing page" />
        <TextAreaField label="Extra notes" value={plannerInput.notes || ''} onChange={(value) => onInputChange('notes', value)} placeholder="Mention proof points, creator persona, mandatory claims, or visual constraints" rows={4} />

        <button
          type="button"
          onClick={() => void onGenerateBlueprint()}
          disabled={isGeneratingBlueprint || isApplyingBlueprint}
          className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isGeneratingBlueprint ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          {isGeneratingBlueprint ? 'Generating blueprint...' : 'Generate workflow blueprint'}
        </button>

        {plannerError && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {plannerError}
          </div>
        )}
      </div>

      {generatedBlueprint ? (
        <div className="space-y-4">
          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Generated blueprint</div>
                <div className="mt-1 text-lg font-semibold text-white">{generatedBlueprint.title}</div>
                <div className="mt-1 text-sm text-zinc-400">
                  {WORKFLOW_OBJECTIVE_LABELS[previewInput.objective]} for {previewInput.platform}
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 text-sm text-zinc-200">
              <PlannerSummaryCard label="Creative strategy" value={generatedBlueprint.creativeStrategy} />
              <PlannerSummaryCard label="Hook" value={generatedBlueprint.hook} />
              <PlannerSummaryCard label="Narrative" value={generatedBlueprint.narrative} />
              <PlannerSummaryCard label="Voiceover" value={generatedBlueprint.voiceover} />
            </div>

            <button
              type="button"
              onClick={() => void onApplyBlueprint()}
              disabled={isApplyingBlueprint || isGeneratingBlueprint}
              className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm font-medium text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isApplyingBlueprint ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
              {isApplyingBlueprint ? 'Creating canvas...' : 'Create canvas from blueprint'}
            </button>
            <p className="mt-2 text-xs text-zinc-500">This creates a fresh saved canvas so your current workflow stays untouched.</p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Delivery plan</div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-200">
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1">Image: {generatedBlueprint.deliveryPlan.stillImageModel}</span>
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1">Video: {generatedBlueprint.deliveryPlan.primaryModel}</span>
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1">Motion: {generatedBlueprint.deliveryPlan.motionModel}</span>
              <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1">Format: {previewInput.aspectRatio}</span>
            </div>
            <div className="mt-3 space-y-2 text-sm text-zinc-300">
              {generatedBlueprint.deliveryPlan.recommendedSequence.map((step, index) => (
                <div key={`${step}-${index}`} className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                  {index + 1}. {step}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Editing notes</div>
            <div className="mt-3 space-y-2 text-sm text-zinc-300">
              {generatedBlueprint.editingNotes.map((note, index) => (
                <div key={`${note}-${index}`} className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                  {note}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Asset checklist</div>
            <div className="mt-3 space-y-2 text-sm text-zinc-300">
              {generatedBlueprint.assetChecklist.map((asset, index) => (
                <div key={`${asset}-${index}`} className="rounded-2xl border border-white/10 bg-black/20 px-3 py-2">
                  {asset}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            {generatedBlueprint.shots.map((shot, index) => (
              <div key={shot.id} className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Shot {index + 1}</div>
                    <div className="mt-1 text-base font-semibold text-white">{shot.title}</div>
                    <div className="mt-1 text-sm text-zinc-400">{shot.duration}s</div>
                  </div>
                </div>

                <div className="mt-4 space-y-3 text-sm text-zinc-300">
                  <PlannerSummaryCard label="Purpose" value={shot.purpose} />
                  <PlannerSummaryCard label="Beat" value={shot.beat} />
                  <PlannerSummaryCard label="Still prompt" value={shot.visualPrompt} />
                  <PlannerSummaryCard label="Video prompt" value={shot.videoPrompt} />
                  <PlannerSummaryCard label="Motion prompt" value={shot.motionPrompt} />
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href={buildImageLaunchUrl(shot.visualPrompt, generatedBlueprint.deliveryPlan.stillImageModel, previewInput.aspectRatio)} className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-100 hover:bg-black/50">
                    Open image tool
                  </Link>
                  <Link href={buildVideoLaunchUrl(shot.videoPrompt, generatedBlueprint.deliveryPlan.primaryModel, previewInput.aspectRatio, String(shot.duration))} className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-100 hover:bg-black/50">
                    Open video tool
                  </Link>
                  <Link href={buildMotionLaunchUrl(shot.motionPrompt, generatedBlueprint.deliveryPlan.motionModel)} className="rounded-full border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-100 hover:bg-black/50">
                    Open motion tool
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.02] p-5 text-sm text-zinc-500">
          Your generated blueprint will appear here with strategy notes, shot prompts, and a one-click action to create a new canvas from it.
        </div>
      )}
    </div>
  );
}

export function PlannerAssistantDrawer({
  isOpen,
  onClose,
  plannerInput,
  plannerError,
  generatedBlueprint,
  generatedBlueprintInput,
  remainingPlannerCredits,
  isGeneratingBlueprint,
  isApplyingBlueprint,
  onInputChange,
  onGenerateBlueprint,
  onApplyBlueprint,
}: {
  isOpen: boolean;
  onClose: () => void;
  plannerInput: WorkflowPlannerInput;
  plannerError: string | null;
  generatedBlueprint: WorkflowBlueprint | null;
  generatedBlueprintInput: WorkflowPlannerInput | null;
  remainingPlannerCredits: number | null;
  isGeneratingBlueprint: boolean;
  isApplyingBlueprint: boolean;
  onInputChange: (field: keyof WorkflowPlannerInput, value: WorkflowPlannerInput[keyof WorkflowPlannerInput]) => void;
  onGenerateBlueprint: () => Promise<void>;
  onApplyBlueprint: () => Promise<void>;
}) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        aria-label="Close planner"
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <aside data-testid="planner-assistant-drawer" className="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col border-l border-white/10 bg-[#050505] shadow-[-32px_0_120px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl border border-violet-500/30 bg-violet-500/10 p-3 text-violet-100">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <div className="text-lg font-semibold text-white">Workflow planner</div>
              <div className="mt-1 text-sm text-zinc-400">Turn a campaign brief into a fresh canvas blueprint without leaving the workflow view.</div>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close planner drawer"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-zinc-300 transition hover:bg-white/[0.06] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-white/10 px-5 py-4">
          <div className="rounded-[28px] border border-violet-500/20 bg-violet-500/10 p-4 text-sm text-violet-50">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-black/30 p-2 text-violet-100">
                <Bot className="h-4 w-4" />
              </div>
              <div className="leading-relaxed">
                Share the campaign brief, desired platform, and creative angle. I&apos;ll shape it into a production-ready workflow with shot prompts and a one-click canvas handoff.
              </div>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <WorkflowPlannerTab
            plannerInput={plannerInput}
            plannerError={plannerError}
            generatedBlueprint={generatedBlueprint}
            generatedBlueprintInput={generatedBlueprintInput}
            remainingPlannerCredits={remainingPlannerCredits}
            isGeneratingBlueprint={isGeneratingBlueprint}
            isApplyingBlueprint={isApplyingBlueprint}
            onInputChange={onInputChange}
            onGenerateBlueprint={onGenerateBlueprint}
            onApplyBlueprint={onApplyBlueprint}
          />
        </div>
      </aside>
    </div>
  );
}
