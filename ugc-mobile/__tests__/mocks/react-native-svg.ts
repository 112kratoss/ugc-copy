import React from 'react';

/**
 * react-native-svg's entry pulls in react-native itself, whose Flow syntax
 * vitest cannot parse. The drawing primitives render as host elements so every
 * prop a caller resolved — an icon's stroke width, say — stays assertable.
 */
type SvgProps = Record<string, unknown> & { children?: React.ReactNode };

const svgTag = (tag: string) => {
  const Component = ({ children, ...props }: SvgProps) => React.createElement(tag, props, children);
  Component.displayName = tag;
  return Component;
};

export const Svg = svgTag('svg');
export const Circle = svgTag('circle');
export const ClipPath = svgTag('clippath');
export const Defs = svgTag('defs');
export const Ellipse = svgTag('ellipse');
export const G = svgTag('g');
export const Line = svgTag('line');
export const LinearGradient = svgTag('lineargradient');
export const Mask = svgTag('mask');
export const Path = svgTag('path');
export const Polygon = svgTag('polygon');
export const Polyline = svgTag('polyline');
export const RadialGradient = svgTag('radialgradient');
export const Rect = svgTag('rect');
export const Stop = svgTag('stop');
export const Text = svgTag('svgtext');

export default Svg;
