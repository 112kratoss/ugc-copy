'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  BadgePlus,
  BookText,
  Check,
  Film,
  ImageIcon,
  Link2,
  Loader2,
  Plus,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';
import {
  formatUsdCents,
  getPostResourceKindLabel,
  type PostResourceAttachment,
  type PostResourceBundleAccessMode,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';

type PostCategory = 'image' | 'video' | 'motion' | 'ugc-ad' | 'text';
type PostVisibility = 'public' | 'unlisted' | 'private';
type ProofMode = 'media' | 'text';
type PostFormat = 'text' | 'media' | 'mixed';

interface CreatedPostState {
  postId: string;
  showcasePath: string;
  resourceBundlePath: string;
  visibility: PostVisibility;
  resourceAccessMode: PostResourceBundleAccessMode;
}

interface AttachmentRow {
  id: string;
  label: string;
  url: string;
}

interface GenerationDraft {
  id: string;
  title: string;
  description: string;
  prompt: string;
  outputUrl: string | null;
  category: Exclude<PostCategory, 'text'>;
  model: string;
}

const BODY_MAX_LENGTH = 2000;
const STEP_ORDER = ['Proof', 'Story', 'Resources', 'Publish'] as const;

const CATEGORY_OPTIONS: Array<{
  value: Exclude<PostCategory, 'text'>;
  label: string;
  description: string;
}> = [
  { value: 'image', label: 'Image', description: 'Still images and frames' },
  { value: 'video', label: 'Video', description: 'Standard video posts' },
  { value: 'motion', label: 'Motion', description: 'Movement studies or motion transfer' },
  { value: 'ugc-ad', label: 'UGC ad', description: 'Creator-style ad deliverables' },
];

const VISIBILITY_OPTIONS: Array<{
  value: PostVisibility;
  label: string;
  description: string;
}> = [
  {
    value: 'public',
    label: 'Public',
    description: 'Appears in the feed and is shareable right away.',
  },
  {
    value: 'unlisted',
    label: 'Unlisted',
    description: 'Share by direct link only.',
  },
  {
    value: 'private',
    label: 'Private',
    description: 'Keep it private while you are still shaping the proof.',
  },
];

const RESOURCE_ACCESS_OPTIONS: Array<{
  value: PostResourceBundleAccessMode;
  label: string;
  description: string;
}> = [
  {
    value: 'none',
    label: 'No resources',
    description: 'Publish the proof post on its own.',
  },
  {
    value: 'free',
    label: 'Free resources',
    description: 'Let people unlock the prompt, notes, files, or remix access for free.',
  },
  {
    value: 'paid',
    label: 'Paid resources',
    description: 'Charge for the reusable resources behind this post.',
  },
];

const RESOURCE_KIND_OPTIONS: Array<{
  value: PostResourceKind;
  label: string;
  description: string;
}> = [
  { value: 'prompt', label: 'Prompt', description: 'The exact prompt or prompt pack.' },
  { value: 'workflow', label: 'Workflow link', description: 'A shared workflow or build path.' },
  { value: 'files', label: 'Files / links', description: 'Reference files, docs, or resource links.' },
  { value: 'notes', label: 'Notes', description: 'Usage notes, steps, or instructions.' },
  { value: 'remix', label: 'Remix access', description: 'Require an unlock before someone can remix.' },
];

const EMPTY_RESOURCE_SELECTIONS: Record<PostResourceKind, boolean> = {
  prompt: false,
  workflow: false,
  files: false,
  notes: false,
  remix: false,
};

let attachmentIdCounter = 0;

function createAttachmentRow(partial?: Partial<Omit<AttachmentRow, 'id'>>): AttachmentRow {
  attachmentIdCounter += 1;

  return {
    id: `attachment-${attachmentIdCounter}`,
    label: partial?.label ?? '',
    url: partial?.url ?? '',
  };
}

function inferCategory(file: File | null): Exclude<PostCategory, 'text'> | null {
  if (!file) {
    return null;
  }

  if (file.type.startsWith('image/')) {
    return 'image';
  }

  if (file.type.startsWith('video/')) {
    return 'video';
  }

  return null;
}

function acceptsCategory(file: File | null, category: Exclude<PostCategory, 'text'>): boolean {
  if (!file) {
    return true;
  }

  if (file.type.startsWith('image/')) {
    return category === 'image' || category === 'ugc-ad';
  }

  if (file.type.startsWith('video/')) {
    return category === 'video' || category === 'motion' || category === 'ugc-ad';
  }

  return false;
}

function serializeAttachmentRows(rows: AttachmentRow[]): PostResourceAttachment[] {
  return rows
    .map((row) => ({
      label: row.label.trim(),
      url: row.url.trim(),
    }))
    .filter((row) => row.url)
    .map((row) => ({
      label: row.label || row.url,
      url: row.url,
    }));
}

function formatGeneratedCategory(value: string | null | undefined): Exclude<PostCategory, 'text'> {
  if (value === 'video' || value === 'motion' || value === 'ugc-ad') {
    return value;
  }

  return 'image';
}

function getLockedSummary(selectedKinds: PostResourceKind[]): string {
  if (selectedKinds.length === 0) {
    return 'Nothing locked';
  }

  return selectedKinds.map((kind) => getPostResourceKindLabel(kind)).join(', ');
}

export default function NewPostClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session } = useAuth();
  const generationId = searchParams.get('generationId');

  const [proofMode, setProofMode] = useState<ProofMode>('media');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [sourceTool, setSourceTool] = useState('');
  const [visibility, setVisibility] = useState<PostVisibility>('public');
  const [category, setCategory] = useState<Exclude<PostCategory, 'text'>>('image');
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [resourceAccessMode, setResourceAccessMode] = useState<PostResourceBundleAccessMode>('none');
  const [resourceSelections, setResourceSelections] = useState<Record<PostResourceKind, boolean>>(EMPTY_RESOURCE_SELECTIONS);
  const [resourcePromptText, setResourcePromptText] = useState('');
  const [resourceNotes, setResourceNotes] = useState('');
  const [resourceWorkflowUrl, setResourceWorkflowUrl] = useState('');
  const [resourceAttachmentRows, setResourceAttachmentRows] = useState<AttachmentRow[]>([createAttachmentRow()]);
  const [resourcePriceUsd, setResourcePriceUsd] = useState('9');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdPost, setCreatedPost] = useState<CreatedPostState | null>(null);
  const [prefilledGeneration, setPrefilledGeneration] = useState<GenerationDraft | null>(null);
  const [isLoadingGeneration, setIsLoadingGeneration] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  const inferredCategory = useMemo(() => inferCategory(file), [file]);
  const hasGeneratedProof = Boolean(prefilledGeneration);
  const selectedResourceKinds = useMemo(
    () => RESOURCE_KIND_OPTIONS.filter((option) => resourceSelections[option.value]).map((option) => option.value),
    [resourceSelections]
  );
  const trimmedBody = body.trim();
  const bodyCount = body.length;
  const hasMediaProof = proofMode === 'media' && (Boolean(file) || hasGeneratedProof);
  const postFormat: PostFormat = hasMediaProof ? (trimmedBody ? 'mixed' : 'media') : 'text';
  const effectiveVisibility = resourceAccessMode === 'none' ? visibility : 'public';
  const attachments = useMemo(() => serializeAttachmentRows(resourceAttachmentRows), [resourceAttachmentRows]);
  const hasResourceContent = Boolean(
    (resourceSelections.prompt && resourcePromptText.trim()) ||
    (resourceSelections.notes && resourceNotes.trim()) ||
    (resourceSelections.workflow && resourceWorkflowUrl.trim()) ||
    (resourceSelections.files && attachments.length > 0) ||
    resourceSelections.remix
  );
  const stepBadgeLabel = hasGeneratedProof ? 'Generated proof attached' : proofMode === 'text' ? 'Note only' : 'Proof media';

  useEffect(() => {
    if (!previewUrl) {
      return;
    }

    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    if (file && !acceptsCategory(file, category) && inferredCategory) {
      setCategory(inferredCategory);
    }
  }, [category, file, inferredCategory]);

  useEffect(() => {
    if (resourceAccessMode === 'none') {
      return;
    }

    setVisibility('public');

    if (!Object.values(resourceSelections).some(Boolean)) {
      setResourceSelections((current) => ({
        ...current,
        prompt: true,
      }));
    }
  }, [resourceAccessMode, resourceSelections]);

  useEffect(() => {
    if (!resourceSelections.files) {
      return;
    }

    if (resourceAttachmentRows.length === 0) {
      setResourceAttachmentRows([createAttachmentRow()]);
    }
  }, [resourceAttachmentRows.length, resourceSelections.files]);

  useEffect(() => {
    if (!generationId || !session?.access_token) {
      setPrefilledGeneration(null);
      setGenerationError(null);
      return;
    }

    let cancelled = false;

    const loadGeneration = async () => {
      setIsLoadingGeneration(true);
      setGenerationError(null);

      try {
        const response = await fetch('/api/generations', {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || 'Failed to load generation.');
        }

        const generation = Array.isArray(payload.generations)
          ? payload.generations.find((item: { id?: string }) => item.id === generationId)
          : null;

        if (!generation) {
          throw new Error('We could not find that generation in your account.');
        }

        if (cancelled) {
          return;
        }

        const nextGeneration: GenerationDraft = {
          id: generation.id,
          title: typeof generation.title === 'string' ? generation.title : '',
          description: typeof generation.description === 'string' ? generation.description : '',
          prompt: typeof generation.prompt === 'string' ? generation.prompt : '',
          outputUrl: typeof generation.output_url === 'string' ? generation.output_url : null,
          category: formatGeneratedCategory(generation.category),
          model: typeof generation.model === 'string' ? generation.model : 'UGC copy',
        };

        setPrefilledGeneration(nextGeneration);
        setProofMode('media');
        setCategory(nextGeneration.category);
        setTitle((current) => current || nextGeneration.title);
        setDescription((current) => current || nextGeneration.description);
      } catch (loadError) {
        if (!cancelled) {
          setGenerationError(loadError instanceof Error ? loadError.message : 'Failed to load generation.');
          setPrefilledGeneration(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingGeneration(false);
        }
      }
    };

    void loadGeneration();

    return () => {
      cancelled = true;
    };
  }, [generationId, session?.access_token]);

  const resetFeedback = () => {
    setCreatedPost(null);
    setError(null);
  };

  const updateResourceSelection = (kind: PostResourceKind) => {
    setResourceSelections((current) => ({
      ...current,
      [kind]: !current[kind],
    }));
    resetFeedback();
  };

  const updateAttachmentRow = (id: string, field: 'label' | 'url', value: string) => {
    setResourceAttachmentRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row))
    );
    resetFeedback();
  };

  const addAttachmentRow = () => {
    setResourceAttachmentRows((current) => [...current, createAttachmentRow()]);
    resetFeedback();
  };

  const removeAttachmentRow = (id: string) => {
    setResourceAttachmentRows((current) => {
      const nextRows = current.filter((row) => row.id !== id);
      return nextRows.length > 0 ? nextRows : [createAttachmentRow()];
    });
    resetFeedback();
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setCreatedPost(null);

    if (!session?.access_token) {
      router.push('/login?returnUrl=/post/new');
      return;
    }

    if (proofMode === 'media' && !hasMediaProof) {
      setError(hasGeneratedProof ? 'We could not load the generated proof. Try again from your creation workspace.' : 'Upload an image or video to start the post.');
      return;
    }

    if (!trimmedBody && !hasMediaProof) {
      setError('Add a story or proof before publishing.');
      return;
    }

    if (proofMode === 'text' && !trimmedBody) {
      setError('Write the story before publishing a note-only post.');
      return;
    }

    if (file?.type.startsWith('audio/')) {
      setError('Audio posts are not supported in the community feed yet.');
      return;
    }

    if (file && !acceptsCategory(file, category)) {
      setError('Choose a category that matches the file you uploaded.');
      return;
    }

    if (bodyCount > BODY_MAX_LENGTH) {
      setError(`Story posts are limited to ${BODY_MAX_LENGTH} characters.`);
      return;
    }

    let resourceBundle: Record<string, unknown> | undefined;
    if (resourceAccessMode !== 'none') {
      const parsedPrice = Number.parseFloat(resourcePriceUsd.trim() || '0');

      if (selectedResourceKinds.length === 0) {
        setError('Choose at least one thing people will unlock.');
        return;
      }

      if (resourceAccessMode === 'paid' && (!Number.isFinite(parsedPrice) || parsedPrice < 1)) {
        setError('Paid resources must be priced at $1.00 or above.');
        return;
      }

      if (!hasResourceContent) {
        setError('Add content for at least one selected resource before publishing.');
        return;
      }

      resourceBundle = {
        accessMode: resourceAccessMode,
        priceUsdCents: resourceAccessMode === 'paid' ? Math.round(parsedPrice * 100) : 0,
        resources: {
          promptText: resourceSelections.prompt ? resourcePromptText.trim() || null : null,
          notesMarkdown: resourceSelections.notes ? resourceNotes.trim() || null : null,
          workflowShareUrl: resourceSelections.workflow ? resourceWorkflowUrl.trim() || null : null,
          attachments: resourceSelections.files ? attachments : [],
          allowRemix: resourceSelections.remix,
        },
      };
    }

    try {
      setIsSubmitting(true);

      if (prefilledGeneration) {
        const response = await fetch('/api/showcase/publish', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            generationId: prefilledGeneration.id,
            isPublic: effectiveVisibility === 'public',
            title: title.trim() || undefined,
            description: description.trim() || undefined,
            body: trimmedBody || undefined,
            category,
            ...(resourceBundle ? { resourceBundle } : {}),
          }),
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to publish post.');
        }

        setCreatedPost({
          postId: data.postId as string,
          showcasePath: `/showcase/${data.postId as string}`,
          resourceBundlePath: data.resourceBundlePath as string,
          visibility: (data.isPublic ? 'public' : 'private') as PostVisibility,
          resourceAccessMode,
        });

        return;
      }

      const formData = new FormData();
      formData.set('title', title);
      formData.set('description', description);
      formData.set('body', body);
      formData.set('sourceTool', sourceTool);
      formData.set('visibility', effectiveVisibility);
      formData.set('postFormat', postFormat);
      formData.set('resourceBundle', JSON.stringify(resourceBundle ?? { accessMode: 'none' }));

      if (hasMediaProof && file) {
        formData.set('media', file);
        formData.set('category', category);
      }

      const response = await fetch('/api/posts', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
        body: formData,
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to publish post.');
      }

      setCreatedPost({
        postId: data.postId as string,
        showcasePath: data.showcasePath as string,
        resourceBundlePath: data.resourceBundlePath as string,
        visibility: data.visibility as PostVisibility,
        resourceAccessMode,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to publish post.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const createdPostHasResources = createdPost ? createdPost.resourceAccessMode !== 'none' : false;
  const selectedVisibilityOption = VISIBILITY_OPTIONS.find((option) => option.value === effectiveVisibility) ?? VISIBILITY_OPTIONS[0];

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute left-[-10%] top-[-8%] h-[40%] w-[32%] rounded-full bg-sky-500/12 blur-[140px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[36%] w-[30%] rounded-full bg-emerald-500/10 blur-[160px]" />
      </div>

      <div className="studio-shell relative z-10 py-12 sm:py-16">
        <Link
          href="/showcase"
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to feed
        </Link>

        <div className="mt-10 grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_420px]">
          <section className="rounded-[32px] border border-white/8 bg-zinc-950/70 p-5 shadow-[0_28px_80px_rgba(0,0,0,0.45)] backdrop-blur-sm sm:p-6">
            <div className="mb-6 flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">Post composer</div>
                  <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                    Publish the proof and decide what unlocks with it
                  </h1>
                  <p className="mt-3 max-w-2xl text-sm leading-7 text-zinc-300">
                    One flow, one post, one optional unlock. Start with the proof, add the story, and only attach resources if the post needs them.
                  </p>
                </div>
                <div className="hidden rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-100 sm:inline-flex">
                  Creator-first publishing
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-4">
                {STEP_ORDER.map((step, index) => (
                  <div
                    key={step}
                    className="rounded-[22px] border border-white/8 bg-white/[0.03] px-4 py-3"
                  >
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-500">
                      Step {index + 1}
                    </div>
                    <div className="mt-2 text-sm font-semibold text-white">{step}</div>
                  </div>
                ))}
              </div>
            </div>

            <form className="space-y-6" onSubmit={handleSubmit}>
              <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(17,24,39,0.94),rgba(9,11,16,0.96))] p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-200/75">Step 1</div>
                    <h2 className="mt-2 text-xl font-semibold text-white">Start with the proof</h2>
                    <p className="mt-2 text-sm leading-6 text-zinc-300">
                      {hasGeneratedProof
                        ? 'Your generated proof is already attached. You can tell the story and decide what unlocks next.'
                        : 'Pick the simplest starting point: proof media or a note-only post.'}
                    </p>
                  </div>
                  <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-medium text-zinc-300">
                    {stepBadgeLabel}
                  </div>
                </div>

                {!hasGeneratedProof ? (
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    {([
                      {
                        value: 'media',
                        label: 'Media proof',
                        description: 'Upload the result first, then add the story and optional unlock.',
                        icon: UploadCloud,
                      },
                      {
                        value: 'text',
                        label: 'Note only',
                        description: 'Publish a tactic, lesson, or idea without media.',
                        icon: BookText,
                      },
                    ] as const).map((option) => {
                      const Icon = option.icon;
                      const active = proofMode === option.value;

                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setProofMode(option.value);
                            if (option.value === 'text') {
                              setFile(null);
                            }
                            resetFeedback();
                          }}
                          className={`rounded-[24px] border px-4 py-4 text-left transition ${
                            active
                              ? 'border-sky-400/40 bg-sky-400/10 shadow-[0_12px_30px_rgba(56,189,248,0.12)]'
                              : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-black/30 text-sky-100">
                              <Icon className="h-5 w-5" />
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-white">{option.label}</div>
                              <p className="mt-1 text-xs leading-5 text-zinc-400">{option.description}</p>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {proofMode === 'media' ? (
                  <div className="mt-5">
                    {hasGeneratedProof ? (
                      <div className="rounded-[28px] border border-white/10 bg-white/[0.02] p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Generated proof</div>
                            <div className="mt-2 text-lg font-semibold text-white">
                              {prefilledGeneration?.title || 'UGC copy creation'}
                            </div>
                            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-300">
                              Created in UGC copy with {prefilledGeneration?.model || 'your latest model'}.
                            </p>
                          </div>
                          <div className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-50">
                            Attached automatically
                          </div>
                        </div>

                        <div className="mt-5 rounded-[24px] border border-white/8 bg-black/50 p-3">
                          {isLoadingGeneration ? (
                            <div className="flex min-h-[320px] items-center justify-center">
                              <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
                            </div>
                          ) : prefilledGeneration?.outputUrl ? (
                            category === 'video' || category === 'motion' ? (
                              <video
                                src={prefilledGeneration.outputUrl}
                                controls
                                playsInline
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={prefilledGeneration.outputUrl}
                                alt={title || 'Generated preview'}
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            )
                          ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-[18px] border border-dashed border-white/10 bg-zinc-950/60 text-center">
                              <Sparkles className="h-10 w-10 text-zinc-500" />
                              <p className="mt-4 max-w-sm text-sm leading-6 text-zinc-400">
                                The generation is attached, but the preview could not be loaded here.
                              </p>
                            </div>
                          )}
                        </div>

                        {generationError ? (
                          <div className="mt-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                            {generationError}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <label className="block rounded-[28px] border border-dashed border-white/14 bg-white/[0.02] p-5 transition hover:border-white/20 hover:bg-white/[0.03]">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-center gap-4">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-100">
                              <UploadCloud className="h-6 w-6" />
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-white">Upload image or video</div>
                              <p className="mt-1 text-sm text-zinc-400">
                                Start with the proof. Everything else can layer in after this.
                              </p>
                            </div>
                          </div>
                          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-xs font-medium text-zinc-300">
                            <BadgePlus className="h-3.5 w-3.5" />
                            JPG, PNG, MP4, MOV
                          </span>
                        </div>

                        <input
                          type="file"
                          accept="image/*,video/*"
                          className="sr-only"
                          onChange={(event) => {
                            const nextFile = event.target.files?.[0] ?? null;
                            setFile(nextFile);
                            resetFeedback();
                          }}
                        />

                        <div className="mt-5 rounded-[24px] border border-white/8 bg-black/50 p-3">
                          {previewUrl ? (
                            file?.type.startsWith('video/') ? (
                              <video
                                src={previewUrl}
                                controls
                                playsInline
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={previewUrl}
                                alt={title || 'Uploaded preview'}
                                className="max-h-[520px] w-full rounded-[18px] bg-black object-contain"
                              />
                            )
                          ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-[18px] border border-dashed border-white/10 bg-zinc-950/60 text-center">
                              {inferredCategory === 'video' ? (
                                <Film className="h-10 w-10 text-zinc-500" />
                              ) : (
                                <ImageIcon className="h-10 w-10 text-zinc-500" />
                              )}
                              <p className="mt-4 max-w-sm text-sm leading-6 text-zinc-400">
                                Drop in the creative first, then decide if the post needs a story or unlockable resources.
                              </p>
                            </div>
                          )}
                        </div>
                      </label>
                    )}
                  </div>
                ) : (
                  <div className="mt-5 rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.14),transparent_34%),linear-gradient(180deg,rgba(20,20,24,0.96),rgba(10,10,14,0.96))] p-5">
                    <div className="flex items-center gap-4">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-100">
                        <BookText className="h-6 w-6" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white">This will be a note-only post</div>
                        <p className="mt-1 text-sm text-zinc-400">
                          Use the story section below to write the actual post. Media is optional for this path.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-[28px] border border-white/8 bg-black/20 p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Step 2</div>
                    <h2 className="mt-2 text-lg font-semibold text-white">Tell the story behind the proof</h2>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                      This is the public part people see before they decide to unlock anything.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsDetailsOpen((current) => !current)}
                    className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                  >
                    {isDetailsOpen ? 'Hide details' : 'Add details (optional)'}
                  </button>
                </div>

                <label className="mt-5 block">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                      {proofMode === 'text' ? 'Story' : 'Caption / story'}
                    </span>
                    <span className={`text-xs ${bodyCount > BODY_MAX_LENGTH ? 'text-rose-300' : 'text-zinc-500'}`}>
                      {bodyCount}/{BODY_MAX_LENGTH}
                    </span>
                  </div>
                  <textarea
                    value={body}
                    onChange={(event) => {
                      setBody(event.target.value);
                      resetFeedback();
                    }}
                    placeholder={
                      proofMode === 'text'
                        ? 'Share the tactic, lesson, or idea people should take away from this post.'
                        : 'Optional: explain why this worked, what changed, or what someone should notice before they unlock the resources.'
                    }
                    rows={proofMode === 'text' ? 8 : 6}
                    className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                </label>

                {isDetailsOpen ? (
                  <div className="mt-5 space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Title</div>
                        <input
                          value={title}
                          onChange={(event) => {
                            setTitle(event.target.value);
                            resetFeedback();
                          }}
                          placeholder={proofMode === 'text' ? 'Optional title, or let us derive one' : 'Spring product reveal'}
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                        />
                      </label>

                      {proofMode === 'media' && !hasGeneratedProof ? (
                        <label className="block">
                          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Made with</div>
                          <input
                            value={sourceTool}
                            onChange={(event) => {
                              setSourceTool(event.target.value);
                              resetFeedback();
                            }}
                            placeholder="Runway, Midjourney, CapCut..."
                            className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                          />
                        </label>
                      ) : (
                        <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                            {hasGeneratedProof ? 'Source' : 'Post type'}
                          </div>
                          <div className="mt-3 inline-flex rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm font-medium text-zinc-100">
                            {hasGeneratedProof ? 'Created in UGC copy' : 'Text only'}
                          </div>
                        </div>
                      )}
                    </div>

                    <label className="block">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Description</div>
                      <textarea
                        value={description}
                        onChange={(event) => {
                          setDescription(event.target.value);
                          resetFeedback();
                        }}
                        placeholder="Optional: give the post a short one-line setup for feeds and previews."
                        rows={3}
                        className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                      />
                    </label>

                    {proofMode === 'media' ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Category</div>
                        <select
                          value={category}
                          onChange={(event) => {
                            setCategory(event.target.value as Exclude<PostCategory, 'text'>);
                            resetFeedback();
                          }}
                          disabled={hasGeneratedProof}
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {CATEGORY_OPTIONS.map((option) => (
                            <option
                              key={option.value}
                              value={option.value}
                              disabled={file ? !acceptsCategory(file, option.value) : false}
                              className="bg-zinc-950 text-white"
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <p className="mt-2 text-xs leading-5 text-zinc-500">
                          {hasGeneratedProof
                            ? 'Generated proof keeps its category automatically.'
                            : CATEGORY_OPTIONS.find((option) => option.value === category)?.description}
                        </p>
                      </label>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-4 text-sm leading-6 text-zinc-400">
                    Title, description, source tool, and category tuning all stay optional until they actually help this post travel further.
                  </p>
                )}
              </div>

              <div className="rounded-[28px] border border-emerald-500/15 bg-emerald-500/5 p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-100/75">Step 3</div>
                    <h2 className="mt-2 text-lg font-semibold text-white">Choose whether this post has resources</h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
                      If people should unlock the prompt, workflow, files, notes, or remix access from this same post, choose free or paid and reveal only what matters.
                    </p>
                  </div>
                  <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-medium text-zinc-300">
                    {resourceAccessMode === 'none' ? 'Post only' : resourceAccessMode === 'free' ? 'Free unlock' : 'Paid unlock'}
                  </div>
                </div>

                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  {RESOURCE_ACCESS_OPTIONS.map((option) => {
                    const active = resourceAccessMode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setResourceAccessMode(option.value);
                          resetFeedback();
                        }}
                        className={`rounded-[24px] border p-4 text-left transition ${
                          active
                            ? 'border-emerald-300/35 bg-emerald-400/12 text-white'
                            : 'border-white/10 bg-white/[0.02] text-zinc-300 hover:border-white/20 hover:bg-white/[0.04] hover:text-white'
                        }`}
                      >
                        <div className="text-sm font-semibold">{option.label}</div>
                        <p className="mt-2 text-xs leading-5 text-zinc-400">{option.description}</p>
                      </button>
                    );
                  })}
                </div>

                {resourceAccessMode !== 'none' ? (
                  <div className="mt-5 space-y-5">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">What are people unlocking?</div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {RESOURCE_KIND_OPTIONS.map((option) => {
                          const active = resourceSelections[option.value];

                          return (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => updateResourceSelection(option.value)}
                              className={`rounded-[22px] border px-4 py-4 text-left transition ${
                                active
                                  ? 'border-emerald-300/35 bg-emerald-400/12'
                                  : 'border-white/10 bg-white/[0.02] hover:border-white/18 hover:bg-white/[0.04]'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-sm font-semibold text-white">{option.label}</div>
                                {active ? <Check className="h-4 w-4 text-emerald-200" /> : null}
                              </div>
                              <p className="mt-2 text-xs leading-5 text-zinc-400">{option.description}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {resourceSelections.prompt ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Prompt</div>
                        <textarea
                          value={resourcePromptText}
                          onChange={(event) => {
                            setResourcePromptText(event.target.value);
                            resetFeedback();
                          }}
                          rows={6}
                          placeholder="Paste the exact prompt people should unlock."
                          className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                      </label>
                    ) : null}

                    {resourceSelections.notes ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Notes</div>
                        <textarea
                          value={resourceNotes}
                          onChange={(event) => {
                            setResourceNotes(event.target.value);
                            resetFeedback();
                          }}
                          rows={6}
                          placeholder="Add the steps, settings, or instructions that make this reusable."
                          className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                      </label>
                    ) : null}

                    {resourceSelections.workflow ? (
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Workflow link</div>
                        <input
                          value={resourceWorkflowUrl}
                          onChange={(event) => {
                            setResourceWorkflowUrl(event.target.value);
                            resetFeedback();
                          }}
                          placeholder="https://..."
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05]"
                        />
                      </label>
                    ) : null}

                    {resourceSelections.files ? (
                      <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Files / links</div>
                            <p className="mt-1 text-sm leading-6 text-zinc-400">
                              Add one or more labeled links people should open after unlocking.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={addAttachmentRow}
                            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                          >
                            <Plus className="h-4 w-4" />
                            Add link
                          </button>
                        </div>

                        <div className="mt-4 space-y-3">
                          {resourceAttachmentRows.map((row, index) => (
                            <div key={row.id} className="grid gap-3 rounded-[20px] border border-white/8 bg-white/[0.03] p-3 md:grid-cols-[minmax(0,180px)_1fr_auto]">
                              <input
                                value={row.label}
                                onChange={(event) => updateAttachmentRow(row.id, 'label', event.target.value)}
                                placeholder={`Label ${index + 1}`}
                                className="rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                              />
                              <input
                                value={row.url}
                                onChange={(event) => updateAttachmentRow(row.id, 'url', event.target.value)}
                                placeholder="https://..."
                                className="rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-black/45"
                              />
                              <button
                                type="button"
                                onClick={() => removeAttachmentRow(row.id)}
                                className="inline-flex items-center justify-center rounded-2xl border border-white/10 bg-black/35 px-3 py-3 text-zinc-300 transition hover:bg-black/45 hover:text-white"
                                aria-label={`Remove link ${index + 1}`}
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {resourceSelections.remix ? (
                      <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                        <div className="text-sm font-semibold text-white">Remix access is included in this unlock</div>
                        <p className="mt-1 text-sm leading-6 text-zinc-400">
                          People will need to unlock these resources before remixing this post.
                        </p>
                      </div>
                    ) : null}

                    <div className="grid gap-4 md:grid-cols-[minmax(0,220px)_1fr]">
                      <label className="block">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Price</div>
                        <input
                          value={resourcePriceUsd}
                          onChange={(event) => {
                            setResourcePriceUsd(event.target.value);
                            resetFeedback();
                          }}
                          disabled={resourceAccessMode !== 'paid'}
                          placeholder="9"
                          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-emerald-400/35 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
                        />
                        <p className="mt-2 text-xs leading-5 text-zinc-500">
                          {resourceAccessMode === 'paid'
                            ? 'Choose any price at or above $1.00.'
                            : 'Free unlock. Buyers just click once to access it.'}
                        </p>
                      </label>

                      <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Visibility</div>
                        <p className="mt-3 text-sm leading-6 text-zinc-300">
                          Posts with unlockable resources are public so others can discover the proof first.
                        </p>
                        <div className="mt-3 inline-flex rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1.5 text-sm font-semibold text-emerald-50">
                          Public post required
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="mt-4 text-sm leading-6 text-zinc-400">
                    Leave this off if the post should stand alone with no locked prompt, workflow, files, notes, or remix access.
                  </p>
                )}
              </div>

              {error ? (
                <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {error}
                </div>
              ) : null}

              {createdPost ? (
                <div className="rounded-[28px] border border-emerald-500/20 bg-emerald-500/10 p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="text-sm font-semibold text-white">
                      {createdPostHasResources ? 'Post published with resources' : 'Post published'}
                    </div>
                    <div className="rounded-full border border-emerald-300/20 bg-black/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-50">
                      {createdPost.visibility}
                    </div>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-emerald-50/90">
                    {createdPostHasResources
                      ? 'The proof is public and the locked resources are ready on the same post page.'
                      : createdPost.visibility === 'public'
                        ? 'Your post is live.'
                        : 'Your post is saved with limited visibility.'}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Link
                      href={createdPost.showcasePath}
                      className="rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
                    >
                      View post
                    </Link>
                    {createdPostHasResources ? (
                      <Link
                        href={createdPost.resourceBundlePath}
                        className="rounded-full border border-emerald-300/30 bg-emerald-400/15 px-4 py-2.5 text-sm font-semibold text-emerald-50 transition hover:border-emerald-200/40 hover:bg-emerald-400/20"
                      >
                        Open resources section
                      </Link>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="rounded-[28px] border border-white/8 bg-zinc-950/75 p-5">
                <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Step 4</div>
                <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="max-w-xl">
                    <h2 className="text-lg font-semibold text-white">Review what is public and what unlocks</h2>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">{selectedVisibilityOption.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="submit"
                      disabled={isSubmitting || isLoadingGeneration}
                      className="inline-flex items-center gap-2 rounded-full bg-sky-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgePlus className="h-4 w-4" />}
                      Publish post
                    </button>
                    <Link
                      href="/showcase"
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                    >
                      Back to feed
                    </Link>
                  </div>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-3">
                  <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Public</div>
                    <div className="mt-3 text-sm font-semibold text-white">{effectiveVisibility === 'public' ? 'Public post' : selectedVisibilityOption.label}</div>
                    <p className="mt-2 text-sm leading-6 text-zinc-300">
                      {proofMode === 'media'
                        ? 'Proof media'
                        : 'Story only'}
                      {title.trim() ? `, ${title.trim()}` : ''}
                      {trimmedBody ? ', story included' : ''}
                    </p>
                  </div>

                  <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Locked</div>
                    <div className="mt-3 text-sm font-semibold text-white">
                      {resourceAccessMode === 'none' ? 'No resources attached' : getLockedSummary(selectedResourceKinds)}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-300">
                      {resourceAccessMode === 'none'
                        ? 'This post stands alone.'
                        : 'People unlock these resources directly from the post page.'}
                    </p>
                  </div>

                  <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">Price</div>
                    <div className="mt-3 text-sm font-semibold text-white">
                      {resourceAccessMode === 'paid'
                        ? formatUsdCents(Math.round((Number.parseFloat(resourcePriceUsd.trim() || '0') || 0) * 100))
                        : resourceAccessMode === 'free'
                          ? 'Free unlock'
                          : 'No unlock'}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-300">
                      {resourceAccessMode === 'paid'
                        ? 'Buyers pay once to reveal the full resource set.'
                        : resourceAccessMode === 'free'
                          ? 'Buyers click once to reveal the resources.'
                          : 'Nothing sits behind a paywall or free unlock.'}
                    </p>
                  </div>
                </div>

                {resourceAccessMode === 'none' ? (
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    {VISIBILITY_OPTIONS.map((option) => {
                      const active = visibility === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setVisibility(option.value);
                            resetFeedback();
                          }}
                          className={`rounded-[24px] border p-4 text-left transition ${
                            active
                              ? 'border-emerald-300/35 bg-emerald-400/12 text-white'
                              : 'border-white/10 bg-white/[0.02] text-zinc-300 hover:border-white/20 hover:bg-white/[0.04] hover:text-white'
                          }`}
                        >
                          <div className="text-sm font-semibold">{option.label}</div>
                          <p className="mt-2 text-xs leading-5 text-zinc-400">{option.description}</p>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </form>
          </section>

          <aside className="space-y-5">
            <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Fast path</div>
              <div className="mt-4 space-y-4">
                {[
                  'Start with the proof: upload media, keep the generated proof, or publish a note-only post.',
                  'Write only the public story people should see before they decide to unlock anything.',
                  'If this post has reusable value, choose free or paid resources and reveal only the sections you actually need.',
                ].map((step, index) => (
                  <div key={step} className="flex items-start gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-sm font-semibold text-white">
                      {index + 1}
                    </div>
                    <p className="pt-1 text-sm leading-6 text-zinc-300">{step}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">What people unlock</div>
              <h2 className="mt-3 text-xl font-semibold text-white">One post, one optional resource bundle</h2>
              <p className="mt-3 text-sm leading-7 text-zinc-300">
                The proof stays public. If the prompt, workflow, files, notes, or remix access should unlock later, attach them here and buyers will access everything directly on the post page.
              </p>
              <Link
                href="/marketplace"
                className="mt-5 inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/35 hover:bg-emerald-500/15"
              >
                See discovery examples
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>

            {selectedResourceKinds.length > 0 ? (
              <div className="rounded-[30px] border border-emerald-500/15 bg-emerald-500/5 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
                <div className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-200/75">Current unlock</div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {selectedResourceKinds.map((kind) => (
                    <div
                      key={kind}
                      className="inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-black/30 px-3 py-1.5 text-sm font-medium text-emerald-50"
                    >
                      {kind === 'workflow' ? <Link2 className="h-3.5 w-3.5" /> : null}
                      {getPostResourceKindLabel(kind)}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
