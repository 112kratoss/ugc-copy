import Link from "next/link";
import { ArrowRight, Sparkles, Play, Zap, Shield } from "lucide-react";

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen font-[family-name:var(--font-geist-sans)] bg-black text-white selection:bg-purple-500/30 overflow-hidden">

      {/* Deep Space Background Effects */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-purple-900/20 blur-[120px] rounded-full mix-blend-screen" />
        <div className="absolute top-[20%] right-[-20%] w-[60%] h-[60%] bg-pink-900/10 blur-[150px] rounded-full mix-blend-screen" />
        <div className="absolute bottom-[-10%] left-[20%] w-[40%] h-[40%] bg-blue-900/10 blur-[120px] rounded-full mix-blend-screen" />
        <div className="absolute inset-0 bg-[url('/noise.png')] opacity-20 mix-blend-overlay" />
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-8 gap-16 sm:p-20 relative z-10 w-full">

        {/* Hero Section */}
        <div className="flex flex-col gap-10 items-center text-center max-w-4xl w-full mt-10 sm:mt-20">

          {/* Badge */}
          <div className="group flex items-center gap-2 bg-zinc-950/80 border border-purple-500/30 rounded-full px-5 py-2 text-sm text-zinc-300 backdrop-blur-md hover:bg-zinc-900/80 transition-all hover:border-purple-400 hover:shadow-[0_0_20px_-5px_rgba(168,85,247,0.4)] cursor-default">
            <Sparkles className="w-4 h-4 text-purple-400 group-hover:text-purple-300 transition-colors" />
            <span className="font-medium tracking-wide">Next-Gen AI Motion Transfer</span>
          </div>

          {/* Headline */}
          <h1 className="text-6xl sm:text-8xl md:text-9xl font-extrabold tracking-tighter leading-[1.1]">
            <span className="block text-white drop-shadow-md">Turn any photo</span>
            <span className="block bg-gradient-to-r from-purple-400 via-pink-500 to-red-500 text-transparent bg-clip-text pb-2">
              into a video star.
            </span>
          </h1>

          {/* Subtext */}
          <p className="text-xl sm:text-2xl text-zinc-400 max-w-2xl font-light leading-relaxed">
            Create ultra-realistic <strong className="text-zinc-200 font-medium">viral UGC ads</strong> by animating static photos with reference videos. Powered by state-of-the-art generative AI.
          </p>

          {/* Buttons */}
          <div className="flex gap-6 items-center flex-col sm:flex-row mt-4 w-full sm:w-auto">
            <Link
              href="/create"
              className="group relative w-full sm:w-auto overflow-hidden rounded-full p-[1px] bg-gradient-to-r from-purple-500 to-pink-500 hover:shadow-[0_0_30px_-5px_rgba(168,85,247,0.5)] transition-all duration-300 hover:scale-105"
            >
              <div className="flex items-center justify-center gap-3 bg-zinc-950 px-8 py-4 sm:px-10 sm:py-5 rounded-full transition-all duration-300 group-hover:bg-opacity-0">
                <span className="font-semibold text-lg sm:text-xl text-white tracking-wide">Start Creating</span>
                <ArrowRight className="w-5 h-5 text-white group-hover:translate-x-1 transition-transform" />
              </div>
            </Link>

            <Link
              href="/pricing"
              className="group flex items-center justify-center gap-3 rounded-full border border-zinc-700 bg-zinc-900/50 backdrop-blur-md px-8 py-4 sm:px-10 sm:py-5 text-lg sm:text-xl font-medium text-zinc-300 transition-all hover:bg-zinc-800 hover:border-zinc-500 hover:text-white w-full sm:w-auto"
            >
              <Play className="w-5 h-5 text-zinc-400 group-hover:text-white transition-colors" />
              See Pricing
            </Link>
          </div>
        </div>

        {/* Feature Highlights */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-5xl mt-20 mb-10">
          <div className="flex flex-col gap-4 p-8 rounded-3xl bg-zinc-900/40 border border-white/5 backdrop-blur-sm hover:bg-zinc-900/60 transition-colors">
            <div className="w-12 h-12 rounded-2xl bg-purple-500/20 flex items-center justify-center border border-purple-500/30">
              <Zap className="w-6 h-6 text-purple-400" />
            </div>
            <h3 className="text-xl font-bold text-zinc-200">Lightning Fast</h3>
            <p className="text-zinc-400 leading-relaxed">Generate broadcast-quality 30-second videos in minutes, not hours.</p>
          </div>

          <div className="flex flex-col gap-4 p-8 rounded-3xl bg-zinc-900/40 border border-white/5 backdrop-blur-sm hover:bg-zinc-900/60 transition-colors">
            <div className="w-12 h-12 rounded-2xl bg-pink-500/20 flex items-center justify-center border border-pink-500/30">
              <Sparkles className="w-6 h-6 text-pink-400" />
            </div>
            <h3 className="text-xl font-bold text-zinc-200">Hyper Realistic</h3>
            <p className="text-zinc-400 leading-relaxed">Our advanced Kling AI model captures every micro-expression flawlessly.</p>
          </div>

          <div className="flex flex-col gap-4 p-8 rounded-3xl bg-zinc-900/40 border border-white/5 backdrop-blur-sm hover:bg-zinc-900/60 transition-colors">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/20 flex items-center justify-center border border-blue-500/30">
              <Shield className="w-6 h-6 text-blue-400" />
            </div>
            <h3 className="text-xl font-bold text-zinc-200">Commercial Safe</h3>
            <p className="text-zinc-400 leading-relaxed">Full rights to use your generated content across all your ad campaigns.</p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-white/10 py-16 px-6 relative z-10 bg-black/80 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto grid grid-cols-1 sm:grid-cols-4 gap-12">
          <div className="sm:col-span-2">
            <h3 className="text-2xl font-bold mb-4 tracking-tight bg-gradient-to-r from-purple-400 to-pink-500 text-transparent bg-clip-text inline-block">UGC Creator</h3>
            <p className="text-zinc-400 text-base max-w-sm leading-relaxed">
              Create viral UGC ads by animating static photos with state-of-the-art AI motion transfer technology.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-lg mb-5 text-zinc-200">Product</h4>
            <ul className="space-y-3 text-base text-zinc-400">
              <li><Link href="/create" className="hover:text-purple-400 transition-colors">Create Video</Link></li>
              <li><Link href="/pricing" className="hover:text-purple-400 transition-colors">Pricing</Link></li>
              <li><Link href="/login" className="hover:text-purple-400 transition-colors">Log In</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-lg mb-5 text-zinc-200">Legal</h4>
            <ul className="space-y-3 text-base text-zinc-400">
              <li><Link href="/contact" className="hover:text-pink-400 transition-colors">Contact Support</Link></li>
              <li><Link href="/terms" className="hover:text-pink-400 transition-colors">Terms of Service</Link></li>
              <li><Link href="/privacy" className="hover:text-pink-400 transition-colors">Privacy Policy</Link></li>
            </ul>
          </div>
        </div>
        <div className="max-w-7xl mx-auto mt-16 pt-8 border-t border-white/5 text-center text-zinc-600 text-sm">
          <p>© {new Date().getFullYear()} UGC Creator. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
