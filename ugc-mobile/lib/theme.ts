export const appTheme = {
  colors: {
    app: '#050506',
    background: '#09090b',
    page: '#09090b',
    panel: '#111215',
    panelSoft: '#17181d',
    surface: 'rgba(255,255,255,0.04)',
    surfaceStrong: 'rgba(255,255,255,0.06)',
    surfaceInset: 'rgba(0,0,0,0.32)',
    borderSubtle: 'rgba(255,255,255,0.08)',
    border: 'rgba(255,255,255,0.10)',
    borderStrong: 'rgba(255,255,255,0.18)',
    text: '#fafafa',
    textSecondary: '#d4d4d8',
    muted: '#a1a1aa',
    faint: '#71717a',
    danger: '#fb7185',
    success: '#34d399',
    image: '#38bdf8',
    video: '#fb7185',
    motion: '#a78bfa',
    workflow: '#34d399',
    amber: '#f59e0b',
    commerce: '#f59e0b',
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
      fontSize: 34,
      lineHeight: 40,
      fontWeight: '800',
    },
    pageTitle: {
      fontSize: 30,
      lineHeight: 36,
      fontWeight: '800',
    },
    sectionTitle: {
      fontSize: 22,
      lineHeight: 28,
      fontWeight: '800',
    },
    cardTitle: {
      fontSize: 18,
      lineHeight: 24,
      fontWeight: '800',
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
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '700',
    },
    caption: {
      fontSize: 11,
      lineHeight: 15,
      fontWeight: '600',
    },
    button: {
      fontSize: 15,
      lineHeight: 20,
      fontWeight: '800',
    },
    metric: {
      fontSize: 34,
      lineHeight: 38,
      fontWeight: '800',
    },
  },
  icon: {
    compact: 18,
    default: 20,
    feature: 24,
  },
  touch: {
    compact: 44,
    default: 48,
  },
  opacity: {
    pressed: 0.82,
    disabled: 0.55,
  },
  shadow: {
    panel: {
      shadowColor: '#000000',
      shadowOpacity: 0.28,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 12 },
      elevation: 6,
    },
  },
} as const;

export type ToolAccent = 'image' | 'video' | 'motion' | 'workflow' | 'amber' | 'commerce' | 'danger';

export function accentColor(accent: ToolAccent) {
  return appTheme.colors[accent];
}
