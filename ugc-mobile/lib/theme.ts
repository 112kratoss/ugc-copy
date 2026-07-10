const colors = {
  // Obsidian Studio: neutral graphite layers with a warm, readable foreground.
  app: '#0c0c0e',
  background: '#101012',
  page: '#101012',
  panel: '#19191c',
  panelSoft: '#202024',
  surface: 'rgba(255,248,237,0.05)',
  surfaceStrong: 'rgba(255,248,237,0.08)',
  surfaceInset: '#0d0d0f',
  overlay: 'rgba(8,8,10,0.72)',
  overlayStrong: 'rgba(8,8,10,0.90)',
  borderSubtle: 'rgba(255,248,237,0.09)',
  border: 'rgba(255,248,237,0.14)',
  borderStrong: 'rgba(255,248,237,0.24)',

  // Warm ivory type keeps the dark UI from feeling cold without lowering contrast.
  text: '#fff8ed',
  textInverse: '#1a0d08',
  textSecondary: '#ddd6cc',
  muted: '#aaa39b',
  faint: '#8d8780',

  // Signal coral is the single brand action color. It is always used as a solid fill.
  primary: '#ff7a59',
  onPrimary: '#1a0d08',
  primaryStrong: '#ff8a6d',
  focus: '#ffaa94',
  selected: '#2a1b1a',
  selectedStrong: '#3a2220',
  pressed: 'rgba(255,122,89,0.13)',

  // Semantic colors are deliberately distinct from the brand action.
  info: '#73bff2',
  danger: '#ff7c8b',
  success: '#67d6a7',
  warning: '#f2b95e',

  // Tool accents remain available for categorisation, previews, and lightweight emphasis.
  image: '#73bff2',
  video: '#ff8e72',
  motion: '#b7a0f5',
  workflow: '#67d6a7',
  amber: '#f2b95e',
  commerce: '#f2b95e',
} as const;

export const appTheme = {
  colors,
  semantic: {
    neutral: {
      foreground: colors.textSecondary,
      background: 'rgba(221,214,204,0.07)',
      border: 'rgba(221,214,204,0.18)',
    },
    info: {
      foreground: colors.info,
      background: 'rgba(115,191,242,0.10)',
      border: 'rgba(115,191,242,0.32)',
    },
    success: {
      foreground: colors.success,
      background: 'rgba(103,214,167,0.10)',
      border: 'rgba(103,214,167,0.32)',
    },
    warning: {
      foreground: colors.warning,
      background: 'rgba(242,185,94,0.10)',
      border: 'rgba(242,185,94,0.34)',
    },
    danger: {
      foreground: colors.danger,
      background: 'rgba(255,124,139,0.10)',
      border: 'rgba(255,124,139,0.34)',
    },
  },
  state: {
    focus: {
      color: colors.focus,
      width: 2,
    },
    selected: {
      background: colors.selected,
      backgroundStrong: colors.selectedStrong,
      border: colors.primaryStrong,
    },
    pressed: {
      background: colors.pressed,
      scale: 0.985,
    },
    disabled: {
      opacity: 0.5,
    },
  },
  radii: {
    xs: 8,
    sm: 12,
    md: 16,
    lg: 20,
    xl: 24,
    pill: 999,
  },
  spacing: {
    unit: 4,
    compact: 8,
    gap: 12,
    screen: 16,
    card: 16,
    panel: 20,
    section: 32,
    page: 48,
  },
  type: {
    display: {
      fontSize: 36,
      lineHeight: 42,
      fontWeight: '800',
      letterSpacing: -0.8,
    },
    pageTitle: {
      fontSize: 30,
      lineHeight: 36,
      fontWeight: '800',
      letterSpacing: -0.45,
    },
    sectionTitle: {
      fontSize: 22,
      lineHeight: 28,
      fontWeight: '700',
      letterSpacing: -0.2,
    },
    cardTitle: {
      fontSize: 18,
      lineHeight: 24,
      fontWeight: '700',
    },
    body: {
      fontSize: 16,
      lineHeight: 24,
      fontWeight: '400',
    },
    bodySm: {
      fontSize: 14,
      lineHeight: 21,
      fontWeight: '400',
    },
    label: {
      fontSize: 13,
      lineHeight: 18,
      fontWeight: '700',
    },
    caption: {
      fontSize: 12,
      lineHeight: 17,
      fontWeight: '600',
    },
    button: {
      fontSize: 15,
      lineHeight: 20,
      fontWeight: '700',
      letterSpacing: 0.1,
    },
    metric: {
      fontSize: 34,
      lineHeight: 40,
      fontWeight: '800',
      letterSpacing: -0.5,
    },
  },
  icon: {
    compact: 18,
    default: 20,
    feature: 24,
  },
  touch: {
    compact: 48,
    default: 48,
    roomy: 56,
  },
  opacity: {
    pressed: 0.88,
    disabled: 0.5,
  },
  motion: {
    duration: {
      instant: 0,
      pressIn: 90,
      pressOut: 150,
      state: 180,
      reveal: 240,
    },
    scale: {
      pressed: 0.985,
    },
  },
  shadow: {
    panel: {
      boxShadow: '0 14px 34px rgba(0,0,0,0.30)',
    },
    soft: {
      boxShadow: '0 10px 24px rgba(0,0,0,0.20)',
    },
    focus: {
      boxShadow: '0 0 0 3px rgba(255,170,148,0.28)',
    },
  },
} as const;

export type ToolAccent = 'primary' | 'image' | 'video' | 'motion' | 'workflow' | 'amber' | 'commerce' | 'danger';

export function accentColor(accent: ToolAccent) {
  return appTheme.colors[accent];
}

export function onAccentColor(_accent: ToolAccent) {
  return appTheme.colors.onPrimary;
}
