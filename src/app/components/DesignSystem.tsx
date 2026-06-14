import Link from 'next/link';
import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';

export type UiAccent =
  | 'image'
  | 'video'
  | 'motion'
  | 'workflow'
  | 'commerce'
  | 'danger'
  | 'neutral'
  | 'blue'
  | 'rose'
  | 'violet'
  | 'emerald'
  | 'amber';

type NormalizedAccent =
  | 'image'
  | 'video'
  | 'motion'
  | 'workflow'
  | 'commerce'
  | 'danger'
  | 'neutral';

type AccentClasses = {
  border: string;
  focusRing: string;
  iconWrap: string;
  badge: string;
  button: string;
  surface: string;
  accentText: string;
};

const ACCENT_ALIASES: Record<UiAccent, NormalizedAccent> = {
  image: 'image',
  video: 'video',
  motion: 'motion',
  workflow: 'workflow',
  commerce: 'commerce',
  danger: 'danger',
  neutral: 'neutral',
  blue: 'image',
  rose: 'video',
  violet: 'motion',
  emerald: 'workflow',
  amber: 'commerce',
};

const ACCENT_CLASSES: Record<NormalizedAccent, AccentClasses> = {
  image: {
    border: 'hover:border-sky-300/25',
    focusRing: 'focus-visible:border-sky-300/40 focus-visible:ring-sky-300/35',
    iconWrap: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
    badge: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    button: 'border-sky-200/70 bg-sky-300 text-slate-950 hover:bg-sky-200',
    surface: 'from-sky-500/20 via-sky-400/10 to-transparent',
    accentText: 'text-sky-300',
  },
  video: {
    border: 'hover:border-rose-300/25',
    focusRing: 'focus-visible:border-rose-300/40 focus-visible:ring-rose-300/35',
    iconWrap: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    badge: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    button: 'border-rose-200/70 bg-rose-300 text-slate-950 hover:bg-rose-200',
    surface: 'from-rose-500/20 via-fuchsia-400/10 to-transparent',
    accentText: 'text-rose-300',
  },
  motion: {
    border: 'hover:border-violet-300/25',
    focusRing: 'focus-visible:border-violet-300/40 focus-visible:ring-violet-300/35',
    iconWrap: 'border-violet-400/20 bg-violet-400/10 text-violet-100',
    badge: 'border-violet-400/20 bg-violet-400/10 text-violet-100',
    button: 'border-violet-200/70 bg-violet-300 text-slate-950 hover:bg-violet-200',
    surface: 'from-violet-500/20 via-indigo-400/10 to-transparent',
    accentText: 'text-violet-300',
  },
  workflow: {
    border: 'hover:border-emerald-300/25',
    focusRing: 'focus-visible:border-emerald-300/40 focus-visible:ring-emerald-300/35',
    iconWrap: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
    badge: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
    button: 'border-emerald-200/70 bg-emerald-300 text-slate-950 hover:bg-emerald-200',
    surface: 'from-emerald-500/20 via-teal-400/10 to-transparent',
    accentText: 'text-emerald-300',
  },
  commerce: {
    border: 'hover:border-amber-300/25',
    focusRing: 'focus-visible:border-amber-300/40 focus-visible:ring-amber-300/35',
    iconWrap: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
    badge: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
    button: 'border-amber-200/70 bg-amber-300 text-slate-950 hover:bg-amber-200',
    surface: 'from-amber-500/20 via-orange-400/10 to-transparent',
    accentText: 'text-amber-300',
  },
  danger: {
    border: 'hover:border-rose-300/25',
    focusRing: 'focus-visible:border-rose-300/40 focus-visible:ring-rose-300/35',
    iconWrap: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    badge: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    button: 'border-rose-200/70 bg-rose-300 text-slate-950 hover:bg-rose-200',
    surface: 'from-rose-500/20 via-red-400/10 to-transparent',
    accentText: 'text-rose-300',
  },
  neutral: {
    border: 'hover:border-white/18',
    focusRing: 'focus-visible:border-white/35 focus-visible:ring-white/25',
    iconWrap: 'border-white/10 bg-white/[0.04] text-zinc-100',
    badge: 'border-white/10 bg-white/[0.04] text-zinc-200',
    button: 'border-white/70 bg-white text-black hover:bg-zinc-200',
    surface: 'from-white/10 via-white/[0.04] to-transparent',
    accentText: 'text-zinc-200',
  },
};

