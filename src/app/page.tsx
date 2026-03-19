import Link from "next/link";
import { ArrowRight, Play, Shield, Sparkles, Zap } from "lucide-react";
import { Metadata } from "next";

import { JsonLd } from "@/app/components/JsonLd";
import { PRICING_CURRENCY, PRICING_PLAN_MAP } from "@/lib/pricing";
import {
  buildOrganizationSchema,
  buildSoftwareApplicationSchema,
  createMetadata,
  siteConfig,
} from "@/lib/seo";

const solutionLinks = [
  {
    href: "/ai-image-generator",
    title: "AI image generator",
    description: "Create product shots, hooks, and creator-style stills that feed directly into your ad pipeline.",
  },
  {
    href: "/ai-video-generator",
    title: "AI video generator",
    description: "Turn prompts and reference frames into platform-ready ad variations without a traditional edit suite.",
  },
  {
    href: "/ai-motion-transfer",
    title: "AI motion transfer",
    description: "Animate a static persona with a reference performance to create consistent UGC-style talking ads.",
  },
  {
    href: "/ai-workflow-builder",
    title: "AI workflow builder",
    description: "Connect prompts, media inputs, and generation steps into reusable production systems.",
  },
];

const discoveryLinks = [
  {
    href: "/showcase",
    title: "See community-ready outputs",
    description: "Browse real examples of public image, video, and motion-transfer generations in the showcase.",
  },
  {
    href: "/blog/how-to-create-viral-ugc-ads-with-ai",
    title: "Read the UGC growth playbook",
    description: "Get tactical guidance on scripting, persona design, hooks, and AI-driven UGC production loops.",
  },
  {
    href: "/pricing",
    title: "Compare credit packs",
    description: "Understand what it costs to move from one-off experiments to repeatable AI production.",
  },
];

