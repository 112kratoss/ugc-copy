import type { Metadata } from 'next';

import FeatureLandingPage from '@/app/components/FeatureLandingPage';
import { createMetadata } from '@/lib/seo';

export const metadata: Metadata = createMetadata({
    title: 'AI Workflow Builder for Creative Production',
    description:
        'Connect prompts, media inputs, image generation, video generation, and motion transfer inside a reusable AI workflow builder for creative teams.',
    path: '/ai-workflow-builder',
    keywords: [
        'AI workflow builder',
        'reusable AI content workflow',
        'creative automation',
        'AI content pipeline',
        'AI workflow for creative teams',
    ],
});

export default function AIWorkflowBuilderPage() {
    return (
        <FeatureLandingPage
            pagePath="/ai-workflow-builder"
            breadcrumbLabel="AI Workflow Builder"
            badge="Reusable workflows for AI creative production"
            title="AI Workflow Builder for Creative Production"
            description="Design repeatable creative systems that connect prompts, media, generation steps, and approvals — instead of rebuilding the same process by hand every sprint."
            primaryCtaHref="/create-workflow"
            primaryCtaLabel="Open the workflow canvas"
            secondaryCtaHref="/pricing"
            secondaryCtaLabel="See pricing"
            highlights={[
                'Capture a process that worked once so it can run again without reassembly.',
                'Chain image, video, and motion-transfer steps into one pass instead of moving files between tools.',
                'Hand a working system to a teammate rather than a description of one.',
            ]}
            stepsHeading="Turn a one-off result into a system that runs again"
            steps={[
                {
                    title: 'Map the steps that worked',
                    description:
                        'Lay out the sequence you already ran manually — inputs, generation steps, and the checks you made between them.',
                },
                {
                    title: 'Parameterise the inputs',
                    description:
                        'Decide what changes per run and what stays fixed. The fixed parts are the system; the variable parts are the brief.',
                },
                {
                    title: 'Run it against new inputs',
                    description:
                        'Feed a new product, persona, or script through the same structure and get comparable output without rebuilding anything.',
                },
            ]}
            sections={[
                {
                    eyebrow: 'The problem',
                    heading: 'Most AI creative work is lost the moment it succeeds',
                    body: [
                        'The characteristic failure of AI creative production is not bad output. It is unrepeatable good output. Someone finds a prompt, a reference frame, a model setting, and a sequence of steps that produces something genuinely useful — and none of it is written down anywhere except in that person\'s recent history. A week later the campaign needs twenty more like it and the process starts over.',
                        'This is why teams often report that AI made their first asset dramatically faster and their tenth asset no faster at all. The speed gain was real but it did not compound, because nothing captured the part that was hard to find.',
                        'A workflow is the artefact that captures it. Not the output, not the prompt in isolation, but the whole arrangement: which inputs feed which step, in what order, with which settings. Once that exists, the expensive discovery has been paid for once.',
                    ],
                },
                {
                    eyebrow: 'What to build',
                    heading: 'Workflows worth building, and one that is not',
                    body: [
                        'Not every process deserves to become a workflow. The test is whether you will run it again with different inputs. A one-off exploration should stay a one-off exploration; formalising it is overhead with no return.',
                    ],
                    bullets: [
                        'Campaign variation: one persona and one product, many scripts. The structure is fixed and only the copy changes — the clearest case for a reusable workflow.',
                        'Product onboarding: a new SKU enters the catalogue and needs the same set of hook frames, demo clips, and cutdowns the last one got.',
                        'Persona libraries: a locked persona still plus a set of reference performances, reused across every campaign that persona appears in.',
                        'Format adaptation: one approved concept rendered into the aspect ratios and durations each placement requires.',
                        'Not worth it: pure exploration, where you do not yet know what you are looking for. Build the workflow after the discovery, not during it.',
                    ],
                },
                {
                    eyebrow: 'Design',
                    heading: 'Separate what is fixed from what varies',
                    body: [
                        'The whole craft of workflow design comes down to one judgement, made repeatedly: which parts of this process are the system and which are the brief.',
                        'Get it wrong in one direction and the workflow is too rigid — it only ever produces the exact thing it was built for, and every new requirement forces a rebuild. Get it wrong in the other direction and it is so parameterised that running it is as much work as doing it manually, which defeats the purpose entirely.',
                        'A reliable heuristic: anything that encodes a decision you already made and do not want to revisit belongs in the system. Anything that encodes this specific run belongs in the brief. Model choice, quality settings, and shot structure are usually system. Product, script, and persona are usually brief.',
                    ],
                },
                {
                    eyebrow: 'Compounding',
                    heading: 'Why this is the step that makes the rest worth it',
                    body: [
                        'Image generation makes one still cheaper. Video generation makes one clip cheaper. Motion transfer makes one persona reusable. Individually these are useful tools, and individually they all hit the same ceiling: the human assembly between steps stays constant no matter how fast each step becomes.',
                        'Connecting them removes that ceiling. When a generated persona still flows directly into a motion-transfer step, and that output flows into a set of format adaptations, the marginal cost of the twentieth variation collapses toward the cost of the compute rather than the cost of an afternoon.',
                        'That is the point at which creative testing volume stops being limited by production capacity and starts being limited by how many hypotheses you actually have — which is a much better constraint to be working against.',
                    ],
                },
            ]}
            faqs={[
                {
                    question: 'What is an AI workflow builder?',
                    answer:
                        'A way to connect prompts, media inputs, and generation steps into a sequence that can be run repeatedly with different inputs, instead of reassembling the same process by hand each time.',
                },
                {
                    question: 'When should I turn a process into a workflow?',
                    answer:
                        'When you know you will run it again with different inputs. Formalising a one-off exploration is overhead with no return — build the workflow after the discovery, not during it.',
                },
                {
                    question: 'What should be a parameter and what should be fixed?',
                    answer:
                        'Anything encoding a decision you already made and do not want to revisit belongs in the system: model choice, quality settings, shot structure. Anything specific to this run belongs in the brief: product, script, persona.',
                },
                {
                    question: 'Can a workflow combine image, video, and motion transfer steps?',
                    answer:
                        'Yes — chaining them is where most of the value is. A generated persona still can feed a motion-transfer step, whose output feeds format adaptations, without moving files between tools by hand.',
                },
                {
                    question: 'Can I share a workflow with my team?',
                    answer:
                        'Workflows can be published as reusable templates, which means handing someone a working system rather than a description of one.',
                },
            ]}
            relatedHeading="Build the pieces a workflow connects"
            relatedLinks={[
                {
                    href: '/ai-video-generator',
                    title: 'Add video generation',
                    description: 'Prompt and reference-frame video steps that a workflow can run in sequence.',
                    label: 'Open video page',
                },
                {
                    href: '/ai-motion-transfer',
                    title: 'Add motion transfer',
                    description: 'Reuse one persona across every variation a workflow produces.',
                    label: 'Open motion transfer',
                },
                {
                    href: '/blog/how-to-create-viral-ugc-ads-with-ai',
                    title: 'See the full process',
                    description: 'How the individual steps assemble into a complete UGC ad production run.',
                    label: 'Open article',
                },
            ]}
            featureList={[
                'Reusable AI creative workflows for repeatable production',
                'Chained image, video, and motion-transfer generation steps',
                'Parameterised inputs for campaign-scale variation',
            ]}
        />
    );
}
