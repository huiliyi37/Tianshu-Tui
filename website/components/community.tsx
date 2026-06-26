import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BookOpen, Github, Heart, MessageCircle } from "lucide-react";

export function Community() {
  return (
    <section id="community" className="bg-bg-secondary px-6 py-24">
      <div className="mx-auto max-w-5xl text-center">
        <h2 className="mb-4 text-3xl font-bold tracking-tight md:text-4xl">
          开源社区
        </h2>
        <p className="mx-auto mb-12 max-w-2xl text-text-secondary">
          天枢采用 MIT 协议开源。欢迎提交 Issue、PR，或分享你的使用经验。
        </p>

        <div className="grid gap-6 sm:grid-cols-3">
          <Card className="bg-bg-primary">
            <CardContent className="flex flex-col items-center p-6">
              <Github className="mb-4 h-8 w-8 text-accent" />
              <h3 className="mb-2 font-semibold">GitHub</h3>
              <p className="mb-4 text-sm text-text-secondary">查看源码、提交反馈、参与贡献</p>
              <Button variant="secondary" size="sm" asChild>
                <a
                  href="https://github.com/user/rivet"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  访问仓库
                </a>
              </Button>
            </CardContent>
          </Card>

          <Card className="bg-bg-primary">
            <CardContent className="flex flex-col items-center p-6">
              <BookOpen className="mb-4 h-8 w-8 text-accent" />
              <h3 className="mb-2 font-semibold">文档</h3>
              <p className="mb-4 text-sm text-text-secondary">配置指南、模型提供方、Slash 命令</p>
              <Button variant="secondary" size="sm" asChild>
                <a href="https://github.com/user/rivet/tree/main/docs">
                  阅读文档
                </a>
              </Button>
            </CardContent>
          </Card>

          <Card className="bg-bg-primary">
            <CardContent className="flex flex-col items-center p-6">
              <MessageCircle className="mb-4 h-8 w-8 text-accent" />
              <h3 className="mb-2 font-semibold">讨论</h3>
              <p className="mb-4 text-sm text-text-secondary">交流用法、分享技能与最佳实践</p>
              <Button variant="secondary" size="sm" asChild>
                <a
                  href="https://github.com/user/rivet/discussions"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  加入讨论
                </a>
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="mt-12 flex items-center justify-center gap-2 text-sm text-text-secondary">
          <Heart className="h-4 w-4 text-danger" />
          <span>由社区驱动，MIT 协议开源</span>
        </div>
      </div>
    </section>
  );
}
