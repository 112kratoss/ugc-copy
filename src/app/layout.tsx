import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "UGC Creator - AI Video Generation & Motion Transfer",
  description: "Create viral UGC ads by animating static photos with reference videos. Turn any photo into a video star with our AI-powered motion transfer technology.",
  keywords: ["AI video generation", "UGC creator", "motion transfer", "video animation", "AI content creation"],
  authors: [{ name: "UGC Creator" }],
  openGraph: {
    title: "UGC Creator - AI Video Generation",
    description: "Turn any photo into a video star with AI-powered motion transfer",
    type: "website",
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
        {children}
      </body>
    </html>
  );
}
