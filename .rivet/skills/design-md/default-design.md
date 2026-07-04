---
version: alpha
name: Tianshu Default
description: 天枢内置默认设计系统 — 简洁、现代、通用的 UI 设计规范，适用于各类 Web 应用和 SaaS 产品。
colors:
  primary: "#2563EB"
  primary-hover: "#1D4ED8"
  primary-light: "#DBEAFE"
  secondary: "#7C3AED"
  surface: "#FFFFFF"
  surface-secondary: "#F9FAFB"
  surface-tertiary: "#F3F4F6"
  background: "#FFFFFF"
  text-primary: "#111827"
  text-secondary: "#6B7280"
  text-tertiary: "#9CA3AF"
  text-inverse: "#FFFFFF"
  border: "#E5E7EB"
  border-focus: "#2563EB"
  error: "#DC2626"
  error-light: "#FEE2E2"
  success: "#16A34A"
  success-light: "#DCFCE7"
  warning: "#F59E0B"
  warning-light: "#FEF3C7"
typography:
  heading:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontWeight: 700
    fontSize: "1.5rem"
    lineHeight: 1.3
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontWeight: 400
    fontSize: "1rem"
    lineHeight: 1.6
    letterSpacing: "0"
  caption:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontWeight: 400
    fontSize: "0.875rem"
    lineHeight: 1.5
    letterSpacing: "0"
  mono:
    fontFamily: "JetBrains Mono, Fira Code, monospace"
    fontWeight: 400
    fontSize: "0.875rem"
    lineHeight: 1.6
spacing:
  unit: 4
  scale: [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80]
shadows:
  sm: "0 1px 2px 0 rgba(0, 0, 0, 0.05)"
  md: "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)"
  lg: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1)"
  xl: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)"
borders:
  radius:
    sm: "4px"
    md: "8px"
    lg: "12px"
    xl: "16px"
    full: "9999px"
components:
  button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.text-inverse}"
    borderRadius: "{borders.radius.md}"
    paddingX: "{spacing.scale[4]}"
    paddingY: "{spacing.scale[2]}"
    fontWeight: 600
    hoverBackgroundColor: "{colors.primary-hover}"
  card:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    borderRadius: "{borders.radius.lg}"
    shadow: "{shadows.sm}"
    padding: "{spacing.scale[6]}"
  input:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    borderRadius: "{borders.radius.md}"
    paddingX: "{spacing.scale[3]}"
    paddingY: "{spacing.scale[2]}"
    focusBorderColor: "{colors.border-focus}"
    textColor: "{colors.text-primary}"
    placeholderColor: "{colors.text-tertiary}"
---

# Tianshu Default Design System

天枢内置的默认设计系统，采用现代简约风格。以蓝色为主色调，紫色为辅色，适合各类通用 Web 应用、SaaS 后台、落地页和工具型产品。

## Colors

主色 `primary: #2563EB`（Blue-600）传递专业、可信赖的品牌感。辅色 `secondary: #7C3AED`（Violet-600）用于强调和点缀。灰度体系覆盖 `surface` → `text` 四个层级，构建清晰的视觉层次。语义色（error/success/warning）遵循通用认知：红=危险、绿=成功、黄=警告。

## Typography

默认字体栈 `Inter → system-ui → -apple-system → sans-serif`，确保在各平台都有良好的渲染效果。等宽字体 `JetBrains Mono → Fira Code → monospace` 用于代码展示。heading 使用 700 字重 + -0.02em 字间距，body 用 400 字重 + 1.6 行高保证长文可读性。

## Spacing

基于 4px 单位的间距体系：`[0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80]`。组件内边距默认 8-12px，卡片内边距 24px，区块间距 32-48px。

## Shadows

四级阴影从微妙（sm: 1px blur）到显著（xl: 20px blur），用于表达不同的 UI 层级。卡片默认用 sm，弹窗用 lg，抽屉/侧栏用 xl。

## Components

约定优于配置：button 默认 primary 背景 + 白色文字 + 8px 圆角，hover 加深；card 白色背景 + 浅灰边框 + 12px 圆角 + sm 阴影；input 白色背景 + 灰色边框，focus 时边框变 primary 色。
