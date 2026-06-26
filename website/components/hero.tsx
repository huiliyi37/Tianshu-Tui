import { Button } from "@/components/ui/button";
import { ArrowDown, Download, Terminal } from "lucide-react";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-bg-primary bg-grid px-6 pt-24 pb-32 md:pt-32 md:pb-40">
      {/* Gradient orbs */}
      <div className="absolute top-0 left-1/4 h-[500px] w-[500px] -translate-x-1/2 rounded-full bg-accent/20 blur-[120px]" />
      <div className="absolute right-0 bottom-0 h-[400px] w-[400px] translate-x-1/3 rounded-full bg-purple-500/10 blur-[100px]" />

      <div className="relative mx-auto max-w-5xl text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-1.5 text-sm text-accent-glow">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          MIT 开源 · 2700+ 测试 · TypeScript strict
        </div>

        <h1 className="mb-6 text-4xl font-extrabold tracking-tight md:text-6xl lg:text-7xl">
          天枢 <span className="text-text-secondary font-light">/ Rivet</span>
          <br />
          <span className="bg-gradient-to-r from-text-primary via-accent-glow to-accent bg-clip-text text-transparent">
            终端里的 AI 合伙人
          </span>
        </h1>

        <p className="mx-auto mb-10 max-w-2xl text-lg text-text-secondary md:text-xl">
          为 DeepSeek V4 前缀缓存优化的开源编程代理。多模型路由、子智能体编排、结构化安全机制，让长会话保持高效与可控。
        </p>

        <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Button size="lg" asChild>
            <a
              href="https://github.com/user/rivet/releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download className="h-5 w-5" />
              下载桌面版
            </a>
          </Button>
          <Button variant="secondary" size="lg" asChild>
            <a href="#quickstart">
              <Terminal className="h-5 w-5" />
              终端快速开始
            </a>
          </Button>
        </div>

        <a
          href="#features"
          className="absolute bottom-8 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-1 text-sm text-text-secondary transition-colors hover:text-text-primary md:flex"
        >
          <span>探索特性</span>
          <ArrowDown className="h-4 w-4 animate-bounce" />
        </a>
      </div>
    </section>
  );
}
