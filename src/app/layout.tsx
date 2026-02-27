import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Navbar from "./components/Navbar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://ugccreator.com'),
  title: "UGC copy - AI Video Generation & Motion Transfer",
  description: "Create viral UGC ads by animating static photos with reference videos. Turn any photo into a video star with our AI-powered motion transfer technology.",
  keywords: ["AI video generation", "UGC copy", "motion transfer", "video animation", "AI content creation", "viral UGC ads", "AI animation", "Kling AI"],
  authors: [{ name: "UGC copy" }],
  openGraph: {
    title: "UGC copy - AI Video Generation",
    description: "Turn any photo into a video star with AI-powered motion transfer",
    type: "website",
    siteName: "UGC copy",
  },
  twitter: {
    card: "summary_large_image",
    title: "UGC copy - AI Video Generation",
    description: "Turn any photo into a video star with AI-powered motion transfer",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Navbar />
        {children}
      </body>
    </html>
  );
}
