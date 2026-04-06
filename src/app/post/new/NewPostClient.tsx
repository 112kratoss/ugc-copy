'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, BadgePlus, BookText, Film, ImageIcon, Loader2, UploadCloud } from 'lucide-react';

import { useAuth } from '@/app/components/AuthProvider';

type PostCategory = 'image' | 'video' | 'motion' | 'ugc-ad' | 'text';
type PostVisibility = 'public' | 'unlisted' | 'private';
type PostFormat = 'text' | 'media' | 'mixed';

interface CreatedPostState {
  postId: string;
  showcasePath: string;
  attachAssetPath: string;
}

const BODY_MAX_LENGTH = 2000;

const FORMAT_OPTIONS: Array<{
  value: PostFormat;
  label: string;
  description: string;
}> = [
  { value: 'text', label: 'Tip / Note', description: 'Short text posts for tactics, wins, and ideas.' },
  { value: 'media', label: 'Media post', description: 'Share a visual from UGC copy or any external tool.' },
  { value: 'mixed', label: 'Media + note', description: 'Pair a post with the insight behind why it worked.' },
];

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

export default function NewPostClient() {
  const router = useRouter();
  const { session } = useAuth();
  const [postFormat, setPostFormat] = useState<PostFormat>('media');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [body, setBody] = useState('');
  const [sourceTool, setSourceTool] = useState('');
  const [visibility, setVisibility] = useState<PostVisibility>('public');
  const [category, setCategory] = useState<Exclude<PostCategory, 'text'>>('image');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createdPost, setCreatedPost] = useState<CreatedPostState | null>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  const inferredCategory = useMemo(() => inferCategory(file), [file]);
  const requiresMedia = postFormat === 'media' || postFormat === 'mixed';
  const requiresBody = postFormat === 'text' || postFormat === 'mixed';
  const trimmedBody = body.trim();
  const bodyCount = body.length;

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
    if (postFormat === 'text') {
      setFile(null);
      setSourceTool('');
      setCategory('image');
    }
  }, [postFormat]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setCreatedPost(null);

    if (!session?.access_token) {
      router.push('/login?returnUrl=/post/new');
      return;
    }

    if (!trimmedBody && !file) {
      setError('Add a note or upload media to publish a post.');
      return;
    }

    if (requiresBody && !trimmedBody) {
      setError(postFormat === 'text' ? 'Write your tip or note before publishing.' : 'Add the note that should appear with this media post.');
      return;
    }

    if (requiresMedia && !file) {
      setError('Choose an image or video to publish.');
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
      setError(`Text posts are limited to ${BODY_MAX_LENGTH} characters.`);
      return;
    }

    const formData = new FormData();
    formData.set('title', title);
    formData.set('description', description);
    formData.set('prompt', prompt);
    formData.set('body', body);
    formData.set('sourceTool', sourceTool);
    formData.set('visibility', visibility);
    formData.set('postFormat', postFormat);

    if (requiresMedia && file) {
      formData.set('media', file);
      formData.set('category', category);
    }

    try {
      setIsSubmitting(true);
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
        attachAssetPath: data.attachAssetPath as string,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to publish post.');
    } finally {
      setIsSubmitting(false);
    }
  };

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
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-zinc-500">Community publishing</div>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Publish media, notes, and mixed posts
                </h1>
              </div>
              <div className="hidden rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-100 sm:inline-flex">
                Unified posts
              </div>
            </div>

            <div className="mb-6 grid gap-3 sm:grid-cols-3">
              {FORMAT_OPTIONS.map((option) => {
                const active = postFormat === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setPostFormat(option.value);
                      setCreatedPost(null);
                      setError(null);
                    }}
                    className={`rounded-[24px] border px-4 py-4 text-left transition ${
                      active
                        ? 'border-sky-400/40 bg-sky-400/10 shadow-[0_12px_30px_rgba(56,189,248,0.12)]'
                        : 'border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="text-sm font-semibold text-white">{option.label}</div>
                    <p className="mt-2 text-xs leading-5 text-zinc-400">{option.description}</p>
                  </button>
                );
              })}
            </div>

            <form className="space-y-6" onSubmit={handleSubmit}>
              {requiresMedia ? (
                <label className="block rounded-[28px] border border-dashed border-white/14 bg-white/[0.02] p-5 transition hover:border-white/20 hover:bg-white/[0.03]">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-4">
                      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-100">
                        <UploadCloud className="h-6 w-6" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-white">Upload image or video</div>
                        <p className="mt-1 text-sm text-zinc-400">
                          Pull in work made in Midjourney, Runway, CapCut, or anywhere else.
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
                      setCreatedPost(null);
                      setError(null);
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
                          Drop in the final creative you want to share, then add the context other creators should see with it.
                        </p>
                      </div>
                    )}
                  </div>
                </label>
              ) : (
                <div className="rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.14),transparent_34%),linear-gradient(180deg,rgba(20,20,24,0.96),rgba(10,10,14,0.96))] p-5">
                  <div className="flex items-center gap-4">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-400/20 bg-sky-400/10 text-sky-100">
                      <BookText className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white">Write a note for the feed</div>
                      <p className="mt-1 text-sm text-zinc-400">
                        Share a tactic, creative lesson, or quick tip that other creators can act on immediately.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Title</div>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={postFormat === 'text' ? 'Optional title, or let us derive one' : 'Spring product reveal'}
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                </label>

                {requiresMedia ? (
                  <label className="block">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Made with</div>
                    <input
                      value={sourceTool}
                      onChange={(event) => setSourceTool(event.target.value)}
                      placeholder="Runway, Midjourney, CapCut..."
                      className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                    />
                  </label>
                ) : (
                  <label className="block">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Visibility</div>
                    <select
                      value={visibility}
                      onChange={(event) => setVisibility(event.target.value as PostVisibility)}
                      className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                    >
                      <option value="public" className="bg-zinc-950 text-white">Public</option>
                      <option value="unlisted" className="bg-zinc-950 text-white">Unlisted</option>
                      <option value="private" className="bg-zinc-950 text-white">Private</option>
                    </select>
                  </label>
                )}
              </div>

              {requiresBody ? (
                <label className="block">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                      {postFormat === 'text' ? 'Tip or note' : 'Note for this post'}
                    </span>
                    <span className={`text-xs ${bodyCount > BODY_MAX_LENGTH ? 'text-rose-300' : 'text-zinc-500'}`}>
                      {bodyCount}/{BODY_MAX_LENGTH}
                    </span>
                  </div>
                  <textarea
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    placeholder={
                      postFormat === 'text'
                        ? 'Share a sharp insight, quick workflow tip, or lesson learned.'
                        : 'Explain why this creative worked, what changed, or how someone else should reuse it.'
                    }
                    rows={postFormat === 'text' ? 8 : 6}
                    className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  />
                </label>
              ) : null}

              <label className="block">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Description</div>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What is this post about, and why should someone care?"
                  rows={4}
                  className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                />
              </label>

              <label className="block">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  {postFormat === 'text' ? 'Workflow notes or prompt references' : 'Prompt, workflow, or notes'}
                </div>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={
                    postFormat === 'text'
                      ? 'Optional: add extra context, references, or the exact prompt/workflow behind the tip.'
                      : 'Paste the prompt, outline the workflow, or explain how you made it.'
                  }
                  rows={5}
                  className="w-full rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                {requiresMedia ? (
                  <label className="block">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Category</div>
                    <select
                      value={category}
                      onChange={(event) => setCategory(event.target.value as Exclude<PostCategory, 'text'>)}
                      className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                    >
                      {CATEGORY_OPTIONS.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                          disabled={!acceptsCategory(file, option.value)}
                          className="bg-zinc-950 text-white"
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-2 text-xs leading-5 text-zinc-500">
                      {CATEGORY_OPTIONS.find((option) => option.value === category)?.description}
                    </p>
                  </label>
                ) : (
                  <div className="rounded-[24px] border border-white/8 bg-black/30 p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Category</div>
                    <div className="mt-3 inline-flex rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm font-medium text-zinc-100">
                      Text
                    </div>
                  </div>
                )}

                <label className="block">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Visibility</div>
                  <select
                    value={visibility}
                    onChange={(event) => setVisibility(event.target.value as PostVisibility)}
                    className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 focus:bg-white/[0.05]"
                  >
                    <option value="public" className="bg-zinc-950 text-white">Public</option>
                    <option value="unlisted" className="bg-zinc-950 text-white">Unlisted</option>
                    <option value="private" className="bg-zinc-950 text-white">Private</option>
                  </select>
                  <p className="mt-2 text-xs leading-5 text-zinc-500">
                    Public posts appear in the feed. Unlisted posts keep a direct link only. Private keeps the draft on your profile.
                  </p>
                </label>
              </div>

              {error ? (
                <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {error}
                </div>
              ) : null}

              {createdPost ? (
                <div className="rounded-[28px] border border-emerald-500/20 bg-emerald-500/10 p-5">
                  <div className="text-sm font-semibold text-white">Post published</div>
                  <p className="mt-2 text-sm leading-6 text-emerald-50/90">
                    Your post is live in the community feed. You can view it now or attach a paid workflow, prompt pack, or guide next.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Link
                      href={createdPost.showcasePath}
                      className="rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
                    >
                      View post
                    </Link>
                    <Link
                      href={createdPost.attachAssetPath}
                      className="rounded-full border border-emerald-300/30 bg-emerald-400/15 px-4 py-2.5 text-sm font-semibold text-emerald-50 transition hover:border-emerald-200/40 hover:bg-emerald-400/20"
                    >
                      Attach paid resource
                    </Link>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="inline-flex items-center gap-2 rounded-full bg-sky-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgePlus className="h-4 w-4" />}
                  Publish post
                </button>
                <Link
                  href="/marketplace/sell"
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm font-medium text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
                >
                  Go to marketplace
                </Link>
              </div>
            </form>
          </section>

          <aside className="space-y-5">
            <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Why this matters</div>
              <h2 className="mt-3 text-xl font-semibold text-white">The feed can hold both media and insight</h2>
              <p className="mt-3 text-sm leading-7 text-zinc-300">
                Community value compounds faster when creators can share both finished outputs and the concise lessons behind them. That keeps the surface useful even when generation itself becomes cheaper.
              </p>
            </div>

            <div className="rounded-[30px] border border-white/8 bg-zinc-900/70 p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm">
              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-zinc-500">Next move</div>
              <h2 className="mt-3 text-xl font-semibold text-white">Attach the “how” behind the post</h2>
              <p className="mt-3 text-sm leading-7 text-zinc-300">
                After publishing, list the workflow, prompt pack, or guide that created the result. That turns a single post into a reusable system other creators can learn from or buy.
              </p>
              <Link
                href="/marketplace/sell"
                className="mt-5 inline-flex items-center gap-2 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-400/35 hover:bg-emerald-500/15"
              >
                Open seller dashboard
              </Link>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