export const metadata: Metadata = createMetadata({
  title: siteConfig.name,
  absoluteTitle: siteConfig.defaultTitle,
  description:
    "Generate AI images, AI videos, motion-transfer UGC ads, and reusable creative workflows with UGC copy.",
  path: "/",
  keywords: [
    "AI UGC ad generator",
    "AI motion transfer",
    "AI image generator",
    "AI video generator",
    "UGC ad creator",
    "AI workflow builder",
  ],
});

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col overflow-hidden bg-black text-white selection:bg-purple-500/30">
      <JsonLd data={buildOrganizationSchema()} />
      <JsonLd
        data={buildSoftwareApplicationSchema({
          name: siteConfig.name,
          path: "/",
          description:
            "UGC copy helps teams generate AI images, AI videos, motion-transfer ads, and reusable creative workflows from one production studio.",
          featureList: [
            "Generate AI images for hooks, product shots, and persona ideation",
            "Create AI videos from prompts and reference frames",
            "Animate a static photo with motion transfer for UGC ads",
            "Build reusable workflow canvases for repeatable creative production",
          ],
          offers: [
            {
              name: `${PRICING_PLAN_MAP.starter.name} credits`,
              price: PRICING_PLAN_MAP.starter.priceInr,
              priceCurrency: PRICING_CURRENCY,
            },
          ],
        })}
      />

      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] h-[50%] w-[50%] rounded-full bg-purple-900/20 blur-[120px] mix-blend-screen" />
        <div className="absolute top-[20%] right-[-20%] h-[60%] w-[60%] rounded-full bg-pink-900/10 blur-[150px] mix-blend-screen" />
        <div className="absolute bottom-[-10%] left-[20%] h-[40%] w-[40%] rounded-full bg-blue-900/10 blur-[120px] mix-blend-screen" />
        <div className="absolute inset-0 bg-[url('/noise.png')] opacity-20 mix-blend-overlay" />
      </div>

      <main className="relative z-10 flex flex-1 flex-col items-center gap-16 p-8 sm:p-20">
        <section className="mt-10 flex w-full max-w-4xl flex-col items-center gap-10 text-center sm:mt-20">
          <div className="group flex cursor-default items-center gap-2 rounded-full border border-purple-500/30 bg-zinc-950/80 px-5 py-2 text-sm text-zinc-300 backdrop-blur-md transition-all hover:border-purple-400 hover:bg-zinc-900/80 hover:shadow-[0_0_20px_-5px_rgba(168,85,247,0.4)]">
            <Sparkles className="h-4 w-4 text-purple-400 transition-colors group-hover:text-purple-300" />
            <span className="font-medium tracking-wide">
              AI image generation, video generation, motion transfer, and reusable workflows
            </span>
          </div>

          <div className="flex flex-col gap-6">
            <h1 className="text-6xl font-extrabold tracking-tighter leading-[1.1] sm:text-8xl md:text-9xl">
              <span className="block text-white drop-shadow-md">From idea</span>
              <span className="block bg-gradient-to-r from-purple-400 via-pink-500 to-red-500 bg-clip-text pb-2 text-transparent">
                to ad-ready output.
              </span>
            </h1>

            <p className="mx-auto max-w-3xl text-xl font-light leading-relaxed text-zinc-400 sm:text-2xl">
              Generate <strong className="font-medium text-zinc-200">images</strong>, create{" "}
              <strong className="font-medium text-zinc-200">videos</strong>, animate photos with{" "}
              <strong className="font-medium text-zinc-200">motion transfer</strong>, and turn it
              all into repeatable creative systems.
            </p>
          </div>

          <div className="mt-4 flex w-full flex-col items-center gap-6 sm:w-auto sm:flex-row">
            <Link
              href="/create"
              className="group relative w-full overflow-hidden rounded-full bg-gradient-to-r from-purple-500 to-pink-500 p-[1px] transition-all duration-300 hover:scale-105 hover:shadow-[0_0_30px_-5px_rgba(168,85,247,0.5)] sm:w-auto"
            >
              <div className="flex items-center justify-center gap-3 rounded-full bg-zinc-950 px-8 py-4 transition-all duration-300 group-hover:bg-opacity-0 sm:px-10 sm:py-5">
                <span className="text-lg font-semibold tracking-wide text-white sm:text-xl">
                  Start Creating
                </span>
                <ArrowRight className="h-5 w-5 text-white transition-transform group-hover:translate-x-1" />
              </div>
            </Link>

            <Link
              href="/pricing"
              className="group flex w-full items-center justify-center gap-3 rounded-full border border-zinc-700 bg-zinc-900/50 px-8 py-4 text-lg font-medium text-zinc-300 backdrop-blur-md transition-all hover:border-zinc-500 hover:bg-zinc-800 hover:text-white sm:w-auto sm:px-10 sm:py-5 sm:text-xl"
            >
              <Play className="h-5 w-5 text-zinc-400 transition-colors group-hover:text-white" />
              See Pricing
            </Link>
          </div>
        </section>

        <section className="mt-20 mb-6 grid w-full max-w-5xl grid-cols-1 gap-6 md:grid-cols-3">
          <div className="flex flex-col gap-4 rounded-3xl border border-white/5 bg-zinc-900/40 p-8 backdrop-blur-sm transition-colors hover:bg-zinc-900/60">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-purple-500/30 bg-purple-500/20">
              <Zap className="h-6 w-6 text-purple-400" />
            </div>
            <h2 className="text-xl font-bold text-zinc-200">Built for iteration speed</h2>
            <p className="leading-relaxed text-zinc-400">
              Move from concept to usable assets fast enough to test more hooks, more personas, and more creatives.
            </p>
          </div>

          <div className="flex flex-col gap-4 rounded-3xl border border-white/5 bg-zinc-900/40 p-8 backdrop-blur-sm transition-colors hover:bg-zinc-900/60">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-pink-500/30 bg-pink-500/20">
              <Sparkles className="h-6 w-6 text-pink-400" />
            </div>
            <h2 className="text-xl font-bold text-zinc-200">One studio, four workflows</h2>
            <p className="leading-relaxed text-zinc-400">
              Generate stills, videos, motion-transfer ads, and reusable node-based workflows without stitching tools together.
            </p>
          </div>

          <div className="flex flex-col gap-4 rounded-3xl border border-white/5 bg-zinc-900/40 p-8 backdrop-blur-sm transition-colors hover:bg-zinc-900/60">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/20">
              <Shield className="h-6 w-6 text-blue-400" />
            </div>
            <h2 className="text-xl font-bold text-zinc-200">Optimized for production teams</h2>
            <p className="leading-relaxed text-zinc-400">
              Keep inputs, outputs, pricing, and publishing loops close together so experiments can scale into repeatable campaigns.
            </p>
          </div>
        </section>

        <section className="w-full max-w-6xl rounded-[2rem] border border-white/8 bg-zinc-950/60 p-8 backdrop-blur-xl sm:p-10">
          <div className="mb-8 max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-zinc-500">
              Explore by intent
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Choose the workflow you want to rank, learn, and build around
            </h2>
          </div>
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            {solutionLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="group rounded-[1.5rem] border border-white/8 bg-white/[0.03] p-6 transition hover:-translate-y-1 hover:border-purple-400/40 hover:bg-white/[0.05]"
              >
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-500">
                  SEO landing page
                </p>
                <h3 className="mt-4 text-2xl font-semibold text-white">{link.title}</h3>
                <p className="mt-3 text-sm leading-6 text-zinc-400">{link.description}</p>
                <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-purple-300">
                  Explore page
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="w-full max-w-6xl">
          <div className="mb-8 max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.25em] text-zinc-500">
              Learn and compare
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Connect the landing pages to proof, education, and commercial intent
            </h2>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {discoveryLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="group rounded-[1.5rem] border border-white/8 bg-zinc-900/50 p-6 backdrop-blur-sm transition hover:border-pink-400/40 hover:bg-zinc-900/80"
              >
                <h3 className="text-2xl font-semibold text-white">{link.title}</h3>
                <p className="mt-3 text-sm leading-6 text-zinc-400">{link.description}</p>
                <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-pink-300">
                  Open link
                  <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" />
                </span>
              </Link>
            ))}
          </div>
        </section>
      </main>

      <footer className="relative z-10 w-full border-t border-white/10 bg-black/80 px-6 py-16 backdrop-blur-lg">
        <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <h3 className="mb-4 inline-block bg-gradient-to-r from-purple-400 to-pink-500 bg-clip-text text-2xl font-bold tracking-tight text-transparent">
              UGC copy
            </h3>
            <p className="max-w-sm text-base leading-relaxed text-zinc-400">
              Create AI images, videos, motion-transfer ads, and reusable workflows with one production-ready creative studio.
            </p>
          </div>
          <div>
            <h4 className="mb-5 text-lg font-semibold text-zinc-200">Explore</h4>
            <ul className="space-y-3 text-base text-zinc-400">
              <li><Link href="/ai-image-generator" className="transition-colors hover:text-purple-400">AI Image Generator</Link></li>
              <li><Link href="/ai-video-generator" className="transition-colors hover:text-purple-400">AI Video Generator</Link></li>
              <li><Link href="/ai-motion-transfer" className="transition-colors hover:text-purple-400">AI Motion Transfer</Link></li>
              <li><Link href="/ai-workflow-builder" className="transition-colors hover:text-purple-400">AI Workflow Builder</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="mb-5 text-lg font-semibold text-zinc-200">Resources</h4>
            <ul className="space-y-3 text-base text-zinc-400">
              <li><Link href="/showcase" className="transition-colors hover:text-pink-400">Community Showcase</Link></li>
              <li><Link href="/blog" className="transition-colors hover:text-pink-400">Blog</Link></li>
              <li><Link href="/pricing" className="transition-colors hover:text-pink-400">Pricing</Link></li>
              <li><Link href="/contact" className="transition-colors hover:text-pink-400">Contact Support</Link></li>
            </ul>
          </div>
        </div>
        <div className="mx-auto mt-16 max-w-7xl border-t border-white/5 pt-8 text-center text-sm text-zinc-600">
          <p>© {new Date().getFullYear()} UGC copy. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
