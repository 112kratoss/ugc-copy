export const appTheme = {
  colors: {
    background: '#09090b',
    panel: '#111215',
    panelSoft: '#17181d',
    border: 'rgba(255,255,255,0.1)',
    borderStrong: 'rgba(255,255,255,0.18)',
    text: '#fafafa',
    muted: '#a1a1aa',
    faint: '#71717a',
    danger: '#fb7185',
    success: '#34d399',
    image: '#38bdf8',
    video: '#fb7185',
    motion: '#a78bfa',
    workflow: '#34d399',
    amber: '#f59e0b',
  },
  radii: {
    sm: 10,
    md: 16,
    lg: 24,
    pill: 999,
  },
  spacing: {
    screen: 18,
    section: 18,
    gap: 12,
  },
} as const;

export type ToolAccent = 'image' | 'video' | 'motion' | 'workflow' | 'amber';

export function accentColor(accent: ToolAccent) {
  return appTheme.colors[accent];
}
