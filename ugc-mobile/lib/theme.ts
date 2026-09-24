/**
 * The two palettes. Every colour the interface draws comes from one of them,
 * read through `useAppTheme()` (lib/theme-context.tsx) so a component follows
 * the scheme the app resolved: the phone's own setting, or the choice made
 * under Settings → Appearance (lib/appearance.ts).
 *
 * Both palettes carry exactly the same keys, and every solid colour stays a
 * six-digit hex: call sites build tints by suffixing an alpha byte
 * (`${colors.primary}22`, `hexWithAlpha`) and `relativeLuminance` only reads
 * `#rrggbb`. `theme-palette-parity.test.ts` holds both rules.
 */
export type ColorScheme = 'light' | 'dark';

const darkColors = {
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
  // The opposite of the page: the ivory pill that carries ink text here, the
  // ink pill that carries ivory text in the light palette.
  surfaceInverse: '#fff8ed',
  overlay: 'rgba(4,4,6,0.74)',
  overlayStrong: 'rgba(4,4,6,0.92)',
  // The scrim behind a bottom sheet (`SheetBackdrop`).
  scrim: 'rgba(0,0,0,0.58)',
  // Loading placeholders (`SkeletonBone`): a quiet tint of the foreground.
  bone: 'rgba(255,248,237,0.07)',
  boneStrong: 'rgba(255,248,237,0.11)',
  // A switch at rest: its track and thumb. On, it takes `primaryFill` and `onPrimary`.
  switchTrackOff: '#343838',
  switchThumbOff: '#cac6bd',
  // The ground a picture or video loads onto, before its first frame paints.
  mediaPlaceholder: '#050506',
  borderSubtle: 'rgba(255,248,237,0.07)',
  border: 'rgba(255,248,237,0.12)',
  borderStrong: 'rgba(255,248,237,0.22)',

  // Warm ivory type keeps the dark UI from feeling cold without lowering contrast.
  text: '#fff8ed',
  textInverse: '#1a0d08',
  textSecondary: '#ddd6cc',
  muted: '#aaa39b',
  faint: '#8d8780',

  // Signal coral is the single brand action color. `primary` is coral as a
  // foreground — text, icons, borders — and `primaryFill` is coral as a
  // surface, always paired with `onPrimary`. On black the two are the same
  // colour; on a light page no single coral can be both, because the bright
  // one is legible only as a fill (2.4:1 as text) and the deep one reads as
  // rust when it fills a button.
  primary: '#ff7a59',
  primaryFill: '#ff7a59',
  // A coral fill under the finger: a step lighter, never darker, so the ink on
  // it keeps its contrast in both schemes.
  primaryFillPressed: '#ff8a6d',
  onPrimary: '#1a0d08',
  primaryStrong: '#ff8a6d',
  focus: '#ffaa94',
  selected: '#2a1b1a',
  selectedStrong: '#3a2220',
  navigationSelected: '#303033',
  navigationIconFill: '#804331',
  // The raised create control reads as a lit object: warm at the top where the
  // light lands, deeper at the bottom. Flat fill made it a sticker.
  navigationCreateTop: '#FFA463',
  navigationCreateBottom: '#F4552A',
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

export type ThemeColorName = keyof typeof darkColors;
export type ThemeColors = { readonly [Name in ThemeColorName]: string };

/**
 * Warm paper: the light twin of the ivory-on-black palette rather than a grey
 * system default. A warm off-white ground, warm ink type, and panels that step
 * *down* from the page by fill and hairline — never by shadow, because a
 * shadow on scrolled content costs iOS an offscreen pass every frame.
 *
 * Every foreground clears 4.5:1 on `background`, `panel`, `panelSoft` and
 * white (`hig-type-and-contrast.test.ts` runs the same sweep over both
 * palettes). The dark palette's pastels could not: they were picked to glow on
 * black, and coral measures 2.4:1 on this page — hence the deep coral for text
 * and the bright one kept for fills.
 */
const lightColors: ThemeColors = {
  app: '#fdfbf8',
  background: '#fbf8f4',
  page: '#fbf8f4',
  panel: '#f2ede6',
  panelSoft: '#ece6de',
  surface: 'rgba(28,20,15,0.04)',
  surfaceStrong: 'rgba(28,20,15,0.07)',
  // Inputs and wells read as paper on the tinted panels.
  surfaceInset: '#ffffff',
  surfaceInverse: '#1c140f',
  // Sheets dim a light page less than a dark one: the same weight of scrim
  // reads twice as heavy over white.
  overlay: 'rgba(20,14,10,0.40)',
  overlayStrong: 'rgba(20,14,10,0.62)',
  scrim: 'rgba(20,14,10,0.32)',
  bone: 'rgba(28,20,15,0.06)',
  boneStrong: 'rgba(28,20,15,0.09)',
  switchTrackOff: '#ddd6cc',
  switchThumbOff: '#ffffff',
  mediaPlaceholder: '#ece6de',
  borderSubtle: 'rgba(28,20,15,0.07)',
  border: 'rgba(28,20,15,0.12)',
  borderStrong: 'rgba(28,20,15,0.22)',

  text: '#1c140f',
  textInverse: '#fff8ed',
  textSecondary: '#3f3731',
  muted: '#5f5750',
  faint: '#675e56',

  primary: '#a83d1c',
  primaryFill: '#ff7a59',
  primaryFillPressed: '#ff8a6d',
  onPrimary: '#1a0d08',
  primaryStrong: '#8f3216',
  focus: '#d4572f',
  selected: '#fbe3da',
  selectedStrong: '#f6d2c4',
  navigationSelected: '#ebe4da',
  navigationIconFill: '#ffc9b5',
  navigationCreateTop: '#FFA463',
  navigationCreateBottom: '#F4552A',
  pressed: 'rgba(168,61,28,0.10)',

  info: '#1a5f96',
  danger: '#b4233c',
  success: '#136c48',
  warning: '#8a5a00',

  // Apple's light-appearance system red, still with white.
  badge: '#ff3b30',
  onBadge: '#ffffff',

  image: '#1a5f96',
  video: '#a3401e',
  motion: '#6a4bc4',
  workflow: '#136c48',
  amber: '#8a5a00',
  commerce: '#8a5a00',
};

/**
 * Colours drawn over a picture: captions, icons and scrims on a photo or a
 * video frame, and the reel's own ground. They are the same in both schemes on
 * purpose — the picture decides what sits on it, not the phone's appearance —
 * so they live outside the palettes and can be read anywhere, including from
 * module scope.
 */
export const mediaColors = {
  onMedia: '#ffffff',
  onMediaSecondary: 'rgba(255,255,255,0.66)',
  mediaScrim: 'rgba(0,0,0,0.38)',
  mediaScrimStrong: 'rgba(0,0,0,0.70)',
  mediaGround: '#000000',
  // A small glass chip sitting on a picture: a creator, a state glyph.
  mediaChip: 'rgba(3,4,13,0.62)',
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

const darkSemantic = {
  neutral: {
    foreground: darkColors.textSecondary,
    background: 'rgba(221,214,204,0.07)',
    border: 'rgba(221,214,204,0.18)',
  },
  info: {
    foreground: darkColors.info,
    background: 'rgba(115,191,242,0.10)',
    border: 'rgba(115,191,242,0.32)',
  },
  success: {
    foreground: darkColors.success,
    background: 'rgba(103,214,167,0.10)',
    border: 'rgba(103,214,167,0.32)',
  },
  warning: {
    foreground: darkColors.warning,
    background: 'rgba(242,185,94,0.10)',
    border: 'rgba(242,185,94,0.34)',
  },
  danger: {
    foreground: darkColors.danger,
    background: 'rgba(255,124,139,0.10)',
    border: 'rgba(255,124,139,0.34)',
  },
};

type SemanticTone = { foreground: string; background: string; border: string };
type SemanticTones = Record<keyof typeof darkSemantic, SemanticTone>;

// The same recipe on paper: the deep foreground at a lighter wash, because a
// 10% tint of a dark colour on white reads heavier than on black.
const lightSemantic: SemanticTones = {
  neutral: {
    foreground: lightColors.textSecondary,
    background: 'rgba(63,55,49,0.06)',
    border: 'rgba(63,55,49,0.16)',
  },
  info: {
    foreground: lightColors.info,
    background: 'rgba(26,95,150,0.08)',
    border: 'rgba(26,95,150,0.26)',
  },
  success: {
    foreground: lightColors.success,
    background: 'rgba(19,108,72,0.08)',
    border: 'rgba(19,108,72,0.26)',
  },
  warning: {
    foreground: lightColors.warning,
    background: 'rgba(138,90,0,0.08)',
    border: 'rgba(138,90,0,0.28)',
  },
  danger: {
    foreground: lightColors.danger,
    background: 'rgba(180,35,60,0.07)',
    border: 'rgba(180,35,60,0.26)',
  },
};

function buildState(colors: ThemeColors) {
  return {
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
  } as const;
}

type BoxShadowToken = { boxShadow: string };
type ShadowTokens = Record<'navigation' | 'navigationCreate' | 'panel' | 'soft' | 'focus' | 'drawer' | 'sheet' | 'floating' | 'dock', BoxShadowToken>;

const darkShadow: ShadowTokens = {
  navigation: {
    boxShadow: '0 6px 16px rgba(0,0,0,0.24)',
  },
  // Coloured rather than neutral: the control should look like it is casting
  // its own light onto the dock, not merely sitting above it.
  navigationCreate: {
    boxShadow: '0 8px 22px rgba(244,85,42,0.45)',
  },
  panel: {
    boxShadow: '0 14px 34px rgba(0,0,0,0.30)',
  },
  soft: {
    boxShadow: '0 10px 24px rgba(0,0,0,0.20)',
  },
  focus: {
    boxShadow: '0 0 0 3px rgba(255,170,148,0.28)',
  },
  // A panel travelling in from an edge: the side drawer, the create sheet.
  drawer: {
    boxShadow: '16px 0 40px rgba(0,0,0,0.34)',
  },
  sheet: {
    boxShadow: '0 -16px 42px rgba(0,0,0,0.34)',
  },
  // A dock floating over a scrolling screen (the creator's action bar).
  floating: {
    boxShadow: '0 16px 46px rgba(0,0,0,0.42)',
  },
  // A bar pinned to the bottom edge, lifting off the content above it.
  dock: {
    boxShadow: '0 -12px 30px rgba(0,0,0,0.30)',
  },
};

// Same shapes, so a surface keeps exactly the layers it has on black (no new
// offscreen work), in ink at a third of the weight: a black-strength shadow on
// paper reads as a smudge.
const lightShadow: ShadowTokens = {
  navigation: {
    boxShadow: '0 6px 16px rgba(28,20,15,0.10)',
  },
  navigationCreate: {
    boxShadow: '0 8px 22px rgba(244,85,42,0.30)',
  },
  panel: {
    boxShadow: '0 14px 34px rgba(28,20,15,0.07)',
  },
  soft: {
    boxShadow: '0 10px 24px rgba(28,20,15,0.06)',
  },
  focus: {
    boxShadow: '0 0 0 3px rgba(212,87,47,0.24)',
  },
  drawer: {
    boxShadow: '16px 0 40px rgba(28,20,15,0.12)',
  },
  sheet: {
    boxShadow: '0 -16px 42px rgba(28,20,15,0.12)',
  },
  floating: {
    boxShadow: '0 16px 46px rgba(28,20,15,0.14)',
  },
  dock: {
    boxShadow: '0 -12px 30px rgba(28,20,15,0.10)',
  },
};

/**
 * How a scrim that animates its own opacity dims the screen: its colour, and
 * a scale for whatever peak opacity the surface animates to. Over paper the
 * same weight of black reads twice as heavy, so the light scheme dims with
 * warm ink at a little over half the strength.
 */
type DimTokens = { color: string; scale: number };
const darkDim: DimTokens = { color: '#000000', scale: 1 };
const lightDim: DimTokens = { color: '#140e0a', scale: 0.55 };

/**
 * The floating tab bar's own materials (`components/magic-tab-bar.tsx`), each
 * tuned by eye against real media. Dark: a smoked glass tint with bright
 * labels. Light: a frosted paper tint strong enough that ink labels hold over
 * a dark frame scrolling beneath — Liquid Glass adapts on brightness, so the
 * tint has to keep the surface on the light side itself.
 */
type TabBarTokens = {
  glassTint: string;
  glassBorder: string;
  glassFrostLift: string;
  glassInactive: string;
  adaptiveShade: readonly [string, string];
  discRim: string;
  discShadowColor: string;
  discShadowOpacity: number;
  solidFill: string;
  surfaceShadow: string;
  dockSheen: readonly [string, string];
  createGlyph: string;
};

const darkTabBar: TabBarTokens = {
  glassTint: 'rgba(17,18,21,0.20)',
  glassBorder: 'rgba(255,255,255,0.16)',
  glassFrostLift: 'rgba(236,240,255,0.07)',
  glassInactive: 'rgba(255,255,255,0.88)',
  adaptiveShade: ['rgba(255,255,255,0.05)', 'rgba(0,0,0,0.16)'],
  discRim: 'rgba(255,255,255,0.18)',
  discShadowColor: '#000000',
  discShadowOpacity: 0.24,
  solidFill: '#111215',
  surfaceShadow: '0 8px 24px rgba(0,0,0,0.24)',
  dockSheen: ['rgba(255,255,255,0.025)', 'rgba(0,0,0,0.08)'],
  createGlyph: '#ffffff',
};

const lightTabBar: TabBarTokens = {
  glassTint: 'rgba(253,251,248,0.55)',
  glassBorder: 'rgba(28,20,15,0.10)',
  glassFrostLift: 'rgba(255,255,255,0.12)',
  glassInactive: 'rgba(28,20,15,0.78)',
  adaptiveShade: ['rgba(255,255,255,0.35)', 'rgba(28,20,15,0.05)'],
  discRim: 'rgba(255,255,255,0.60)',
  discShadowColor: '#1c140f',
  discShadowOpacity: 0.16,
  solidFill: '#fdfbf8',
  surfaceShadow: '0 8px 24px rgba(28,20,15,0.12)',
  dockSheen: ['rgba(255,255,255,0.50)', 'rgba(28,20,15,0.03)'],
  createGlyph: '#ffffff',
};

/**
 * Tokens that are the same in both schemes. Read them straight from
 * `appTheme`, anywhere — module scope included.
 */
const staticTokens = {
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
      navigation: 140,
      navigationSwell: 90,
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
      navigationSwellX: 1.012,
      navigationSwellY: 1.055,
      // Volume-conserving: the capsule gains along its travel and gives back
      // across it, so the lean reads as weight rather than as growth.
      navigationTravelX: 1.16,
      navigationTravelY: 0.9,
      navigationCapsule: 1.045,
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
      navigationSettle: { stiffness: 380, damping: 23, mass: 0.8 },
    },
  },
} as const;

