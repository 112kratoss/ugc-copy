'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Clapperboard, Loader2, Sparkles, Wand2, Image as ImageIcon, Video, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import {
  buildImageLaunchUrl,
  buildMotionLaunchUrl,
  buildVideoLaunchUrl,
  DEFAULT_BLUEPRINT,
  WORKFLOW_BLUEPRINT_COST,
  WorkflowAspectRatio,
  WorkflowBlueprint,
  WorkflowObjective,
  WorkflowPlannerInput,
} from '@/lib/workflow-blueprint';
import { useRouter } from 'next/navigation';

const DEFAULT_FORM: WorkflowPlannerInput = {
  brandName: '',
  productName: '',
  audience: '',
  objective: 'ugc-ad',
  primaryMessage: '',
  offer: '',
  callToAction: '',
  visualStyle: 'Cinematic creator UGC with premium product focus',
  tone: 'Confident, human, high-conviction',
  aspectRatio: '9:16',
  durationSeconds: 20,
  platform: 'TikTok / Reels',
  notes: '',
};

export default function CreateWorkflowPage() {
  const router = useRouter();
  const [isLoadingUser, setIsLoadingUser] = useState(true);
  const [userCredits, setUserCredits] = useState<number | null>(null);
  const [form, setForm] = useState<WorkflowPlannerInput>(DEFAULT_FORM);
  const [isGenerating, setIsGenerating] = useState(false);
  const [blueprint, setBlueprint] = useState<WorkflowBlueprint | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkUser = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          router.push('/login?returnUrl=/create-workflow');
          return;
        }
        setIsLoadingUser(false);
        const { data: profile } = await supabase.from('profiles').select('credits').eq('id', user.id).single();
        if (profile) setUserCredits(profile.credits);
      } catch {
        router.push('/login?returnUrl=/create-workflow');
      }
    };

    checkUser();
  }, [router]);

  const insufficientCredits = userCredits !== null && userCredits < WORKFLOW_BLUEPRINT_COST;
  const totalShotDuration = useMemo(() => (blueprint?.shots ?? []).reduce((sum, shot) => sum + shot.duration, 0), [blueprint]);

  const updateField = <K extends keyof WorkflowPlannerInput,>(field: K, value: WorkflowPlannerInput[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleGenerate = async () => {
    if (!form.productName.trim() || !form.audience.trim() || !form.primaryMessage.trim()) {
      setError('Please fill in product, audience, and primary message.');
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login?returnUrl=/create-workflow');
        return;
      }

      const response = await fetch('/api/workflow-blueprint', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(form),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate workflow blueprint');
      }

      setBlueprint(data.blueprint || DEFAULT_BLUEPRINT);
      if (typeof data.remainingCredits === 'number') {
        setUserCredits(data.remainingCredits);
        window.dispatchEvent(new Event('credits_updated'));
      }
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : 'Failed to generate workflow blueprint');
    } finally {
      setIsGenerating(false);
    }
  };

  if (isLoadingUser) {
    return <div className="min-h-screen bg-black flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-zinc-500" /></div>;
  }

  return (
    <div className="min-h-screen bg-black text-white font-[family-name:var(--font-geist-sans)]">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(168,85,247,0.18),transparent_35%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.12),transparent_30%)]" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-6 py-10 space-y-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <Link href="/create" className="inline-flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to create hub
          </Link>
          <div className="rounded-full border border-purple-500/30 bg-purple-500/10 px-4 py-2 text-sm text-purple-200">
            AI Workflow Planner · {WORKFLOW_BLUEPRINT_COST} credits
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[420px,1fr] gap-8">
          <section className="rounded-3xl border border-white/10 bg-zinc-950/70 p-6 backdrop-blur-xl space-y-5">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-blue-200">Research-inspired</div>
              <h1 className="text-3xl font-bold mt-4">Build a full ad workflow</h1>
              <p className="text-zinc-400 mt-2">Generate a complete concept with hook, shot list, prompts, and direct handoff into the image, video, and motion tools you already have.</p>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <LabeledInput label="Brand" value={form.brandName} onChange={(value) => updateField('brandName', value)} placeholder="Acme Skincare" />
              <LabeledInput label="Product" value={form.productName} onChange={(value) => updateField('productName', value)} placeholder="Vitamin C serum" required />
              <LabeledInput label="Audience" value={form.audience} onChange={(value) => updateField('audience', value)} placeholder="Busy women 25–40 dealing with dull skin" required />
              <LabeledInput label="Primary message" value={form.primaryMessage} onChange={(value) => updateField('primaryMessage', value)} placeholder="Fast glow boost without a long routine" required />
              <LabeledInput label="Offer" value={form.offer} onChange={(value) => updateField('offer', value)} placeholder="20% off starter bundle" />
              <LabeledInput label="CTA" value={form.callToAction} onChange={(value) => updateField('callToAction', value)} placeholder="Shop the starter kit today" />
              <LabeledInput label="Tone" value={form.tone} onChange={(value) => updateField('tone', value)} placeholder="Direct, energetic, testimonial-led" />
              <LabeledInput label="Visual style" value={form.visualStyle} onChange={(value) => updateField('visualStyle', value)} placeholder="Premium UGC with clean daylight interiors" />
              <LabeledInput label="Platform" value={form.platform} onChange={(value) => updateField('platform', value)} placeholder="TikTok / Reels / Meta" />
              <div className="grid grid-cols-2 gap-4">
                <SelectField label="Objective" value={form.objective} onChange={(value) => updateField('objective', value as WorkflowObjective)} options={[['ugc-ad', 'UGC ad'], ['product-video', 'Product video'], ['social-campaign', 'Social campaign']]} />
                <SelectField label="Aspect ratio" value={form.aspectRatio} onChange={(value) => updateField('aspectRatio', value as WorkflowAspectRatio)} options={[['9:16', '9:16'], ['16:9', '16:9'], ['1:1', '1:1']]} />
              </div>
              <LabeledInput label="Duration (seconds)" value={String(form.durationSeconds)} onChange={(value) => updateField('durationSeconds', Number(value) || 15)} placeholder="20" type="number" />
              <label className="space-y-2 text-sm text-zinc-300">
                <span>Notes</span>
                <textarea value={form.notes} onChange={(event) => updateField('notes', event.target.value)} rows={4} className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none focus:border-purple-400" placeholder="Existing assets, creator notes, claims to emphasize, etc." />
              </label>
            </div>

            {error && <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
            {insufficientCredits && <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">You need at least {WORKFLOW_BLUEPRINT_COST} credits to create a workflow blueprint.</div>}

            <button onClick={handleGenerate} disabled={isGenerating || insufficientCredits} className="w-full rounded-2xl bg-gradient-to-r from-purple-500 to-pink-500 px-5 py-4 font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed">
              <span className="inline-flex items-center gap-2">{isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Generate workflow blueprint</span>
            </button>
          </section>

          <section className="rounded-3xl border border-white/10 bg-zinc-950/60 p-6 backdrop-blur-xl min-h-[780px]">
            {!blueprint ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-zinc-400 max-w-xl mx-auto">
                <Clapperboard className="w-12 h-12 mb-4 text-purple-300" />
                <h2 className="text-2xl font-semibold text-white">Your production workflow appears here</h2>
                <p className="mt-3">This planner follows the same pattern used in modern AI ad studios: define the hook, build modular scenes, generate prompts, and launch each asset from one place.</p>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-sm uppercase tracking-[0.2em] text-purple-300">Workflow blueprint</p>
                    <h2 className="text-3xl font-bold mt-2">{blueprint.title}</h2>
                    <p className="text-zinc-400 mt-2 max-w-3xl">{blueprint.creativeStrategy}</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-zinc-300">
                    <div>Total planned runtime: <span className="text-white font-semibold">{totalShotDuration}s</span></div>
                    <div className="mt-1">Primary model: <span className="text-white">{blueprint.deliveryPlan.primaryModel}</span></div>
                  </div>
                </div>

                <div className="grid md:grid-cols-3 gap-4">
                  <InfoCard title="Hook" text={blueprint.hook} />
                  <InfoCard title="Narrative" text={blueprint.narrative} />
                  <InfoCard title="Voiceover" text={blueprint.voiceover} />
                </div>

                <div className="grid lg:grid-cols-[1.1fr,0.9fr] gap-6">
                  <div className="space-y-4">
                    <h3 className="text-xl font-semibold">Shot-by-shot build</h3>
                    {blueprint.shots.map((shot) => (
                      <div key={shot.id} className="rounded-3xl border border-white/10 bg-black/30 p-5 space-y-4">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{shot.id}</div>
                            <h4 className="text-lg font-semibold mt-1">{shot.title}</h4>
                            <p className="text-zinc-400 mt-2">{shot.purpose}</p>
                          </div>
                          <div className="rounded-full border border-white/10 px-3 py-1 text-sm text-zinc-300">{shot.duration}s</div>
                        </div>

                        <div className="rounded-2xl border border-white/5 bg-zinc-900/70 p-4 text-sm text-zinc-300">
                          <span className="text-zinc-500">Beat:</span> {shot.beat}
                        </div>

                        <PromptBlock icon={<ImageIcon className="w-4 h-4" />} title="Still image prompt" prompt={shot.visualPrompt} href={buildImageLaunchUrl(shot.visualPrompt, blueprint.deliveryPlan.stillImageModel, form.aspectRatio)} linkLabel="Open in image generator" />
                        <PromptBlock icon={<Video className="w-4 h-4" />} title="Video prompt" prompt={shot.videoPrompt} href={buildVideoLaunchUrl(shot.videoPrompt, blueprint.deliveryPlan.primaryModel, form.aspectRatio, String(Math.min(Math.max(shot.duration, 4), 10)))} linkLabel="Open in video generator" />
                        <PromptBlock icon={<Wand2 className="w-4 h-4" />} title="Motion-control prompt" prompt={shot.motionPrompt} href={buildMotionLaunchUrl(shot.motionPrompt, blueprint.deliveryPlan.motionModel)} linkLabel="Open in motion control" />
                      </div>
                    ))}
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-xl font-semibold">Execution checklist</h3>
                    <ChecklistCard title="Recommended sequence" items={blueprint.deliveryPlan.recommendedSequence} />
                    <ChecklistCard title="Asset checklist" items={blueprint.assetChecklist} />
                    <ChecklistCard title="Editing notes" items={blueprint.editingNotes} />
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function LabeledInput({ label, value, onChange, placeholder, required, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean; type?: string }) {
  return (
    <label className="space-y-2 text-sm text-zinc-300">
      <span>{label}{required ? ' *' : ''}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none focus:border-purple-400" />
    </label>
  );
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <label className="space-y-2 text-sm text-zinc-300">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none focus:border-purple-400">
        {options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
      </select>
    </label>
  );
}

function InfoCard({ title, text }: { title: string; text: string }) {
  return <div className="rounded-3xl border border-white/10 bg-black/30 p-5"><p className="text-xs uppercase tracking-[0.2em] text-zinc-500">{title}</p><p className="mt-3 text-zinc-200 leading-relaxed">{text}</p></div>;
}

function ChecklistCard({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-3xl border border-white/10 bg-black/30 p-5">
      <h4 className="font-semibold text-white">{title}</h4>
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-3 text-zinc-300"><CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" /> <span>{item}</span></li>
        ))}
      </ul>
    </div>
  );
}

function PromptBlock({ icon, title, prompt, href, linkLabel }: { icon: ReactNode; title: string; prompt: string; href: string; linkLabel: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-950/80 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-white">{icon} {title}</div>
      <p className="mt-3 text-sm leading-relaxed text-zinc-300">{prompt}</p>
      <Link href={href} className="mt-4 inline-flex items-center gap-2 rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-2 text-sm text-purple-200 hover:bg-purple-500/20">
        {linkLabel}
      </Link>
    </div>
  );
}