export function getAccentClasses(accent: UiAccent = 'neutral') {
  return ACCENT_CLASSES[ACCENT_ALIASES[accent]];
}

export type TextVariant =
  | 'display'
  | 'pageTitle'
  | 'sectionTitle'
  | 'cardTitle'
  | 'body'
  | 'bodySm'
  | 'label'
  | 'caption'
  | 'metric'
  | 'code';

type TextElement = 'p' | 'span' | 'div' | 'h1' | 'h2' | 'h3' | 'strong' | 'code';

const TEXT_VARIANTS: Record<TextVariant, string> = {
  display: 'text-4xl font-bold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-6xl',
  pageTitle: 'text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl',
  sectionTitle: 'text-3xl font-semibold leading-tight tracking-tight text-white',
  cardTitle: 'text-xl font-semibold leading-7 tracking-tight text-white',
  body: 'text-base leading-6 text-zinc-300',
  bodySm: 'text-sm leading-6 text-zinc-400',
  label: 'text-xs font-semibold leading-4 text-zinc-300',
  caption: 'text-[11px] font-medium leading-4 text-zinc-500',
  metric: 'text-4xl font-bold leading-10 tracking-tight text-white',
  code: 'font-mono text-[13px] leading-5 text-zinc-300',
};

export function Text({
  as = 'p',
  variant = 'body',
  className,
  children,
}: {
  as?: TextElement;
  variant?: TextVariant;
  className?: string;
  children: ReactNode;
}) {
  const Component = as;

  return <Component className={clsx(TEXT_VARIANTS[variant], className)}>{children}</Component>;
}

export function Kicker({
  icon: Icon,
  children,
  className,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('ui-kicker inline-flex items-center gap-2', className)}>
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {children}
    </div>
  );
}

type SurfaceElement = 'div' | 'section' | 'article' | 'aside' | 'li';

const SURFACE_VARIANTS = {
  panel: 'ui-surface',
  card: 'ui-card',
  soft: 'ui-surface-soft',
  ghost: 'rounded-3xl border border-transparent bg-transparent',
} as const;

const SURFACE_PADDING = {
  none: '',
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
} as const;