function buildTheme(
  scheme: ColorScheme,
  colors: ThemeColors,
  semantic: SemanticTones,
  shadow: ShadowTokens,
  dim: DimTokens,
  tabBar: TabBarTokens,
) {
  return {
    ...staticTokens,
    scheme,
    colors,
    semantic,
    state: buildState(colors),
    shadow,
    dim,
    tabBar,
  };
}

export type AppTheme = ReturnType<typeof buildTheme>;

/**
 * Both themes, built once. A theme object only changes identity when the
 * scheme does, so React Compiler re-memoises a component's styles exactly once
 * per switch and never in between.
 */
export const themes: Readonly<Record<ColorScheme, AppTheme>> = {
  dark: buildTheme('dark', darkColors, darkSemantic, darkShadow, darkDim, darkTabBar),
  light: buildTheme('light', lightColors, lightSemantic, lightShadow, lightDim, lightTabBar),
};

/**
 * The tokens that are the same in both schemes: spacing, radii, type, icon
 * sizes, touch targets, opacity and motion. Read them from anywhere, module
 * scope included. Colours are deliberately absent — they come from
 * `useAppTheme()`, because a colour read from a module constant never redraws
 * when the scheme changes.
 */
export const appTheme = staticTokens;

export type ToolAccent = 'primary' | 'image' | 'video' | 'motion' | 'workflow' | 'amber' | 'commerce' | 'danger';

export function accentColor(accent: ToolAccent, colors: ThemeColors = darkColors) {
  return colors[accent];
}

export function onAccentColor(_accent: ToolAccent, colors: ThemeColors = darkColors) {
  return colors.onPrimary;
}

/**
 * An accent as a *fill* — a solid button, a thumb, a filled badge. Fills stay
 * bright in both schemes and always carry dark ink (`onAccentFill`): the light
 * palette's accents are deep so they read as text on paper, but a deep fill
 * under ink measures under 3:1. The bright set is the dark palette's, which is
 * what every fill in the app already drew.
 */
export function accentFill(accent: ToolAccent) {
  return darkColors[accent === 'primary' ? 'primaryFill' : accent];
}

export function onAccentFill(_accent: ToolAccent) {
  return darkColors.onPrimary;
}
