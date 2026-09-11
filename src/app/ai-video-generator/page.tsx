import type { Metadata } from 'next';

import FeatureLandingPage from '@/app/components/FeatureLandingPage';
import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'AI Video Generator for Product Ads',
    description:
        'Create AI product ads, explainer clips, and multi-shot social videos from prompts and reference frames with a workflow built for speed.',
    path: '/ai-video-generator',
    keywords: [
        'AI video generator',
        'AI product ads',
        'AI ad video creator',
        'social video generator',
        'AI video generator for product ads',
    ],
});

export default function AIVideoGeneratorPage() {
    return (
        <FeatureLandingPage
            pagePath="/ai-video-generator"
            breadcrumbLabel="AI Video Generator"
            badge="AI video generation for paid social"
            title="AI Video Generator for Product Ads"
            description="Generate product demos, short-form ad variations, and multi-shot creative tests from one prompt-driven workflow — and find out which angle works before you commit a production budget to it."
            primaryCtaHref="/create-video"
            primaryCtaLabel="Open the video generator"
            secondaryCtaHref="/pricing"
            secondaryCtaLabel="See pricing"
            highlights={[
                'Build short-form video concepts without waiting on a manual edit or a reshoot.',
                'Mix prompt-first generation with reference images to steer pacing and composition.',
                'Test multiple narrative structures before you commit budget to final distribution.',
            ]}
            stepsHeading="From a written angle to a testable cut in three passes"
            steps={[
                {
                    title: 'Frame the story',
                    description:
                        'Choose your model, prompt, and duration so the output matches the story arc you want to test — not just the subject you want to see.',
                },
                {
                    title: 'Guide the generation',
                    description:
                        'Add start and end images, sound settings, or multi-shot prompts to shape composition and pacing rather than leaving them to the model.',
                },
                {
                    title: 'Export and iterate',
                    description:
                        'Compare versions, keep the hooks that hold attention, and spin the strongest ideas into repeatable campaign workflows.',
                },
            ]}
            sections={[
                {
                    eyebrow: 'Positioning',
                    heading: 'Treat the generator as a testing engine, not a final-edit button',
                    body: [
                        'The teams that get value out of AI video generation and the teams that abandon it after a month are usually running the same tool with a different expectation. The ones that abandon it expected finished, broadcast-ready assets on the first pass. The ones that stay treat generation as the cheapest possible way to answer a question they would otherwise answer with a shoot.',
                        'That question is almost never "what does the product look like". It is "which angle, hook, and pace makes someone stop scrolling". Those are structural decisions, and structure is exactly what a generated clip can test faithfully even when the render is imperfect. A rough thirty-second cut that proves the demonstration-first angle beats the testimonial-first angle has already paid for itself, regardless of whether that specific clip ever runs.',
                        'The practical rule: generate to decide, produce to ship. Once a direction wins, you know precisely what to spend real production budget on — and you have a reference cut to brief it with.',
                    ],
                },
                {
                    eyebrow: 'Prompting',
                    heading: 'Prompt for shots, not for subjects',
                    body: [
                        'The single biggest quality jump in AI video comes from writing prompts the way a director writes a shot list rather than the way a search query is typed. "A woman using a skincare product" describes a subject. It gives the model no information about framing, movement, duration, or intent, so the model supplies all four at random and the result differs every run.',
                        'A shot-shaped prompt names the frame, the motion, and the beat. It tells the model where the camera is, what moves, and how long the moment lasts. That specificity is also what makes outputs comparable — when two generations differ only in the variable you changed, the comparison means something.',
                    ],
                    bullets: [
                        'Name the shot size and angle explicitly: close on hands, mid-shot at eye level, overhead on a flat surface.',
                        'Describe camera motion separately from subject motion. "Slow push in" and "she turns toward the light" are different instructions and the model treats them differently.',
                        'Specify the lighting condition. It carries more of the perceived production value than any other single term.',
                        'Keep one variable per test. Changing the hook and the lighting at once tells you nothing about either.',
                        'Write the duration into the plan, not just the settings. A beat that needs four seconds will feel rushed in two regardless of the prompt.',
                    ],
                },
                {
                    eyebrow: 'Reference frames',
                    heading: 'Use start and end images to control what prompts cannot',
                    body: [
                        'Prompt text is a weak instrument for composition. It describes intent; it does not pin down a frame. Reference images do, and using them is the difference between a generator that surprises you and one you can direct.',
                        'A start frame fixes the opening composition — the product in the right position, the right crop, the right colour. An end frame fixes where the motion resolves. Between them, the model interpolates, which is a far more constrained and far more predictable problem than generating from a blank slate.',
                        'For product work this matters more than for any other category, because the product itself has to stay recognisable. A prompt cannot reliably reproduce your packaging. A reference frame containing your packaging can.',
                    ],
                },
                {
                    eyebrow: 'Model choice',
                    heading: 'Different models fail in different directions',
                    body: [
                        'There is no single best video model, and choosing by leaderboard position leads teams to overpay for qualities their creative does not need. The useful question is which failure mode you can least afford.',
                        'Models tuned for cinematic realism produce the most convincing footage and cost the most per second, which makes them a poor fit for wide exploratory testing and a good fit for the final cut of an angle you have already validated. Faster, cheaper models produce rougher output but let you look at ten angles instead of one — which is the correct trade when you are still deciding what to make.',
                        'The workflow that wastes the least is tiered: explore broadly on inexpensive generations, then re-run only the winning structure on a higher-fidelity model. Current per-generation credit costs are shown in the studio before you run anything, so the cost of each tier is visible at the point of decision rather than discovered afterwards.',
                    ],
                },
                {
                    eyebrow: 'Common failures',
                    heading: 'What usually goes wrong, and what to change',
                    body: [
                        'Most disappointing generations trace back to one of a handful of causes, and each has a specific fix that is cheaper than regenerating blindly.',
                    ],
                    bullets: [
                        'Output ignores the product: the product was described in the prompt instead of supplied as a reference frame.',
                        'Motion feels aimless: the prompt named a subject but no camera instruction, so the model chose one.',
                        'Every generation looks different: too many variables changed at once, or no reference frame is anchoring composition.',
                        'The clip feels rushed: the beat needed more duration than the setting allowed. Extend the duration before rewriting the prompt.',
                        'Faces look wrong: text-to-video is the wrong tool for a consistent recurring persona. Use motion transfer, which holds identity fixed by construction.',
                    ],
                },
            ]}
            faqs={[
                {
                    question: 'What can an AI video generator realistically produce for ads?',
                    answer:
                        'Short-form product demonstrations, explainer clips, b-roll, and multi-shot social variations. It is strongest as a way to test angles, pacing, and structure quickly, and weakest as a one-pass replacement for a finished production.',
                },
                {
                    question: 'How do I keep generated videos consistent with my product?',
                    answer:
                        'Supply the product as a start reference frame rather than describing it in the prompt. Text prompts cannot reliably reproduce specific packaging; a reference image containing it can.',
                },
                {
                    question: 'Which model should I use?',
                    answer:
                        'Explore broadly on faster, cheaper models while you are still deciding on an angle, then re-run only the winning structure on a higher-fidelity model. Per-generation credit costs are shown in the studio before you run anything.',
                },
                {
                    question: 'How long does a generation take?',
                    answer:
                        'It depends on the model, duration, and quality settings. Generations run in the background, so you can queue several variations and review them together rather than waiting on each one.',
                },
                {
                    question: 'How much does AI video generation cost?',
                    answer:
                        'Generations are billed in credits, with the cost varying by model, duration, and quality. Credit packs start at ₹415 for 500 credits and do not expire while your account is active.',
                },
                {
                    question: 'Can I use generated video in paid advertising?',
                    answer:
                        'Yes, subject to the ad platform policies and to disclosure rules. Current FTC guidance requires clear and conspicuous disclosure where AI-generated presenters make factual claims about a product.',
                },
            ]}
            relatedHeading="Go deeper on AI video"
            relatedLinks={[
                {
                    href: '/blog/ai-video-generator-for-product-ads',
                    title: 'Read the product-ad guide',
                    description: 'How to structure prompts, pacing, and shot logic for AI-generated product videos.',
                    label: 'Open article',
                },
                {
                    href: '/ai-motion-transfer',
                    title: 'Hold a persona constant',
                    description: 'When identity has to stay fixed across a campaign, motion transfer beats text-to-video.',
                    label: 'Open motion transfer',
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
