import type { Metadata } from 'next';

import FeatureLandingPage from '@/app/components/FeatureLandingPage';
import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'AI Motion Transfer for UGC Ads',
    description:
        'Animate a static persona with a reference performance to produce consistent, scalable UGC-style video ads with AI motion transfer.',
    path: '/ai-motion-transfer',
    keywords: ['AI motion transfer', 'animate photo with AI', 'UGC motion transfer', 'AI talking head ads'],
});

export default function AIMotionTransferPage() {
    return (
        <FeatureLandingPage
            pagePath="/ai-motion-transfer"
            badge="Motion transfer for scalable UGC ads"
            title="AI Motion Transfer for UGC Ads"
            description="Map a real performance onto a static persona so you can keep the same on-screen character while testing more scripts, hooks, and delivery styles."
            primaryCtaHref="/create-motion"
            primaryCtaLabel="Open motion transfer"
            secondaryCtaHref="/pricing"
            secondaryCtaLabel="See pricing"
            highlights={[
                'Keep a consistent spokesperson or character across many ad iterations.',
                'Reuse fresh reference performances instead of reshooting every concept from scratch.',
                'Produce creator-style talking ads that feel closer to platform-native UGC.',
            ]}
            steps={[
                {
                    title: 'Choose the persona',
                    description: 'Upload the character image you want to animate so your output stays visually consistent across versions.',
                },
                {
                    title: 'Record the performance',
                    description: 'Use a reference video to supply timing, delivery, and expression while the AI transfers the motion.',
                },
                {
                    title: 'Iterate the creative',
                    description: 'Swap scripts, hooks, and emotions without redoing the whole asset pipeline from zero.',
                },
            ]}
            relatedLinks={[
                {
                    href: '/blog/how-to-animate-a-photo-with-ai-motion-transfer',
                    title: 'Read the motion-transfer tutorial',
                    description: 'Learn how to set up images, performances, and prompts for more convincing talking-head outputs.',
                    label: 'Open article',
                },
                {
                    href: '/blog/how-to-create-viral-ugc-ads-with-ai',
                    title: 'See the broader UGC strategy',
                    description: 'Understand how motion transfer fits into a larger system for AI-generated UGC ad testing.',
                    label: 'Read strategy guide',
                },
                {
                    href: '/showcase',
                    title: 'See showcase-ready results',
                    description: 'Browse examples of public creations to benchmark quality and idea framing.',
                    label: 'See showcase',
                },
            ]}
            featureList={[
                'Animate static personas with reference performances',
                'Scale talking-head UGC concepts without reshooting every test',
                'Carry winning motion ideas into broader campaign workflows',
            ]}
        />
    );
}

