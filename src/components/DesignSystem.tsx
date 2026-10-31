import Link from 'next/link';
import type { AriaRole, ComponentType, ReactNode } from 'react';
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
  /** A solid mark in the accent: the underline under a selected tab. */
  indicator: string;
  /** A chosen option in a row of choices: border, wash and text. */
  selected: string;
  /** A card that holds a field (a prompt): its border, stronger while the field has the focus. */
  outline: string;
  /** A field's border while it has the focus. */
  fieldFocus: string;
  /** A dashed tile that adds a file: idle, with its hover. */
  tile: string;
  /** The same tile while a file is dragged over it. */
  tileActive: string;
  /** An icon drawn in the accent. */
  mark: string;
  /** A native control's own accent colour (a range slider). */
  control: string;
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
    button: 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]',
    surface: 'from-sky-500/20 via-sky-400/10 to-transparent',
    accentText: 'text-sky-300',
    indicator: 'bg-brand-blue',
    selected: 'border-brand-blue/50 bg-brand-blue/15 text-[var(--ui-text-primary)]',
    outline: 'border-brand-blue/20 focus-within:border-brand-blue/60',
    fieldFocus: 'focus:border-brand-blue/50',
    tile: 'border-brand-blue/35 bg-brand-blue/5 hover:border-brand-blue/60',
    tileActive: 'border-brand-blue bg-brand-blue/10',
    mark: 'text-brand-blue',
    control: 'accent-brand-blue',
  },
  video: {
    border: 'hover:border-rose-300/25',
    focusRing: 'focus-visible:border-rose-300/40 focus-visible:ring-rose-300/35',
    iconWrap: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    badge: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    button: 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]',
    surface: 'from-rose-500/18 via-orange-400/[0.07] to-transparent',
    accentText: 'text-rose-300',
    indicator: 'bg-[var(--ui-accent-video)]',
    selected: 'border-[var(--ui-accent-video)]/50 bg-[var(--ui-accent-video)]/15 text-[var(--ui-text-primary)]',
    outline: 'border-[var(--ui-accent-video)]/20 focus-within:border-[var(--ui-accent-video)]/60',
    fieldFocus: 'focus:border-[var(--ui-accent-video)]/50',
    tile: 'border-[var(--ui-accent-video)]/35 bg-[var(--ui-accent-video)]/5 hover:border-[var(--ui-accent-video)]/60',
    tileActive: 'border-[var(--ui-accent-video)] bg-[var(--ui-accent-video)]/10',
    mark: 'text-[var(--ui-accent-video)]',
    control: 'accent-[var(--ui-accent-video)]',
  },
  motion: {
    border: 'hover:border-white/18',
    focusRing: 'focus-visible:border-[var(--ui-focus)] focus-visible:ring-[var(--ui-focus)]/35',
    iconWrap: 'border-[var(--ui-accent-motion)]/20 bg-[var(--ui-accent-motion)]/10 text-[var(--ui-accent-motion)]',
    badge: 'border-[var(--ui-accent-motion)]/20 bg-[var(--ui-accent-motion)]/10 text-[var(--ui-accent-motion)]',
    button: 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]',
    surface: 'from-white/[0.08] via-white/[0.03] to-transparent',
    accentText: 'text-[var(--ui-accent-motion)]',
    indicator: 'bg-[var(--ui-accent-motion)]',
    selected: 'border-[var(--ui-accent-motion)]/50 bg-[var(--ui-accent-motion)]/15 text-[var(--ui-text-primary)]',
    outline: 'border-[var(--ui-accent-motion)]/20 focus-within:border-[var(--ui-accent-motion)]/60',
    fieldFocus: 'focus:border-[var(--ui-accent-motion)]/50',
    tile: 'border-[var(--ui-accent-motion)]/35 bg-[var(--ui-accent-motion)]/5 hover:border-[var(--ui-accent-motion)]/60',
    tileActive: 'border-[var(--ui-accent-motion)] bg-[var(--ui-accent-motion)]/10',
    mark: 'text-[var(--ui-accent-motion)]',
    control: 'accent-[var(--ui-accent-motion)]',
  },
  workflow: {
    border: 'hover:border-emerald-300/25',
    focusRing: 'focus-visible:border-emerald-300/40 focus-visible:ring-emerald-300/35',
    iconWrap: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
    badge: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
    button: 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]',
    surface: 'from-emerald-500/20 via-teal-400/10 to-transparent',
    accentText: 'text-emerald-300',
    indicator: 'bg-brand-emerald',
    selected: 'border-brand-emerald/50 bg-brand-emerald/15 text-[var(--ui-text-primary)]',
    outline: 'border-brand-emerald/20 focus-within:border-brand-emerald/60',
    fieldFocus: 'focus:border-brand-emerald/50',
    tile: 'border-brand-emerald/35 bg-brand-emerald/5 hover:border-brand-emerald/60',
    tileActive: 'border-brand-emerald bg-brand-emerald/10',
    mark: 'text-brand-emerald',
    control: 'accent-brand-emerald',
  },
  commerce: {
    border: 'hover:border-amber-300/25',
    focusRing: 'focus-visible:border-amber-300/40 focus-visible:ring-amber-300/35',
    iconWrap: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
    badge: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
    button: 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]',
    surface: 'from-amber-500/20 via-orange-400/10 to-transparent',
    accentText: 'text-amber-300',
    indicator: 'bg-[var(--ui-accent-commerce)]',
    selected: 'border-[var(--ui-accent-commerce)]/50 bg-[var(--ui-accent-commerce)]/15 text-[var(--ui-text-primary)]',
    outline: 'border-[var(--ui-accent-commerce)]/20 focus-within:border-[var(--ui-accent-commerce)]/60',
    fieldFocus: 'focus:border-[var(--ui-accent-commerce)]/50',
    tile: 'border-[var(--ui-accent-commerce)]/35 bg-[var(--ui-accent-commerce)]/5 hover:border-[var(--ui-accent-commerce)]/60',
    tileActive: 'border-[var(--ui-accent-commerce)] bg-[var(--ui-accent-commerce)]/10',
    mark: 'text-[var(--ui-accent-commerce)]',
    control: 'accent-[var(--ui-accent-commerce)]',
  },
  danger: {
    border: 'hover:border-rose-300/25',
    focusRing: 'focus-visible:border-rose-300/40 focus-visible:ring-rose-300/35',
    iconWrap: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    badge: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
    button: 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]',
    surface: 'from-rose-500/20 via-red-400/10 to-transparent',
    accentText: 'text-rose-300',
    indicator: 'bg-brand-red',
    selected: 'border-brand-red/50 bg-brand-red/15 text-[var(--ui-text-primary)]',
    outline: 'border-brand-red/20 focus-within:border-brand-red/60',
    fieldFocus: 'focus:border-brand-red/50',
    tile: 'border-brand-red/35 bg-brand-red/5 hover:border-brand-red/60',
    tileActive: 'border-brand-red bg-brand-red/10',
    mark: 'text-brand-red',
    control: 'accent-brand-red',
  },
  neutral: {
    border: 'hover:border-white/18',
    focusRing: 'focus-visible:border-white/35 focus-visible:ring-white/25',
    iconWrap: 'border-white/10 bg-white/[0.04] text-zinc-100',
    badge: 'border-white/10 bg-white/[0.04] text-zinc-200',
    button: 'border-transparent bg-[var(--ui-primary)] text-[var(--ui-primary-on)] hover:bg-[var(--ui-primary-strong)]',
    surface: 'from-white/10 via-white/[0.04] to-transparent',
    accentText: 'text-zinc-200',
    indicator: 'bg-[var(--ui-text-secondary)]',
    selected: 'border-[var(--ui-border-strong)] bg-[var(--ui-surface-3)] text-[var(--ui-text-primary)]',
    outline: 'border-[var(--ui-border-subtle)] focus-within:border-[var(--ui-border-strong)]',
    fieldFocus: 'focus:border-[var(--ui-border-strong)]',
    tile: 'border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] hover:border-[var(--ui-border-strong)]',
    tileActive: 'border-[var(--ui-text-secondary)] bg-[var(--ui-surface-3)]',
    mark: 'text-[var(--ui-text-secondary)]',
    control: 'accent-[var(--ui-text-secondary)]',
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
  display: 'text-4xl font-extrabold leading-[1.08] tracking-[-0.035em] text-[var(--ui-text-primary)] sm:text-5xl lg:text-6xl',
  pageTitle: 'text-4xl font-extrabold leading-tight tracking-[-0.025em] text-[var(--ui-text-primary)] sm:text-5xl',
  sectionTitle: 'text-2xl font-bold leading-tight tracking-tight text-[var(--ui-text-primary)] sm:text-3xl',
  cardTitle: 'text-xl font-bold leading-7 tracking-tight text-[var(--ui-text-primary)]',
  body: 'text-base leading-6 text-[var(--ui-text-secondary)]',
  bodySm: 'text-sm leading-6 text-[var(--ui-text-muted)]',
  label: 'text-[13px] font-bold leading-[18px] text-[var(--ui-text-secondary)]',
  caption: 'text-xs font-semibold leading-[17px] text-[var(--ui-text-faint)]',
  metric: 'text-4xl font-extrabold leading-10 tracking-tight text-[var(--ui-text-primary)]',
  code: 'font-mono text-[13px] leading-5 text-[var(--ui-text-secondary)]',
};