export function Surface({
  as = 'div',
  variant = 'card',
  padding = 'md',
  interactive = false,
  className,
  children,
}: {
  as?: SurfaceElement;
  variant?: keyof typeof SURFACE_VARIANTS;
  padding?: keyof typeof SURFACE_PADDING;
  interactive?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const Component = as;

  return (
    <Component
      className={clsx(
        SURFACE_VARIANTS[variant],
        SURFACE_PADDING[padding],
        interactive && 'ui-card-interactive',
        className
      )}
    >
      {children}
    </Component>
  );
}

export function Button({
  href,
  prefetch,
  type = 'button',
  variant = 'secondary',
  accent = 'neutral',
  icon: Icon,
  iconPosition = 'end',
  disabled = false,
  ariaLabel,
  className,
  onClick,
  children,
}: {
  href?: string;
  prefetch?: boolean;
  type?: 'button' | 'submit' | 'reset';
  variant?: 'primary' | 'secondary' | 'ghost' | 'accent';
  accent?: UiAccent;
  icon?: LucideIcon;
  iconPosition?: 'start' | 'end';
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const accentClasses = getAccentClasses(accent);
  const classes = clsx(
    'ui-button ui-focus-ring',
    variant === 'primary' && 'ui-button-primary',
    variant === 'secondary' && 'ui-button-secondary',
    variant === 'ghost' && 'ui-button-ghost',
    variant === 'accent' && accentClasses.button,
    disabled && 'pointer-events-none opacity-55',
    className
  );
  const content = (
    <>
      {Icon && iconPosition === 'start' ? <Icon className="h-4 w-4" aria-hidden /> : null}
      {children}
      {Icon && iconPosition === 'end' ? <Icon className="h-4 w-4" aria-hidden /> : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} prefetch={prefetch} aria-label={ariaLabel} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type={type}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={onClick}
      className={classes}
    >
      {content}
    </button>
  );
}

export function IconButton({
  href,
  prefetch,
  label,
  icon: Icon,
  className,
  onClick,
}: {
  href?: string;
  prefetch?: boolean;
  label: string;
  icon: LucideIcon;
  className?: string;
  onClick?: () => void;
}) {
  const classes = clsx('ui-icon-button ui-focus-ring', className);
  const content = <Icon className="h-4 w-4" aria-hidden />;

  if (href) {
    return (
      <Link href={href} prefetch={prefetch} aria-label={label} title={label} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={classes}>
      {content}
    </button>
  );
}

export function Pill({
  accent = 'neutral',
  icon: Icon,
  className,
  children,
}: {
  accent?: UiAccent;
  icon?: LucideIcon;
  className?: string;
  children: ReactNode;
}) {
  const accentClasses = getAccentClasses(accent);

  return (
    <span className={clsx('ui-pill', accentClasses.badge, className)}>
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function MediaFrame({
  aspectRatio,
  className,
  children,
}: {
  aspectRatio?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={clsx('ui-media-frame', className)} style={aspectRatio ? { aspectRatio } : undefined}>
      {children}
    </div>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  actionHref,
  actionLabel,
  actionIcon,
  align = 'start',
  compact = false,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actionHref?: string;
  actionLabel?: string;
  actionIcon?: LucideIcon;
  align?: 'start' | 'center';
  compact?: boolean;
  className?: string;
}) {
  const ActionIcon = actionIcon;

  return (
    <div
      className={clsx(
        'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between',
        align === 'center' && 'items-center text-center sm:items-center sm:text-center',
        className
      )}
    >
      <div className={clsx(align === 'center' ? 'max-w-3xl' : 'max-w-2xl')}>
        {eyebrow ? <Kicker className="mb-2">{eyebrow}</Kicker> : null}
        <Text as="h2" variant={compact ? 'cardTitle' : 'sectionTitle'}>
          {title}
        </Text>
        {description ? (
          <Text variant="bodySm" className={clsx(compact ? 'mt-2' : 'mt-3 sm:text-base')}>
            {description}
          </Text>
        ) : null}
      </div>
      {actionHref && actionLabel ? (
        <Button href={actionHref} variant="secondary" icon={ActionIcon} className="shrink-0">
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function StatusCallout({
  tone = 'neutral',
  title,
  body,
  icon: Icon,
  className,
}: {
  tone?: 'neutral' | 'success' | 'danger';
  title: string;
  body?: string;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  className?: string;
}) {
  const toneClass =
    tone === 'success' ? 'text-emerald-300' : tone === 'danger' ? 'text-rose-300' : 'text-zinc-200';

  return (
    <Surface variant="soft" padding="md" className={clsx('flex gap-3', className)}>
      {Icon ? <Icon className={clsx('mt-0.5 h-5 w-5 shrink-0', toneClass)} aria-hidden /> : null}
      <div>
        <Text as="h3" variant="cardTitle" className={clsx('text-base leading-6', toneClass)}>
          {title}
        </Text>
        {body ? <Text variant="bodySm" className="mt-1">{body}</Text> : null}
      </div>
    </Surface>
  );
}
