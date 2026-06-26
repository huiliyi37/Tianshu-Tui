import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "天枢 / Rivet — 终端里的 AI 合伙人",
  description:
    "为 DeepSeek V4 前缀缓存优化的开源终端编程代理。多模型路由、子智能体编排、结构化安全机制，让长会话保持高效与可控。",
  keywords: [
    "AI 编程代理",
    "终端",
    "TUI",
    "DeepSeek",
    "prefix cache",
    "Rivet",
    "天枢",
    "开源",
  ],
  authors: [{ name: "Rivet Team" }],
  openGraph: {
    title: "天枢 / Rivet — 终端里的 AI 合伙人",
    description:
      "为 DeepSeek V4 前缀缓存优化的开源终端编程代理。",
    type: "website",
    locale: "zh_CN",
  },
  twitter: {
    card: "summary_large_image",
    title: "天枢 / Rivet — 终端里的 AI 合伙人",
    description:
      "为 DeepSeek V4 前缀缓存优化的开源终端编程代理。",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased min-h-screen bg-bg-primary text-text-primary">
        {children}
      </body>
    </html>
  );
}
