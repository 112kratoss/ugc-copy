import type { Metadata } from 'next';

import FeatureLandingPage from '@/app/components/FeatureLandingPage';
import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'AI Video Generator for Product Ads',
    description:
        'Create AI product ads, explainer clips, and multi-shot social videos from prompts and reference frames with a workflow built for speed.',
    path: '/ai-video-generator',
    keywords: ['AI video generator', 'AI product ads', 'AI ad video creator', 'social video generator'],
});

export default function AIVideoGeneratorPage() {
    return (
        <FeatureLandingPage
            pagePath="/ai-video-generator"
            badge="AI video generation for paid social"
            title="AI Video Generator for Product Ads"
            description="Generate product demos, short-form ad variations, and multi-shot creative tests from one prompt-driven workflow."
            primaryCtaHref="/create-video"
            primaryCtaLabel="Open the video generator"
            secondaryCtaHref="/pricing"
            secondaryCtaLabel="See pricing"
            highlights={[
                'Build short-form video concepts without waiting on a manual edit or reshoot.',
                'Mix prompt-first generation with reference images to steer pacing and composition.',
                'Test multiple narrative structures before you commit budget to final distribution.',
            ]}
            steps={[
                {
                    title: 'Frame the story',
                    description: 'Choose your model, prompt, and duration so the output matches the story arc you want to test.',
                },
                {
                    title: 'Guide the generation',
                    description: 'Add start and end images, sound settings, or multi-shot prompts to shape the final asset.',
                },
                {
                    title: 'Export and iterate',
                    description: 'Compare versions, study performance-ready hooks, and spin the best ideas into repeatable campaigns.',
                },
            ]}
            relatedLinks={[
                {
                    href: '/blog/ai-video-generator-for-product-ads',
                    title: 'Read the product-ad guide',
                    description: 'See how to structure prompts, pacing, and shot logic for AI-generated product videos.',
                    label: 'Open article',
                },
                {
                    href: '/showcase',
                    title: 'Review public examples',
                    description: 'Explore how creators are packaging AI-generated clips for production-ready outputs.',
                    label: 'See showcase',
                },
                {
                    href: '/ai-workflow-builder',
                    title: 'Connect video into a workflow',
                    description: 'Turn strong prompts and outputs into a reusable production system instead of a one-off win.',
                    label: 'Open workflow page',
                },
            ]}
            featureList={[
                'Prompt-based AI video generation for product ads and creative testing',
                'Reference-image guidance to keep outputs closer to campaign intent',
                'Reusable multi-shot workflows for repeatable video iteration',
            ]}
        />
    );
}

