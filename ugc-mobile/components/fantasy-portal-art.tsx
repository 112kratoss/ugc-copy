import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient as SvgLinearGradient,
  Path,
  Polygon,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

export function FantasyPortalArt({
  variant = 'portal',
  muted = false,
}: {
  variant?: 'portal' | 'kingdom' | 'city' | 'runner' | 'tree';
  muted?: boolean;
}) {
  const accent = variant === 'city' ? '#2f6bff' : variant === 'tree' ? '#ec4ed8' : variant === 'runner' ? '#6d4dff' : '#d83dff';
  const secondary = variant === 'kingdom' ? '#67e8f9' : variant === 'city' ? '#ff35d3' : variant === 'runner' ? '#22d3ee' : '#fbbf24';
  const opacity = muted ? 0.68 : 1;

  return (
    <Svg width="100%" height="100%" viewBox="0 0 420 280" preserveAspectRatio="xMidYMid slice">
      <Defs>
        <SvgLinearGradient id={`sky-${variant}`} x1="0" x2="1" y1="0" y2="1">
          <Stop offset="0" stopColor="#070816" />
          <Stop offset="0.42" stopColor="#24105b" />
          <Stop offset="1" stopColor="#070611" />
        </SvgLinearGradient>
        <RadialGradient id={`glow-${variant}`} cx="66%" cy="34%" rx="42%" ry="52%">
          <Stop offset="0" stopColor={accent} stopOpacity="0.95" />
          <Stop offset="0.45" stopColor={secondary} stopOpacity="0.38" />
          <Stop offset="1" stopColor="#02030a" stopOpacity="0" />
        </RadialGradient>
        <SvgLinearGradient id={`ground-${variant}`} x1="0" x2="1" y1="0" y2="0">
          <Stop offset="0" stopColor="#071024" />
          <Stop offset="0.5" stopColor="#24105b" />
          <Stop offset="1" stopColor="#050713" />
        </SvgLinearGradient>
      </Defs>
      <Rect width="420" height="280" fill={`url(#sky-${variant})`} opacity={opacity} />
      <Rect width="420" height="280" fill={`url(#glow-${variant})`} />
      <Circle cx="304" cy="83" r="74" fill="none" stroke={accent} strokeWidth="8" opacity="0.72" />
      <Circle cx="304" cy="83" r="56" fill="none" stroke="#f8c7ff" strokeWidth="2" opacity="0.7" />
      <Path d="M264 154 C282 116 286 69 304 30 C328 75 338 118 356 154 Z" fill="#160a3d" opacity="0.9" />
      <Path d="M276 154 L334 154 L350 226 L250 226 Z" fill="#0b0a1d" opacity="0.82" />
      <Path d="M78 198 C118 152 154 120 206 150 C246 172 278 168 324 142 L420 178 L420 280 L0 280 L0 230 Z" fill="#060814" opacity="0.92" />
      <Path d="M0 214 C64 190 100 182 150 202 C208 224 272 208 420 184 L420 280 L0 280 Z" fill={`url(#ground-${variant})`} opacity="0.78" />
      <G opacity="0.88">
        <Polygon points="48,202 78,112 112,202" fill="#090b1a" />
        <Polygon points="92,204 134,82 180,204" fill="#0b0d22" />
        <Polygon points="150,205 198,108 246,205" fill="#070b1b" />
      </G>
      <Path d="M205 226 C228 203 251 188 286 184 C252 196 230 214 212 242 Z" fill={secondary} opacity="0.23" />
      <Path d="M178 238 C214 216 254 202 314 198" fill="none" stroke={accent} strokeWidth="3" opacity="0.46" />
      <Path d="M205 64 C222 50 235 45 256 48 C230 62 224 78 222 105 C212 92 207 80 205 64 Z" fill="#060713" opacity="0.86" />
      <Path d="M56 92 C70 78 82 74 100 78 C80 88 74 102 72 124 C63 114 58 104 56 92 Z" fill="#070817" opacity="0.86" />
      <G opacity="0.9">
        <Circle cx="70" cy="42" r="2.1" fill="#f8c7ff" />
        <Circle cx="128" cy="68" r="1.7" fill="#67e8f9" />
        <Circle cx="198" cy="36" r="1.9" fill="#ffffff" />
        <Circle cx="372" cy="130" r="2" fill="#fbbf24" />
        <Circle cx="348" cy="34" r="1.6" fill="#ffffff" />
      </G>
      {variant === 'tree' ? (
        <G>
          <Rect x="206" y="108" width="14" height="88" rx="7" fill="#13091f" />
          <Ellipse cx="213" cy="102" rx="62" ry="34" fill="#e648cf" opacity="0.62" />
          <Ellipse cx="178" cy="122" rx="42" ry="25" fill="#fb7185" opacity="0.4" />
          <Ellipse cx="244" cy="126" rx="47" ry="28" fill="#c084fc" opacity="0.35" />
        </G>
      ) : null}
      {variant === 'runner' ? (
        <G stroke="#f8fafc" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" opacity="0.9">
          <Circle cx="276" cy="94" r="16" fill="#0f172a" stroke={accent} />
          <Path d="M272 114 L258 154 L292 164" fill="none" />
          <Path d="M264 132 L230 142" fill="none" />
          <Path d="M270 154 L242 204" fill="none" />
          <Path d="M292 164 L326 208" fill="none" />
        </G>
      ) : null}
      <Rect width="420" height="280" fill="#000000" opacity="0.08" />
    </Svg>
  );
}
