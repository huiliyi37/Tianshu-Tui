import { Github } from "lucide-react";

export function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t border-white/5 bg-bg-primary px-6 py-12">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 md:flex-row">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-xs text-white">
            枢
          </span>
          <span>天枢 / Rivet</span>
          <span className="hidden sm:inline">·</span>
          <span className="hidden sm:inline">© {currentYear}</span>
        </div>

        <nav className="flex flex-wrap items-center justify-center gap-6 text-sm text-text-secondary">
          <a href="#features" className="hover:text-text-primary">
            特性
          </a>
          <a href="#desktop" className="hover:text-text-primary">
            桌面版
          </a>
          <a href="#quickstart" className="hover:text-text-primary">
            快速开始
          </a>
          <a
            href="https://github.com/huiliyi37/Tianshu-Tui/blob/main/CONTRIBUTING.md"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-primary"
          >
            贡献
          </a>
          <a
            href="https://github.com/huiliyi37/Tianshu-Tui/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-text-primary"
          >
            MIT License
          </a>
        </nav>

        <a
          href="https://github.com/huiliyi37/Tianshu-Tui"
          target="_blank"
          rel="noopener noreferrer"
          className="text-text-secondary hover:text-text-primary"
          aria-label="GitHub"
        >
          <Github className="h-5 w-5" />
        </a>
      </div>
    </footer>
  );
}
