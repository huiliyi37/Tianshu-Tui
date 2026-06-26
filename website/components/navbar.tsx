"use client";

import { Button } from "@/components/ui/button";
import { Download, Github, Menu, X } from "lucide-react";
import { useState } from "react";

const navLinks = [
  { href: "#features", label: "特性" },
  { href: "#desktop", label: "桌面版" },
  { href: "#quickstart", label: "快速开始" },
  { href: "#community", label: "社区" },
];

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-white/5 bg-bg-primary/80 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <a href="#" className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
            枢
          </span>
          <span>天枢</span>
          <span className="text-text-secondary text-sm font-normal">/ Rivet</span>
        </a>

        <ul className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="text-sm text-text-secondary transition-colors hover:text-text-primary"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="hidden items-center gap-3 md:flex">
          <Button variant="ghost" size="sm" asChild>
            <a
              href="https://github.com/user/rivet"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Github className="h-4 w-4" />
              GitHub
            </a>
          </Button>
          <Button size="sm" asChild>
            <a
              href="https://github.com/user/rivet/releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download className="h-4 w-4" />
              下载
            </a>
          </Button>
        </div>

        <button
          className="md:hidden text-text-secondary hover:text-text-primary"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="切换菜单"
        >
          {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </nav>

      {mobileOpen && (
        <div className="border-t border-white/5 bg-bg-secondary px-6 py-4 md:hidden">
          <ul className="flex flex-col gap-4">
            {navLinks.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  className="block text-text-secondary hover:text-text-primary"
                  onClick={() => setMobileOpen(false)}
                >
                  {link.label}
                </a>
              </li>
            ))}
            <li className="pt-2">
              <Button className="w-full" asChild>
                <a
                  href="https://github.com/user/rivet/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download className="h-4 w-4" />
                  下载桌面版
                </a>
              </Button>
            </li>
          </ul>
        </div>
      )}
    </header>
  );
}
