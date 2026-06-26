"use client";

import { useEffect, useRef, useState } from "react";

interface Line {
  type: "input" | "output" | "tool";
  text: string;
}

const demoScript: Line[] = [
  { type: "input", text: "$ rivet /goal 重构认证模块，全面使用 async/await" },
  { type: "output", text: "🚀 Goal set: 重构认证模块，全面使用 async/await" },
  { type: "tool", text: "read: src/auth.ts (unchanged, cached ref)" },
  { type: "tool", text: "read: src/middleware.ts (unchanged, cached ref)" },
  { type: "output", text: "Plan: 1) 提取 token 验证为 async 函数  2) 更新中间件  3) 跑测试" },
  { type: "tool", text: "edit: src/auth.ts  (+12/-8 lines)" },
  { type: "tool", text: "edit: src/middleware.ts  (+6/-4 lines)" },
  { type: "tool", text: "run: npm test  ✅ 42 passed" },
  { type: "output", text: "✅ 完成。缓存命中率 98%，未触发审批。" },
];

export function TerminalDemo() {
  const [lines, setLines] = useState<Line[]>([]);
  const [currentLineIndex, setCurrentLineIndex] = useState(0);
  const [currentCharIndex, setCurrentCharIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (currentLineIndex >= demoScript.length) return;

    const currentLine = demoScript[currentLineIndex];
    const fullText = currentLine.text;

    if (currentCharIndex < fullText.length) {
      const timer = setTimeout(() => {
        setCurrentCharIndex((prev) => prev + 1);
      }, currentLine.type === "input" ? 25 : 8);
      return () => clearTimeout(timer);
    } else {
      const timer = setTimeout(() => {
        setLines((prev) => [...prev, currentLine]);
        setCurrentLineIndex((prev) => prev + 1);
        setCurrentCharIndex(0);
      }, currentLine.type === "output" ? 900 : 500);
      return () => clearTimeout(timer);
    }
  }, [currentLineIndex, currentCharIndex]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, currentCharIndex]);

  const renderLine = (line: Line, isCurrent: boolean, typedLength: number) => {
    const visibleText = isCurrent ? line.text.slice(0, typedLength) : line.text;
    const colorClass =
      line.type === "input"
        ? "text-accent-glow"
        : line.type === "tool"
        ? "text-success"
        : "text-text-secondary";

    return (
      <div key={line.text} className={`font-mono text-sm ${colorClass}`}>
        {visibleText}
        {isCurrent && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-accent align-text-bottom" />}
      </div>
    );
  };

  return (
    <section className="bg-bg-primary px-6 py-24">
      <div className="mx-auto max-w-4xl">
        <div className="mb-12 text-center">
          <h2 className="mb-4 text-3xl font-bold tracking-tight md:text-4xl">
            看天枢如何工作
          </h2>
          <p className="mx-auto max-w-2xl text-text-secondary">
            设定目标后，它自动读取、规划、修改、验证，并在每一步保持上下文紧凑。
          </p>
        </div>

        <div className="overflow-hidden rounded-xl border border-white/10 bg-bg-secondary shadow-2xl shadow-accent/5">
          {/* Window title bar */}
          <div className="flex items-center gap-2 border-b border-white/10 bg-bg-tertiary px-4 py-3">
            <div className="h-3 w-3 rounded-full bg-danger" />
            <div className="h-3 w-3 rounded-full bg-warning" />
            <div className="h-3 w-3 rounded-full bg-success" />
            <span className="ml-2 text-xs text-text-secondary font-mono">rivet — tianshu</span>
          </div>

          {/* Terminal content */}
          <div
            ref={scrollRef}
            className="terminal-scroll h-[360px] overflow-y-auto p-5 md:h-[420px] md:p-6"
          >
            {lines.map((line) => renderLine(line, false, line.text.length))}
            {currentLineIndex < demoScript.length &&
              renderLine(demoScript[currentLineIndex], true, currentCharIndex)}
          </div>
        </div>
      </div>
    </section>
  );
}
