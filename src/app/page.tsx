import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen font-[family-name:var(--font-geist-sans)] bg-black text-white">
      {/* Header */}
      <header className="w-full px-6 py-4 flex justify-between items-center max-w-7xl mx-auto">
        <Link href="/" className="text-xl font-bold">UGC Creator</Link>
        <nav className="hidden sm:flex items-center gap-6">
          <Link href="/pricing" className="text-zinc-400 hover:text-white transition-colors">Pricing</Link>
          <Link href="/create" className="bg-white text-black px-4 py-2 rounded-full text-sm font-medium hover:bg-zinc-200 transition-colors">
            Start Creating
          </Link>
        </nav>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-8 gap-16 sm:p-20">
        <div className="flex flex-col gap-8 items-center text-center max-w-2xl">
          <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-full px-4 py-1.5 text-sm text-zinc-400">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <span>AI Motion Transfer &amp; UGC Generator</span>
          </div>

          <h1 className="text-5xl sm:text-7xl font-bold tracking-tight bg-gradient-to-b from-white to-zinc-500 text-transparent bg-clip-text">
            Turn any photo into <br /> a video star.
          </h1>

          <p className="text-lg text-zinc-400">
            Create viral UGC ads by animating static photos with reference videos.
            Powered by generative AI.
          </p>

          <div className="flex gap-4 items-center flex-col sm:flex-row">
            <Link
              href="/create"
              className="rounded-full border border-solid border-transparent transition-colors flex items-center justify-center bg-white text-black gap-2 hover:bg-[#ccc] text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 font-medium"
            >
              Start Creating
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/pricing"
              className="rounded-full border border-solid border-white/[.145] transition-colors flex items-center justify-center hover:bg-[#1a1a1a] hover:border-transparent text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 sm:min-w-44 text-zinc-400"
            >
              View Pricing
            </Link>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-zinc-800 py-12 px-6">
        <div className="max-w-7xl mx-auto grid grid-cols-1 sm:grid-cols-4 gap-8">
          <div className="sm:col-span-2">
            <h3 className="text-lg font-semibold mb-3">UGC Creator</h3>
            <p className="text-zinc-400 text-sm max-w-sm">
              Create viral UGC ads by animating static photos with AI-powered motion transfer technology.
            </p>
          </div>
          <div>
            <h4 className="font-medium mb-3">Product</h4>
            <ul className="space-y-2 text-sm text-zinc-400">
              <li><Link href="/create" className="hover:text-white transition-colors">Create Video</Link></li>
              <li><Link href="/pricing" className="hover:text-white transition-colors">Pricing</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-medium mb-3">Company</h4>
            <ul className="space-y-2 text-sm text-zinc-400">
              <li><Link href="/contact" className="hover:text-white transition-colors">Contact</Link></li>
              <li><Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link></li>
              <li><Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link></li>
            </ul>
          </div>
        </div>
        <div className="max-w-7xl mx-auto mt-8 pt-8 border-t border-zinc-800 text-center text-zinc-500 text-sm">
          <p>© 2026 UGC Creator. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
