import type { Metadata } from 'next';

import FeatureLandingPage from '@/app/components/FeatureLandingPage';
import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'AI Motion Transfer for UGC Ads',
    description:
        'Animate a static persona with a reference performance to produce consistent, scalable UGC-style video ads with AI motion transfer.',
    path: '/ai-motion-transfer',
    keywords: [
        'AI motion transfer',
        'animate a photo with AI',
        'AI mimic motion',
        'motion transfer AI video',
        'AI UGC ads',
    ],
});

export default function AIMotionTransferPage() {
    return (
        <FeatureLandingPage
            pagePath="/ai-motion-transfer"
            breadcrumbLabel="AI Motion Transfer"
            badge="Motion transfer for UGC creative"
            title="AI Motion Transfer for UGC Ads"
            description="Take one still image of a persona and a reference performance, and produce a talking, moving, on-brand video ad — without a shoot, a creator contract, or a reshoot when the script changes."
            primaryCtaHref="/create-motion"
            primaryCtaLabel="Open motion transfer"
            secondaryCtaHref="/pricing"
            secondaryCtaLabel="See pricing"
            highlights={[
                'Keep one persona consistent across an entire campaign instead of recasting every variation.',
                'Drive performance from a reference video you control, so timing and delivery are directed, not guessed.',
                'Re-run the same persona against a new script without repeating the setup.',
            ]}
            stepsHeading="Direct a performance onto a still image in three passes"
            steps={[
                {
                    title: 'Choose the persona frame',
                    description:
                        'Pick a clean, well-lit still with the face unobstructed and the shoulders in frame. This image sets identity for every clip that follows.',
                },
                {
                    title: 'Record the reference',
                    description:
                        'Perform the delivery yourself or reuse an existing take. The reference supplies timing, gesture, and expression — the persona supplies the face.',
                },
                {
                    title: 'Generate and iterate',
                    description:
                        'Review the output, adjust the reference where the delivery drifts, and regenerate. Strong takes become the baseline for the rest of the campaign.',
                },
            ]}
            sections={[
                {
                    eyebrow: 'What it is',
                    heading: 'What AI motion transfer actually does',
                    body: [
                        'Motion transfer is a different operation from text-to-video generation, and confusing the two is the most common reason teams get disappointing output. A text-to-video model invents everything: subject, framing, motion, lighting. Motion transfer keeps a subject you supply and applies motion you supply. You are not asking a model to imagine a person — you are asking it to move a specific one.',
                        'That distinction is what makes it useful for advertising. Paid social creative lives or dies on consistency: the same face, the same room, the same energy across a dozen variations, so that what you are testing is the script and not the cast. Text-to-video fights you on this, because every generation is a fresh roll of the dice. Motion transfer holds identity fixed by construction.',
                        'The practical consequence is that your creative variable moves from "which generation looked best" to "which script performed best" — which is the only variable that actually tells you something about your audience.',
                    ],
                },
                {
                    eyebrow: 'Inputs',
                    heading: 'Why the reference video matters more than the prompt',
                    body: [
                        'Teams new to motion transfer spend their effort on the persona image and treat the reference as an afterthought. It is the wrong way around. The still image decides who appears; the reference decides whether anyone believes them.',
                        'A reference performance carries timing, micro-expression, head movement, and the small pauses that make speech read as speech rather than as animation. All of that transfers. So does a flat, rushed, or over-acted delivery. If the reference feels like someone reading from a screen, the output will too, and no amount of prompt adjustment will fix it downstream.',
                    ],
                    bullets: [
                        'Shoot the reference at the pace you want the final ad to run — motion transfer preserves timing, it does not retime.',
                        'Keep the reference framing close to the persona framing. A wide reference driving a tight portrait produces motion that overshoots the frame.',
                        'Favour a reference with natural pauses. Continuous talking with no beats reads as synthetic even when the render is clean.',
                        'Record the reference yourself when the script is specific. You know where the emphasis belongs; a stock performance does not.',
                    ],
                },
                {
                    eyebrow: 'Persona selection',
                    heading: 'Choosing a still image that survives animation',
                    body: [
                        'Not every photograph animates well, and the failure modes are predictable enough to screen for before you spend a generation on them. The image needs to give the model unambiguous information about the face it is being asked to move.',
                        'Occlusion is the main enemy. Hands near the face, hair across one eye, heavy shadow on a cheek, sunglasses, a microphone crossing the jaw — each one forces the model to invent structure that was never visible, and invented structure is what produces the uncanny results people associate with the technique.',
                    ],
                    bullets: [
                        'Front-facing or near-front-facing. Sharp profiles lose the far eye and the model has to guess it.',
                        'Even, diffuse lighting. Hard directional light bakes shadows into the identity and they will not move correctly with the head.',
                        'Neutral or slightly open expression. A fixed broad smile fights every frame of a performance that is not smiling.',
                        'Shoulders in frame. A head cropped at the neck has nothing to anchor body motion against.',
                        'Real resolution. An upscaled thumbnail carries compression artefacts that animation amplifies rather than hides.',
                    ],
                },
                {
                    eyebrow: 'Production workflow',
                    heading: 'Scaling from one clip to a campaign',
                    body: [
                        'One good motion-transfer clip is a demo. The reason to adopt the technique is what happens on clip twenty, when the cost of the twentieth variation is a fraction of the first and the persona has not changed.',
                        'The workflow that scales treats the persona and the reference as separate, reusable assets. Lock a persona once and it becomes campaign-wide casting. Build a small library of reference performances — a hook read, a demonstration beat, a closing call to action — and any script can be assembled from combinations rather than shot from scratch.',
                        'This is also where motion transfer stops being a single tool and becomes a pipeline. Once a persona and a set of references are stable, the same inputs can feed a reusable workflow that produces every variation in a batch, which is the point at which creative testing volume stops being limited by production capacity.',
                    ],
                },
                {
                    eyebrow: 'Honest limits',
                    heading: 'Where motion transfer is the wrong tool',
                    body: [
                        'It is worth being direct about this, because the fastest way to waste credits is to use the technique for something it was never going to do well.',
                        'Motion transfer animates a subject. It does not stage a scene. If your creative needs the persona to pick up the product, walk across a room, or interact physically with anything, you are asking for choreography that the reference cannot supply and the still image cannot support. That is a job for text-to-video with reference frames, or for real footage.',
                        'It is also not a substitute for a real creator when authenticity is the actual product claim. An AI persona is a legitimate production tool for demonstration, explanation, and testing — but if your ad implies a real customer is speaking from real experience, the FTC has been explicit since 2024 that AI-generated presenters making factual claims require clear and conspicuous disclosure. Build that disclosure into the creative from the start rather than retrofitting it after a compliance review.',
                    ],
                },
            ]}
            faqs={[
                {
                    question: 'What is AI motion transfer?',
                    answer:
                        'AI motion transfer applies the motion from a reference video onto a static image, so a still persona performs the timing, gestures, and expressions of the reference. Unlike text-to-video generation, the subject stays fixed — which is what makes it usable for consistent ad campaigns.',
                },
                {
                    question: 'How is it different from an AI video generator?',
                    answer:
                        'A text-to-video generator invents the subject and the motion from a prompt, so every generation differs. Motion transfer keeps a subject you supply and applies motion you supply, which holds identity constant across an entire campaign.',
                },
                {
                    question: 'What makes a good reference video?',
                    answer:
                        'Record at the pace you want the final ad to run, keep the framing close to the persona image, and leave natural pauses in the delivery. Timing and expression transfer directly, so a rushed or flat reference produces a rushed or flat output.',
                },
                {
                    question: 'Can I animate any photo?',
                    answer:
                        'Most clear, front-facing photographs work. Avoid images where hands, hair, shadow, or accessories cross the face, and avoid heavily compressed or upscaled files — animation amplifies artefacts rather than hiding them.',
                },
                {
                    question: 'How much does a motion transfer video cost?',
                    answer:
                        'Generations are billed in credits, and the cost depends on the model, duration, and quality settings you choose. Credit packs start at ₹415 for 500 credits and do not expire while your account is active. Current per-generation costs are shown in the studio before you run anything.',
                },
                {
                    question: 'Do I need to disclose that an ad is AI-generated?',
                    answer:
                        'If an AI-generated presenter makes factual claims about a product, current FTC guidance requires clear and conspicuous disclosure. Plan the disclosure into the creative rather than adding it after the fact — it is easier to design around than to retrofit.',
                },
            ]}
            relatedHeading="Go deeper on motion transfer"
            relatedLinks={[
                {
                    href: '/blog/how-to-animate-a-photo-with-ai-motion-transfer',
                    title: 'Read the step-by-step guide',
                    description: 'A full walkthrough of image selection, reference recording, and the iteration loop.',
                    label: 'Open article',
                },
                {
                    href: '/blog/how-to-create-viral-ugc-ads-with-ai',
                    title: 'Apply it to UGC ads',
                    description: 'How motion transfer fits into a complete AI UGC ad production process.',
                    label: 'Open article',
                },
                {
                    href: '/ai-workflow-builder',
                    title: 'Turn it into a pipeline',
                    description: 'Reuse one persona and a reference library across every variation in a campaign.',
                    label: 'Open workflow page',
                },
            ]}
            featureList={[
                'AI motion transfer from a static persona image and a reference performance',
                'Consistent persona identity across an entire campaign',
                'Reusable reference libraries for repeatable UGC ad production',
            ]}
        />
    );
}
