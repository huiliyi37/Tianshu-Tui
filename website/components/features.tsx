import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Monitor, Network, Puzzle, Shield, Users, Zap } from "lucide-react";

const features = [
  {
    icon: Zap,
    title: "Prefix Cache 引擎",
    description:
      "冻结前缀 + 增量附录，DeepSeek V4 实战命中率高达 95–99%，显著降低长会话成本。",
  },
  {
    icon: Network,
    title: "多模型自适应路由",
    description:
      "一条命令切换 DeepSeek、Claude、GLM、Codex、MiniMax、MiMo，主代理与子代理可配置不同模型。",
  },
  {
    icon: Users,
    title: "子智能体编排",
    description:
      "类型化 work order、只读/写 worker 隔离、批量调度与多种聚合策略，复杂任务自动拆解。",
  },
  {
    icon: Shield,
    title: "结构化安全机制",
    description:
      "路径边界、敏感文件拒绝、审批模式、git checkpoint + 文件级 undo，fail-closed 默认安全。",
  },
  {
    icon: Puzzle,
    title: "MCP 扩展生态",
    description:
      "通过 Model Context Protocol 接入文档搜索、数据库、API 等外部工具服务器。",
  },
  {
    icon: Monitor,
    title: "天枢桌面版",
    description:
      "Tauri 构建的本地 App：多会话 dashboard、artifact 审查、审批介入、定时任务、浏览器验证。",
  },
];

export function Features() {
  return (
    <section id="features" className="bg-bg-primary px-6 py-24">
      <div className="mx-auto max-w-7xl">
        <div className="mb-16 text-center">
          <h2 className="mb-4 text-3xl font-bold tracking-tight md:text-4xl">
            为长会话编程而生
          </h2>
          <p className="mx-auto max-w-2xl text-text-secondary">
            天枢不只是另一个 AI 助手。它把上下文当作结构化、可缓存的资源来管理。
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <Card
              key={feature.title}
              className="group transition-all hover:border-accent/30 hover:bg-bg-secondary"
            >
              <CardHeader>
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent transition-colors group-hover:bg-accent group-hover:text-white">
                  <feature.icon className="h-5 w-5" />
                </div>
                <CardTitle className="text-lg">{feature.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription className="leading-relaxed">
                  {feature.description}
                </CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
