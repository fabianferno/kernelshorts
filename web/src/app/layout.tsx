import type { Metadata } from "next";
import Link from "next/link";
import { PushToggle } from "@/components/PushToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "kernelshorts · control plane",
  description: "Run timeline, artifacts and human gates for the shorts pipeline.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="sticky top-0 z-20 flex items-center gap-6 border-b border-line bg-ink/95 px-4 py-2 backdrop-blur">
          <Link href="/" className="font-semibold tracking-tight text-fg">
            kernel<span className="text-accent">shorts</span>
          </Link>
          <nav className="flex gap-4 text-muted">
            <Link href="/" className="hover:text-fg">
              runs
            </Link>
            <Link href="/approvals" className="hover:text-fg">
              approvals
            </Link>
          </nav>
          <PushToggle />
        </header>
        <main className="mx-auto max-w-[1400px] px-4 py-4">{children}</main>
      </body>
    </html>
  );
}
