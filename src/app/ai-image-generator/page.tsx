import type { Metadata } from 'next';

import FeatureLandingPage from '@/components/FeatureLandingPage';
import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'AI Image Generator for UGC Ads',
    description:
        'Generate AI product shots, creator-style stills, moodboards, and ad concepts with a workflow tuned for fast UGC iteration.',
    path: '/ai-image-generator',
    keywords: [
        'AI image generator',
        'AI product photography',
        'AI ad creative',
        'UGC image generator',
        'AI image generator for ads',
    ],
});

export default function AIImageGeneratorPage() {
    return (
        <FeatureLandingPage
            pagePath="/ai-image-generator"
            breadcrumbLabel="AI Image Generator"
            badge="AI image generation for UGC teams"
            title="AI Image Generator for UGC Ads"
            description="Create product visuals, creator-style frames, hook concepts, and performance-ready stills without waiting on a full design pass — and without a studio booking to test an idea."
            primaryCtaHref="/create-image"
            primaryCtaLabel="Open the image generator"
            secondaryCtaHref="/pricing"
            secondaryCtaLabel="See pricing"
            highlights={[
                'Produce hook frames and concept stills in the time a brief would normally take to write.',
                'Generate reference frames that steer downstream video and motion-transfer work.',
                'Test visual directions cheaply before committing to a shoot or a design sprint.',
            ]}
            stepsHeading="Turn a creative question into a comparable set of stills"
            steps={[
                {
                    title: 'Define the decision',
                    description:
                        'Name what the image has to settle — a hook, a background, a product angle — before you write the prompt. Undirected generation produces pretty images that decide nothing.',
                },
                {
                    title: 'Generate a comparable set',
                    description:
                        'Vary one attribute at a time so the outputs can be read against each other rather than judged individually.',
                },
                {
                    title: 'Promote the winner',
                    description:
                        'Carry the strongest frame forward as a reference image for video generation, motion transfer, or a reusable workflow.',
                },
            ]}
            sections={[
                {
                    eyebrow: 'Positioning',
                    heading: 'The best use of AI images in UGC is not making pretty pictures',
                    body: [
                        'When performance teams first reach for an image generator, the instinct is to produce finished creative. That is the least valuable thing it does. Finished creative is the part of the process where craft and brand judgement matter most, and it is the part where a generated image is most likely to be almost-right in ways that are expensive to fix.',
                        'The high-value use is upstream: making the next decision cheaper. Which background reads as authentic rather than staged? Does the product photograph better held or placed? Which of four hook concepts survives contact with an actual image? Those questions normally cost a shoot to answer. They cost a handful of credits to answer here, and the answer transfers directly into a brief.',
                        'Framed that way, the output does not need to be perfect. It needs to be comparable. A set of six rough images that isolates one variable is worth more than one polished image that settles nothing.',
                    ],
                },
                {
                    eyebrow: 'What to make first',
                    heading: 'Four asset types that earn their credits immediately',
                    body: [
                        'If you are starting from scratch, these are the categories where generated images tend to pay back fastest in a UGC workflow.',
                    ],
                    bullets: [
                        'Hook frames: the first 1–2 seconds of a short-form ad, generated as stills so you can compare openings before animating any of them.',
                        'Background and setting tests: the same product in a bathroom, a kitchen counter, a desk, natural light versus lamp light. Setting drives perceived authenticity more than most teams expect.',
                        'Reference frames for video: a locked composition that a video generator interpolates from, which is far more reliable than describing the same composition in prose.',
                        'Persona stills for motion transfer: a clean, front-facing, evenly lit frame built specifically to be animated later.',
                    ],
                },
                {
                    eyebrow: 'Prompting',
                    heading: 'Describe the photograph, not the product',
                    body: [
                        'Prompts that name only the subject leave every photographic decision to the model, which is why the same prompt returns wildly different images run to run. The fix is to describe the photograph you want taken: the lens, the light, the surface, the distance, the mood.',
                        'This is also what separates images that look like stock from images that look like UGC. Stock photography reads as staged because it is evenly lit, perfectly composed, and shot on clean backgrounds. Creator content reads as authentic because it is not. If you want output that belongs in a UGC ad, you have to ask for the imperfections on purpose — natural window light, a slightly off-centre crop, a real surface with things on it.',
                    ],
                    bullets: [
                        'Name the light source and its direction. It carries most of the perceived realism.',
                        'Name the surface and the setting. "On a cluttered bathroom shelf" is a completely different ad from "on a white background".',
                        'Name the camera distance and crop rather than leaving framing to chance.',
                        'For UGC specifically, ask for phone-camera characteristics rather than studio ones.',
                        'Change one attribute per generation when you are comparing. Change several when you are exploring. Know which you are doing.',
                    ],
                },
                {
                    eyebrow: 'Downstream use',
                    heading: 'Images are the control surface for everything else',
                    body: [
                        'An image generator used in isolation produces assets. Used as the front of a pipeline, it produces control over everything downstream — and this is where the compounding value sits.',
                        'A generated still can become the start frame that fixes a video generation\'s composition. It can become the persona frame that a motion-transfer run animates for an entire campaign. It can become the locked visual reference that keeps twenty variations recognisably part of one campaign rather than twenty unrelated ads.',
                        'That is why the frames worth spending real effort on are the ones that will be reused. A hook frame that gets animated fifty times deserves more iteration than a background test that answers one question and retires.',
                    ],
                },
            ]}
            faqs={[
                {
                    question: 'What should I generate first with an AI image generator?',
                    answer:
                        'Hook frames, background and setting tests, reference frames for video generation, and clean persona stills for motion transfer. These four pay back fastest because they make a downstream decision cheaper rather than trying to be finished creative.',
                },
                {
                    question: 'How do I get images that look like UGC instead of stock photography?',
                    answer:
                        'Ask for the imperfections explicitly — natural window light, a real cluttered surface, an off-centre crop, phone-camera characteristics. Stock looks staged because it is evenly lit and perfectly composed; creator content does not.',
                },
                {
                    question: 'Can I use a generated image as a reference for video?',
                    answer:
                        'Yes, and it is one of the highest-value uses. A generated still supplied as a start frame fixes composition far more reliably than describing the same composition in a text prompt.',
                },
                {
                    question: 'Why do my generations look different every time?',
                    answer:
                        'Usually because the prompt names only the subject and leaves lighting, framing, and distance to the model. Describing the photograph rather than the product makes output far more repeatable.',
                },
                {
                    question: 'How much does AI image generation cost?',
                    answer:
                        'Images are billed in credits, with the cost depending on the model and quality settings. Credit packs start at ₹415 for 500 credits and do not expire while your account is active.',
                },
            ]}
            relatedHeading="Go deeper on AI imagery"
            relatedLinks={[
                {
                    href: '/blog/ai-image-generator-for-ugc-ads',
                    title: 'Read the UGC image guide',
                    description: 'Which image assets to create first when the goal is better ad testing.',
                    label: 'Open article',
                },
                {
                    href: '/ai-motion-transfer',
                    title: 'Animate a persona still',
                    description: 'Turn a generated front-facing frame into a performing persona for video ads.',
                    label: 'Open motion transfer',
                },
                {
                    href: '/showcase',
                    title: 'Review public examples',
                    description: 'Explore what creators are producing and the workflows behind the outputs.',
                    label: 'See showcase',
                },
            ]}
            featureList={[
                'Prompt-based AI image generation for UGC ad creative',
                'Reference frame production for video and motion-transfer workflows',
                'Fast comparable variations for creative testing',
            ]}
        />
    );
}
