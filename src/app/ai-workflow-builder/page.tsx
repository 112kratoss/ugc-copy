import type { Metadata } from 'next';

import FeatureLandingPage from '@/app/components/FeatureLandingPage';
import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'AI Workflow Builder for Creative Production',
    description:
        'Connect prompts, media inputs, image generation, video generation, and motion transfer inside a reusable AI workflow builder for creative teams.',
    path: '/ai-workflow-builder',
    keywords: ['AI workflow builder', 'creative workflow automation', 'AI content workflow', 'workflow canvas'],
});

export default function AIWorkflowBuilderPage() {
    return (
        <FeatureLandingPage
            pagePath="/ai-workflow-builder"
            badge="Reusable workflows for AI creative production"
            title="AI Workflow Builder for Creative Production"
            description="Design repeatable creative systems that connect prompts, media, generation steps, and approvals instead of rebuilding the same process every sprint."
            primaryCtaHref="/create-workflow"
            primaryCtaLabel="Open the workflow canvas"
            secondaryCtaHref="/pricing"
            secondaryCtaLabel="See pricing"
            highlights={[
                'Turn successful prompts and generation steps into a workflow your team can reuse.',
                'Connect image, video, motion, and audio building blocks inside one visual production canvas.',
                'Reduce handoff friction between experimentation, generation, and packaged campaign output.',
            ]}
            steps={[
                {
                    title: 'Model the process',
                    description: 'Lay out prompts, inputs, and generation nodes visually so the creative pipeline becomes explicit.',
                },
                {
                    title: 'Save the winning system',
                    description: 'Preserve the graph structure, settings, and references that turned into usable creative output.',
                },
                {
                    title: 'Reuse and adapt',
                    description: 'Clone the workflow for new campaigns, new products, or new creators instead of rebuilding from scratch.',
                },
            ]}
            relatedLinks={[
                {
                    href: '/ai-video-generator',
                    title: 'Pair workflows with video generation',
                    description: 'Connect repeatable prompt logic to the video engine when you want more structured production.',
                    label: 'Open video page',
                },
                {
                    href: '/blog/how-to-create-viral-ugc-ads-with-ai',
                    title: 'Read the UGC systems guide',
                    description: 'See how reusable processes help turn one-off wins into a repeatable creative operating model.',
                    label: 'Open article',
                },
                {
                    href: '/pricing',
                    title: 'Budget for scale',
                    description: 'Compare plans before you move from creative experimentation into ongoing workflow-driven production.',
                    label: 'Compare plans',
                },
            ]}
            featureList={[
                'Visual workflow builder for prompts, media, and generation steps',
                'Reusable creative systems that reduce repeated setup work',
                'Cross-functional production support for image, video, motion, and audio pipelines',
            ]}
        />
    );
}
