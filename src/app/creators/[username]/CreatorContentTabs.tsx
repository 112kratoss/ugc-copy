'use client';

import { useState } from 'react';
import { Heart, Wand2 } from 'lucide-react';
import type { CreatorProfilePageData } from '@/lib/creator-profile';

type TabType = 'creations' | 'remixes' | 'saved';

interface CreatorContentTabsProps {
  items: CreatorProfilePageData['items'];
}

export function CreatorContentTabs({ items }: CreatorContentTabsProps) {
  const [activeTab, setActiveTab] = useState<TabType>('creations');

  return (
    <div className="mt-10">
      {/* Tabs Header */}
      <div className="mb-6 flex items-center gap-6 border-b border-white/10 pb-4">
        <button
          onClick={() => setActiveTab('creations')}
          className={`flex items-center gap-2 pb-4 -mb-[17px] border-b-2 text-sm font-semibold transition-colors ${
            activeTab === 'creations' ? 'border-purple-400 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Creations
        </button>
        <button
          onClick={() => setActiveTab('remixes')}
          className={`flex items-center gap-2 pb-4 -mb-[17px] border-b-2 text-sm font-semibold transition-colors ${
            activeTab === 'remixes' ? 'border-purple-400 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Remixes
        </button>
        <button
          onClick={() => setActiveTab('saved')}
          className={`flex items-center gap-2 pb-4 -mb-[17px] border-b-2 text-sm font-semibold transition-colors ${
            activeTab === 'saved' ? 'border-purple-400 text-white' : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Liked & Saved
        </button>
      </div>

      {/* Tab Content */}
      <div className="mt-8">
        {activeTab === 'creations' && (
          <>
            {items.length === 0 ? (
              <div className="rounded-3xl border border-white/5 bg-zinc-900/20 p-10 text-center text-zinc-400">
                No public creations yet. The next published showcase piece will appear here.
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((item) => (
                  <article
                    key={item.id}
                    className="group overflow-hidden rounded-3xl border border-white/5 bg-zinc-900/30 shadow-[0_0_40px_-30px_rgba(255,255,255,0.3)] hover:border-purple-500/30 transition-all duration-300"
                  >
                    <div className="relative bg-black">
                      {item.category === 'video' || item.category === 'motion' ? (
                        <video
                          src={item.url}
                          muted
                          loop
                          playsInline
                          autoPlay
                          className="aspect-[4/5] w-full object-cover"
                        />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.url} alt={item.title} className="aspect-[4/5] w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                      )}
                      <div className="absolute left-4 top-4 rounded-full border border-white/10 bg-black/50 px-3 py-1 text-xs font-medium capitalize text-zinc-100 backdrop-blur">
                        {item.category}
                      </div>
                    </div>

                    <div className="space-y-4 p-5">
                      <div>
                        <h3 className="text-lg font-semibold text-white group-hover:text-purple-300 transition-colors">{item.title}</h3>
                        <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-400">
                          {item.prompt || 'No prompt captured for this creation yet.'}
                        </p>
                      </div>

                      <div className="flex items-center gap-3 text-sm text-zinc-500">
                        <span>{new Date(item.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        <span>•</span>
                        <span className="flex items-center gap-1"><Heart className="w-3 h-3" /> {item.saveCount}</span>
                        <span>•</span>
                        <span className="flex items-center gap-1"><Wand2 className="w-3 h-3" /> {item.remixCount}</span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}

        {activeTab === 'remixes' && (
          <div className="rounded-3xl border border-white/5 bg-zinc-900/20 p-10 text-center text-zinc-400">
            No remixes available to display yet.
          </div>
        )}

        {activeTab === 'saved' && (
          <div className="rounded-3xl border border-white/5 bg-zinc-900/20 p-10 text-center text-zinc-400">
            Saved items are private or not available.
          </div>
        )}
      </div>
    </div>
  );
}
