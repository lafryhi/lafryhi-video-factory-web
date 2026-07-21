import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Analytics } from "./components/Analytics";

export const metadata: Metadata = {
  title: { default: "LAFRYHI Video Factory", template: "%s | LAFRYHI Video Factory" },
  description: "Free video tools that work directly in your browser. No signup. No watermark.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://video.lafryhi.com")
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Analytics />
        <header>
          <Link className="brand" href="/"><span>L</span> LAFRYHI Video Factory</Link>
          <nav><a href="#tools">Tools</a><a href="#privacy">Privacy</a></nav>
        </header>
        <main>{children}</main>
        <footer>© 2026 LAFRYHI Video Factory · Built for creators everywhere.</footer>
      </body>
    </html>
  );
}
