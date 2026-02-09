import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "InfluenceAI Discovery Tool",
  description: "Discover Instagram influencers by hashtag and follower count",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-gradient-to-br from-slate-50 to-slate-100 min-h-screen">
        {children}
      </body>
    </html>
  );
}