import { AlertCircle, Search, Sparkles } from 'lucide-react';

export function SearchStateBlock({
  action,
  body,
  title,
  tone = 'empty',
}: {
  action?: React.ReactNode;
  body: string;
  title: string;
  tone?: 'initial' | 'empty' | 'error';
}) {
  const Icon = tone === 'error' ? AlertCircle : tone === 'initial' ? Sparkles : Search;
  return (
    <div
      className="flex min-h-72 flex-col items-center justify-center rounded-[32px] border border-white/8 bg-white/[0.025] px-6 py-14 text-center"
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.05] text-[var(--ui-primary)]">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <h2 className="mt-5 text-xl font-semibold text-white">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-zinc-400">{body}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
