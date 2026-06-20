import type { LucideIcon } from 'lucide-react';
import { Clapperboard, Image as ImageIcon, UserSquare2, Video } from 'lucide-react';

import {
  buildImageLaunchUrl,
  buildMotionLaunchUrl,
  buildVideoLaunchUrl,
} from '@/lib/workflow-blueprint';

export type CreatorToolId = 'image' | 'video' | 'motion' | 'workflow';
export type CreatorToolAccent = 'blue' | 'rose' | 'violet' | 'emerald' | 'amber';

export interface CreatorToolDefinition {
  id: CreatorToolId;
  label: string;
  shortLabel: string;
  href: string;
  icon: LucideIcon;
  accent: CreatorToolAccent;
  eyebrow: string;
  badge: string;
  summary: string;
  pitch: string;
  description: string;
  idealFor: string;
  outcomes: string[];
  launchLabel: string;
  inspirationHref: string;
  inspirationLabel: string;
}

export interface CreatorStarterRecipe {
  id: string;
  toolId: CreatorToolId;
  title: string;
  description: string;
  promptPreview: string;
  href: string;
  ctaLabel: string;
}

export const CREATOR_TOOLS: CreatorToolDefinition[] = [
  {
    id: 'image',
    label: 'Create Image',
    shortLabel: 'Image',
    href: '/create-image',
    icon: ImageIcon,
    accent: 'blue',
    eyebrow: 'Fastest way in',
    badge: 'Quick win',
    summary: 'Polished stills, hooks, and product frames in minutes.',
    pitch: 'Turn a rough idea into a polished visual in minutes.',
    description:
      'Generate product shots, portraits, ad concepts, and storyboard frames from a single prompt.',
    idealFor: 'Hooks, thumbnails, product reveals, creator stills',
    outcomes: ['Product hero shot', 'Campaign concept frame', 'Portrait-led ad visual'],
    launchLabel: 'Start with image',
    inspirationHref: '/showcase?category=image',
    inspirationLabel: 'Browse image inspiration',
  },
  {
    id: 'video',
    label: 'Create Video',
    shortLabel: 'Video',
    href: '/create-video',
    icon: Video,
    accent: 'rose',
    eyebrow: 'Scene-led output',
    badge: 'Creator favorite',
    summary: 'Prompt-to-clip scenes for launches, explainers, and teasers.',
    pitch: 'Create cinematic clips and ad-ready scenes from text and reference frames.',
    description:
      'Go from script idea to a short-form video concept with single-shot or multi-shot flows.',
    idealFor: 'Launch teasers, talking-head scenes, cinematic promos',
    outcomes: ['Vertical teaser', 'Founder intro clip', 'Short commercial scene'],
    launchLabel: 'Start with video',
    inspirationHref: '/showcase?category=video',
    inspirationLabel: 'Browse video inspiration',
  },
  {
    id: 'motion',
    label: 'Create Motion',
    shortLabel: 'Motion',
    href: '/create-motion',
    icon: UserSquare2,
    accent: 'violet',
    eyebrow: 'Performance remix',
    badge: 'High impact',
    summary: 'Animate still talent into UGC-style movement and delivery.',
    pitch: 'Animate a still character with real movement and ad-style energy.',
    description:
      'Combine a character image with a performance reference to create motion-led UGC content.',
    idealFor: 'UGC hooks, creator remixes, performance-driven product spots',
    outcomes: ['Influencer-style delivery', 'Motion-led product demo', 'Character performance remix'],
    launchLabel: 'Start with motion',
    inspirationHref: '/showcase?category=video',
    inspirationLabel: 'Browse motion inspiration',
  },
  {
    id: 'workflow',
    label: 'Workflow Canvas',
    shortLabel: 'Workflow',
    href: '/create-workflow',
    icon: Clapperboard,
    accent: 'emerald',
    eyebrow: 'Scale with systems',
    badge: 'System builder',
    summary: 'Turn one-off prompting into a repeatable creative system.',
    pitch: 'Turn one-off prompting into a repeatable creative machine.',
    description:
      'Map image, video, motion, and delivery steps into a reusable production flow for campaigns.',
    idealFor: 'Campaign systems, repeatable content loops, team handoff',
    outcomes: ['Campaign blueprint', 'Reusable generation flow', 'Multi-step production pipeline'],
    launchLabel: 'Open workflow canvas',
    inspirationHref: '/create-workflow',
    inspirationLabel: 'Open a reusable canvas',
  },
];

export const CREATOR_STARTER_RECIPES: CreatorStarterRecipe[] = [
  {
    id: 'product-hero',
    toolId: 'image',
    title: 'Launch a premium product visual',
    description:
      'Start with a still image when you need a clean ad hook, ecommerce shot, or polished campaign cover.',
    promptPreview:
      'Luxury skincare serum on a soft stone pedestal, premium studio lighting, sharp reflections, upscale campaign aesthetic.',
    href: buildImageLaunchUrl(
      'Luxury skincare serum on a soft stone pedestal, premium studio lighting, sharp reflections, upscale campaign aesthetic.',
      'nano-banana-2',
      '4:5'
    ),
    ctaLabel: 'Try this image setup',
  },
  {
    id: 'founder-teaser',
    toolId: 'video',
    title: 'Create a founder-style teaser',
    description:
      'Start with a short video when you want movement, presence, and a clearer story in the very first asset.',
    promptPreview:
      'Confident founder walking through a bright studio, explaining how the product saves time, cinematic commercial energy.',
    href: buildVideoLaunchUrl(
      'Confident founder walking through a bright studio, explaining how the product saves time, cinematic commercial energy.',
      'kling-3.0-video',
      '9:16',
      '5'
    ),
    ctaLabel: 'Try this video setup',
  },
  {
    id: 'ugc-motion',
    toolId: 'motion',
    title: 'Animate a UGC-style performance',
    description:
      'Start with motion when you already have a face, product persona, or creator visual that needs believable movement.',
    promptPreview:
      "No distortion, preserve the subject identity, natural creator-style gestures, clean delivery, ad-ready confidence.",
    href: buildMotionLaunchUrl(
      "No distortion, preserve the subject identity, natural creator-style gestures, clean delivery, ad-ready confidence.",
      'kling-3.0'
    ),
    ctaLabel: 'Try this motion setup',
  },
  {
    id: 'campaign-system',
    toolId: 'workflow',
    title: 'Map a reusable campaign system',
    description:
      'Start with workflow when you want to connect ideas, prompts, and deliveries into one repeatable production loop.',
    promptPreview:
      'Use the canvas to plan stills, motion clips, video beats, and delivery order for a repeatable ad pipeline.',
    href: '/create-workflow',
    ctaLabel: 'Open workflow canvas',
  },
];

export function getCreatorTool(toolId: CreatorToolId): CreatorToolDefinition {
  const tool = CREATOR_TOOLS.find((candidate) => candidate.id === toolId);

  if (!tool) {
    throw new Error(`Unknown creator tool: ${toolId}`);
  }

  return tool;
}
