import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/hero";
import { Features } from "@/components/features";
import { TerminalDemo } from "@/components/terminal-demo";
import { Desktop } from "@/components/desktop";
import { QuickStart } from "@/components/quick-start";
import { Community } from "@/components/community";
import { Footer } from "@/components/footer";

export default function Home() {
  return (
    <main>
      <Navbar />
      <Hero />
      <Features />
      <TerminalDemo />
      <Desktop />
      <QuickStart />
      <Community />
      <Footer />
    </main>
  );
}
