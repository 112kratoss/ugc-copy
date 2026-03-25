import Link from "next/link";
import { ArrowRight, Sparkles, Image as ImageIcon, Video, UserSquare2, Layers, ChevronRight } from "lucide-react";
import { Metadata } from "next";

import { JsonLd } from "@/app/components/JsonLd";
import { PRICING_CURRENCY, PRICING_PLAN_MAP } from "@/lib/pricing";
import { buildOrganizationSchema, buildSoftwareApplicationSchema, createMetadata, siteConfig } from "@/lib/seo";
import { getShowcaseFeedPage } from '@/lib/showcase-feed';
import { getServerAuthState } from '@/lib/supabase-server';
import { HoverVideo } from "@/app/components/HoverVideo";

export const metadata: Metadata = createMetadata({
  title: siteConfig.name,
  absoluteTitle: siteConfig.defaultTitle,
  description: "Generate AI images, AI videos, motion-transfer UGC ads, and reusable creative workflows with UGC copy.",
  path: "/",
});

export default async function Home() {
  const auth = await getServerAuthState();
  const showcaseFeed = await getShowcaseFeedPage({
      category: 'all',
      sort: 'top-saves',
      offset: 0,
      limit: 12,
      viewerUserId: auth.session?.user?.id ?? null,
  });

  const tools = [
    { title: "Create Image", desc: "Generate images from text prompts", icon: ImageIcon, href: "/create-image", color: "from-blue-500 to-cyan-400" },
    { title: "Text to Video", desc: "Generate videos from text prompts", icon: Video, href: "/create-video", color: "from-pink-500 to-rose-400" },
    { title: "Motion Sync", desc: "Motion control videos from image & performance", icon: UserSquare2, href: "/create-motion", color: "from-purple-500 to-fuchsia-400" },
    { title: "Workflow Builder", desc: "Connect prompts into reusable systems", icon: Layers, href: "/create-workflow", color: "from-emerald-500 to-teal-400" },
  ];

  return (
    <div className="flex min-h-screen flex-col overflow-hidden bg-black text-white font-[family-name:var(--font-geist-sans)]">
      <JsonLd data={buildOrganizationSchema()} />
      <JsonLd
        data={buildSoftwareApplicationSchema({
          name: siteConfig.name,
          path: "/",
          description: "UGC copy helps teams generate AI images, AI videos, motion-transfer ads, and reusable creative workflows.",
          featureList: ["AI images", "AI videos", "Motion transfer", "Workflows"],
          offers: [{ name: `${PRICING_PLAN_MAP.starter.name} credits`, price: PRICING_PLAN_MAP.starter.priceInr, priceCurrency: PRICING_CURRENCY }],
        })}
      />

      <main className="relative z-10 flex flex-1 flex-col items-center px-6 pt-24 pb-24 max-w-[1400px] mx-auto w-full">
        {/* Hero Section */}
        <section className="flex flex-col items-center text-center w-full mb-16 mt-8">
          <h1 className="text-4xl sm:text-5xl md:text-[3.5rem] font-bold tracking-tight mb-10 leading-tight">
            What would you like <br className="hidden sm:block" />
            to <span className="font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-pink-500 via-purple-500 to-indigo-500">create</span> today? <Sparkles className="inline-block w-8 h-8 text-purple-400 -mt-2 ml-1" />
          </h1>

          {/* Category Tabs (Visual only for dashboard feel) */}
          <div className="flex flex-wrap items-center justify-center gap-1 p-1.5 bg-[#1A1A1A] rounded-full border border-white/[0.05] shadow-lg max-w-full overflow-x-auto hide-scrollbar">
            {[
              { name: 'Video', icon: Video },
              { name: 'Image', icon: ImageIcon },
              { name: 'Motion', icon: UserSquare2 },
              { name: 'Workflow', icon: Layers },
            ].map((tab, i) => (
              <button key={tab.name} className={`flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-medium transition-all ${i === 1 ? 'bg-[#2A2A2A] text-white shadow-sm border border-white/5' : 'text-zinc-400 hover:text-white hover:bg-white/5'}`}>
                <tab.icon className="w-4 h-4" />
                {tab.name}
              </button>
            ))}
          </div>
        </section>

        {/* UGC Suite */}
        <section className="w-full mb-16">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">UGC Suite</h2>
            <Link href="/create" className="text-sm font-semibold text-zinc-400 hover:text-white flex items-center gap-1 transition-colors">
              More <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {tools.map((tool) => (
              <Link key={tool.title} href={tool.href} className="group relative flex gap-4 p-4 rounded-2xl bg-[#1A1A1A] border border-white/[0.04] hover:bg-[#222222] hover:border-white/10 transition-all duration-300">
                <div className={`w-14 h-14 shrink-0 rounded-xl bg-gradient-to-br ${tool.color} flex items-center justify-center shadow-inner`}>
                  <tool.icon className="w-7 h-7 text-white/90 drop-shadow-sm" />
                </div>
                <div className="flex flex-col justify-center">
                  <h3 className="font-semibold text-zinc-100 group-hover:text-white transition-colors">{tool.title}</h3>
                  <p className="text-xs text-zinc-500 line-clamp-2 mt-0.5">{tool.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Inspirations */}
        <section className="w-full">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">Inspirations</h2>
            <div className="flex gap-2">
                <Link href="/showcase?category=image" className="px-4 py-1.5 text-xs font-semibold bg-[#2A2A2A] text-white rounded-full border border-white/5 transition-colors">
                Images
                </Link>
                <Link href="/showcase?category=video" className="px-4 py-1.5 text-xs font-semibold bg-[#1A1A1A] text-zinc-400 hover:text-white hover:bg-[#2A2A2A] rounded-full border border-transparent transition-colors">
                Video
                </Link>
            </div>
          </div>

          <div className="columns-2 md:columns-3 xl:columns-4 gap-4 space-y-4">
            {showcaseFeed.items.map((item) => (
              <Link key={item.id} href={`/showcase?category=${item.category}`} className="group relative block break-inside-avoid bg-[#1A1A1A] rounded-[1.5rem] overflow-hidden border border-white/[0.04] hover:border-white/10 hover:shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all">
                {item.category === 'video' || item.category === 'motion' ? (
                  <HoverVideo src={item.url} className="w-full h-auto block object-cover opacity-90 group-hover:opacity-100 transition-opacity" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.url} alt={item.title} className="w-full h-auto block object-cover opacity-90 group-hover:opacity-100 transition-opacity" />
                )}
                <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/80 via-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                    <p className="text-sm font-medium text-white line-clamp-2 leading-tight">{item.title}</p>
                    <p className="text-xs text-zinc-300 line-clamp-1 mt-1">{item.prompt}</p>
                </div>
              </Link>
            ))}
            {showcaseFeed.items.length === 0 && (
              <div className="col-span-full py-12 text-center text-zinc-500 bg-[#1A1A1A] rounded-2xl border border-white/[0.04]">
                <p>No community inspirations found yet.</p>
              </div>
            )}
          </div>
          
          <div className="w-full flex justify-center mt-10">
            <Link href="/showcase" className="px-6 py-3 bg-[#1A1A1A] border border-white/[0.05] hover:bg-[#252525] hover:border-white/10 text-white rounded-full text-sm font-medium transition-all shadow-sm">
                View more inspirations
            </Link>
          </div>
        </section>

      </main>
      
      {/* Footer minimal */}
      <footer className="w-full border-t border-white/[0.04] bg-black px-6 py-8 text-center text-sm text-zinc-600">
        <p>© {new Date().getFullYear()} UGC copy. All rights reserved.</p>
      </footer>
    </div>
  );
}
