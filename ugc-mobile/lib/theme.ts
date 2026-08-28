const colors = {
  // Obsidian Studio, deepened: the ground is true black so media supplies the
  // colour, and panels sit a real step above it instead of a 3% lift that
  // read as one flat grey. Warm ivory foreground, as before.
  app: '#000000',
  background: '#070708',
  page: '#070708',
  panel: '#151518',
  panelSoft: '#1f1f24',
  surface: 'rgba(255,248,237,0.06)',
  surfaceStrong: 'rgba(255,248,237,0.10)',
  surfaceInset: '#0b0b0d',
  overlay: 'rgba(4,4,6,0.74)',
  overlayStrong: 'rgba(4,4,6,0.92)',
  borderSubtle: 'rgba(255,248,237,0.07)',
  border: 'rgba(255,248,237,0.12)',
  borderStrong: 'rgba(255,248,237,0.22)',

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

  /**
   * The one colour in the palette the platform chooses, not the brand.
   * Tab bars: "a badge — a red oval containing white text". A badge only reads
   * as a badge in the system's red; drawing it in the brand coral would also
   * make it vanish against the active tab, which is already coral. Softer
   * `danger` (#ff7c8b) is the app's own error tone and is too pale to carry
   * white — this is Apple's badge red with the white it is specified with.
   */
  badge: '#ff3b30',
  onBadge: '#ffffff',

  // Tool accents remain available for categorisation, previews, and lightweight emphasis.
  image: '#73bff2',
  video: '#ff8e72',
  motion: '#b7a0f5',
  workflow: '#67d6a7',
  amber: '#f2b95e',
  commerce: '#f2b95e',
} as const;

// Display face: Bricolage Grotesque carries titles and the wordmark; body text
// stays on the system font for legibility and zero load cost. One token, so
// the face can be swapped in one line. The faces are registered under these
// exact names by expo-font, and each is a single weight — so the title
// variants below set `fontWeight: '400'` to stop Android fake-bolding a face
// that is already bold.
export const DISPLAY_FONT = {
  bold: 'BricolageGrotesque_700Bold',
  extraBold: 'BricolageGrotesque_800ExtraBold',
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
      scale: 0.96,
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
      fontFamily: DISPLAY_FONT.extraBold,
      fontSize: 36,
      lineHeight: 42,
      fontWeight: '400',
      letterSpacing: -0.6,
    },
    pageTitle: {
      fontFamily: DISPLAY_FONT.extraBold,
      fontSize: 30,
      lineHeight: 36,
      fontWeight: '400',
      letterSpacing: -0.3,
    },
    sectionTitle: {
      fontFamily: DISPLAY_FONT.extraBold,
      fontSize: 22,
      lineHeight: 28,
      fontWeight: '400',
      letterSpacing: -0.1,
    },
    cardTitle: {
      fontFamily: DISPLAY_FONT.bold,
      fontSize: 18,
      lineHeight: 24,
      fontWeight: '400',
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
      fontFamily: DISPLAY_FONT.extraBold,
      fontSize: 34,
      lineHeight: 40,
      fontWeight: '400',
      letterSpacing: -0.3,
    },
  },
  /**
   * Dynamic Type policy (F1): text always follows the OS setting — opting out
   * fails Typography ("all text styles scale") — but each tier caps how far it
   * follows, the chapter's own hierarchy rule ("not all content scales
   * equally — secondary items may remain smaller"). Titles keep hierarchy at
   * 1.35×, controls and metadata stay tappable and quiet at 1.6×, running
   * text follows furthest at 2×. `hig-dynamic-type.test.tsx` pins the caps
   * and the no-opt-out rule.
   */
  typeScale: {
    title: 1.35,
    control: 1.6,
    body: 2,
  },
  icon: {
    /**
     * The icon size ramp, stepped to sit beside the type ramp above: 14 next to
     * `caption`, 16 next to `label`/`bodySm`, 18 next to `body`, 20 for a
     * standalone control, 24 next to `sectionTitle`, 32 for hero and empty
     * states. HIG Icons asks for a consistent size across the set; a screen
     * that needs a size not on this ramp is choosing a new one, and
     * `hig-icon-size.test.ts` will say so.
     */
    xs: 14,
    sm: 16,
    compact: 18,
    default: 20,
    feature: 24,
    hero: 32,
    /**
     * HIG Icons: "all interface icons in your app need to use a consistent
     * size, level of detail, stroke thickness (or weight), and perspective."
     * One weight for the whole set, supplied once by the LucideProvider in the
     * root layout — call sites pass a size, never a stroke. 2.2 is the weight
     * the shipped primitives (IconButton, Pill) already chose; it reads as a
     * medium next to the label and caption weights icons usually sit beside.
     */
    stroke: 2.2,
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
      state: 180,
      // What `Reveal` actually ships. The token said 240 while the only
      // component that reveals anything ran 360, and since nothing consumed
      // the token the divergence was invisible — so reality wins over the
      // number nobody used.
      reveal: 360,
    },
    // `instant`/`pressIn`/`pressOut` used to live here and were referenced
    // nowhere. Press feedback is spring-driven (see `spring.pressIn` /
    // `spring.release`), so duration tokens for it described a system this app
    // does not have.
    scale: {
      // Press feedback has to clear the perception floor: a 1–2% change reads
      // as nothing under a thumb. Cards travel less than controls because
      // their absolute movement is already large; controls (icon buttons,
      // tabs, the create button) travel most because they are small.
      pressed: 0.96,
      pressedCard: 0.975,
      pressedControl: 0.9,
      selected: 1.12,
    },
    // Springs rather than eased curves: the settle is the point. Friction is
    // high enough that the overshoot reads as responsiveness, not a glitch.
    spring: {
      tension: 190,
      friction: 13,
      // Press-in is close to critically damped so the surface lands under the
      // finger at once; release is underdamped so it settles back with a small
      // visible rebound, which is what makes a tap feel physical.
      pressIn: { stiffness: 700, damping: 40, mass: 0.7 },
      release: { stiffness: 420, damping: 17, mass: 0.7 },
      // Large surfaces that travel their own width — drawers and sheets.
      // `release` is far too loose here: at a damping ratio near 0.5 it
      // overshoots roughly a sixth of the step, which on a 360pt drawer throws
      // the panel ~57pt past its resting edge and opens a visible gap against
      // the screen. This sits at ~0.88, so the settle is still felt but the
      // overshoot lands under a pixel.
      panel: { stiffness: 520, damping: 38, mass: 0.9 },
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
