"use client";

import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

const installSteps = [
  {
    title: "克隆并构建",
    code: "git clone https://github.com/user/rivet.git && cd rivet\nnpm install && npm run build",
  },
  {
    title: "配置 API Key",
    code: "export DEEPSEEK_API_KEY=sk-xxx\n# 或使用交互式配置：rivet config",
  },
  {
    title: "启动",
    code: "node dist/main.js",
  },
];

export function QuickStart() {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const copy = async (code: string, index: number) => {
    await navigator.clipboard.writeText(code);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <section id="quickstart" className="bg-bg-primary px-6 py-24">
      <div className="mx-auto max-w-4xl">
        <div className="mb-12 text-center">
          <h2 className="mb-4 text-3xl font-bold tracking-tight md:text-4xl">
            终端快速开始
          </h2>
          <p className="mx-auto max-w-2xl text-text-secondary">
            几分钟内即可在终端运行天枢。支持 headless 与交互式 TUI 两种模式。
          </p>
        </div>

        <div className="space-y-6">
          {installSteps.map((step, index) => (
            <div key={step.title}>
              <h3 className="mb-2 text-sm font-medium text-text-secondary">
                {index + 1}. {step.title}
              </h3>
              <div className="group relative overflow-hidden rounded-xl border border-white/10 bg-bg-secondary">
                <pre className="overflow-x-auto p-5 font-mono text-sm text-text-primary">
                  <code>{step.code}</code>
                </pre>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-3 right-3 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => copy(step.code, index)}
                  aria-label="复制"
                >
                  {copiedIndex === index ? (
                    <Check className="h-4 w-4 text-success" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
