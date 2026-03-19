import type { Metadata } from 'next';

import FeatureLandingPage from '@/app/components/FeatureLandingPage';
import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'AI Image Generator for UGC Ads',
    description:
        'Generate AI product shots, creator-style stills, moodboards, and ad concepts with a workflow tuned for fast UGC iteration.',
    path: '/ai-image-generator',
    keywords: ['AI image generator', 'UGC image generator', 'AI product photos', 'AI ad creative'],
});

export default function AIImageGeneratorPage() {
    return (
        <FeatureLandingPage
            pagePath="/ai-image-generator"
            badge="AI image generation for UGC teams"
            title="AI Image Generator for UGC Ads"
            description="Create product visuals, creator-style frames, hook concepts, and performance-ready stills without waiting on a full design pass."
            primaryCtaHref="/create-image"
            primaryCtaLabel="Open the image generator"
            secondaryCtaHref="/pricing"
            secondaryCtaLabel="See pricing"
            highlights={[
                'Generate concept frames for paid social hooks and thumbnails in minutes.',
                'Use prompt-led exploration or reference-guided workflows to stay on-brand.',
                'Bridge still concepts directly into video and motion-transfer experiments.',
            ]}
            steps={[
                {
                    title: 'Describe the shot',
                    description: 'Start from a prompt, a brand idea, or a creator-style reference and shape the visual direction fast.',
                },
                {
                    title: 'Tune the output',
                    description: 'Adjust aspect ratio, resolution, and model choice so the asset fits the channel you are planning for.',
                },
                {
                    title: 'Reuse the winners',
                    description: 'Carry successful frames into video generation, motion transfer, or your broader content workflow.',
                },
            ]}
            relatedLinks={[
                {
                    href: '/blog/ai-image-generator-for-ugc-ads',
                    title: 'Read the image-generator playbook',
                    description: 'Learn which prompts, references, and ad formats make image generation useful for UGC teams.',
                    label: 'Open article',
                },
                {
                    href: '/showcase',
                    title: 'Browse public showcase examples',
                    description: 'See how the community is turning AI generations into publishable campaign assets.',
                    label: 'See showcase',
                },
                {
                    href: '/pricing',
                    title: 'Plan your testing budget',
                    description: 'Compare credit packs before you turn still concepts into scaled production loops.',
                    label: 'Compare plans',
                },
            ]}
            featureList={[
                'Prompt-driven image generation for ad hooks and product visuals',
                'Reference-guided iteration for consistent brand direction',
                'Reusable outputs that connect to video and workflow tooling',
            ]}
        />
    );
}

