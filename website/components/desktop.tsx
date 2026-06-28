import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Apple, Check, Clock, LayoutDashboard, MessageSquare, ShieldCheck } from "lucide-react";

const desktopFeatures = [
  { icon: LayoutDashboard, text: "多会话 Dashboard，实时查看 phase 与进度" },
  { icon: MessageSquare, text: "Artifact 审查与反馈回灌" },
  { icon: ShieldCheck, text: "审批 / Intent 介入，diff 可视化" },
  { icon: Clock, text: "定时任务 /schedule，cron 会话管理" },
];

export function Desktop() {
  return (
    <section id="desktop" className="bg-bg-secondary px-6 py-24">
      <div className="mx-auto max-w-7xl">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <h2 className="mb-4 text-3xl font-bold tracking-tight md:text-4xl">
              天枢桌面版
            </h2>
            <p className="mb-6 text-lg text-text-secondary">
              基于 Tauri 2.x + React/Vite 的本地 App。Node runtime 作为 localhost sidecar 运行，打开即可与 agent 对话、审查 artifacts、介入审批。
            </p>

            <ul className="mb-8 space-y-4">
              {desktopFeatures.map((item) => (
                <li key={item.text} className="flex items-start gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                    <item.icon className="h-3.5 w-3.5" />
                  </div>
                  <span className="text-text-secondary">{item.text}</span>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-4">
              <Button asChild>
                <a
                  href="https://github.com/huiliyi37/Tianshu-Tui/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Apple className="h-5 w-5" />
                  下载 macOS 版
                </a>
              </Button>
              <Button variant="outline" disabled>
                Windows / Linux 即将推出
              </Button>
            </div>
          </div>

          <Card className="border-accent/20 bg-bg-primary">
            <CardContent className="p-0">
              <div className="rounded-xl bg-bg-tertiary p-6">
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-3 w-3 rounded-full bg-danger" />
                    <div className="h-3 w-3 rounded-full bg-warning" />
                    <div className="h-3 w-3 rounded-full bg-success" />
                  </div>
                  <span className="text-xs text-text-secondary font-mono">天枢.app</span>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-lg bg-bg-secondary p-3">
                    <div>
                      <div className="text-sm font-medium">重构认证模块</div>
                      <div className="text-xs text-text-secondary">phase: verifying</div>
                    </div>
                    <span className="rounded-full bg-warning/10 px-2 py-1 text-xs text-warning">
                      审批中
                    </span>
                  </div>

                  <div className="flex items-center justify-between rounded-lg bg-bg-secondary p-3">
                    <div>
                      <div className="text-sm font-medium">API 文档检索</div>
                      <div className="text-xs text-text-secondary">scheduled: 09:00</div>
                    </div>
                    <span className="rounded-full bg-accent/10 px-2 py-1 text-xs text-accent-glow">
                      定时
                    </span>
                  </div>

                  <div className="flex items-center justify-between rounded-lg bg-bg-secondary p-3">
                    <div>
                      <div className="text-sm font-medium">代码审查</div>
                      <div className="text-xs text-text-secondary">artifact: plan.md</div>
                    </div>
                    <span className="rounded-full bg-success/10 px-2 py-1 text-xs text-success">
                      <Check className="h-3 w-3" />
                    </span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