export function Text({
  as = 'p',
  variant = 'body',
  id,
  className,
  children,
}: {
  as?: TextElement;
  variant?: TextVariant;
  /** For a heading or message that labels or describes something else (aria-labelledby, aria-describedby). */
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const Component = as;

  return <Component id={id} className={clsx(TEXT_VARIANTS[variant], className)}>{children}</Component>;
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
  role,
  ariaLive,
  className,
  children,
}: {
  as?: SurfaceElement;
  variant?: keyof typeof SURFACE_VARIANTS;
  padding?: keyof typeof SURFACE_PADDING;
  interactive?: boolean;
  role?: AriaRole;
  ariaLive?: 'off' | 'polite' | 'assertive';
  className?: string;
  children: ReactNode;
}) {
  const Component = as;

  return (
    <Component
      role={role}
      aria-live={ariaLive}
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
  id,
  ariaLabel,
  ariaExpanded,
  ariaControls,
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
  /** For a button something else hands the focus back to. */
  id?: string;
  ariaLabel?: string;
  /** A button that shows and hides a panel (a disclosure): whether it is open, and its id. */
  ariaExpanded?: boolean;
  ariaControls?: string;
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
      <Link id={id} href={href} prefetch={prefetch} aria-label={ariaLabel} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <button
      id={id}
      type={type}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
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
  actionPrefetch,
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
  actionPrefetch?: boolean;
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
        <Button
          href={actionHref}
          prefetch={actionPrefetch}
          variant="secondary"
          icon={ActionIcon}
          className="shrink-0"
        >
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
  action,
  className,
}: {
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  title: string;
  body?: string;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  /** The next step, a button or a link, at the callout's end; under the words when they need the width. */
  action?: ReactNode;
  className?: string;
}) {
  const toneClass = {
    neutral: 'text-[var(--ui-text-secondary)]',
    info: 'text-[var(--ui-accent-image)]',
    success: 'text-[var(--ui-accent-workflow)]',
    warning: 'text-[var(--ui-accent-commerce)]',
    danger: 'text-[var(--ui-accent-danger)]',
  }[tone];

  return (
    <Surface
      variant="soft"
      padding="md"
      role={tone === 'danger' ? 'alert' : 'status'}
      ariaLive={tone === 'danger' ? 'assertive' : 'polite'}
      className={clsx('flex gap-3', action && 'flex-wrap items-center', className)}
    >
      {Icon ? <Icon className={clsx('mt-0.5 h-5 w-5 shrink-0', toneClass, action && 'self-start')} aria-hidden /> : null}
      <div className={clsx(action && 'min-w-48 flex-1')}>
        <Text as="h3" variant="cardTitle" className={clsx('text-base leading-6', toneClass)}>
          {title}
        </Text>
        {body ? <Text variant="bodySm" className="mt-1">{body}</Text> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </Surface>
  );
}
