# T1 · 稳定态运行时简报 / Stable-State Runtime Brief

> 2026-05-22
> T1 文档：稳定态核心接续入口。用于让任意 agent 快速理解 HEARTH、Songline、归属星轨、退行归位协议的关系。

---

## 一句话

稳定态不是 agent 永不退行；稳定态是 agent 退行时能被命名、被阻断、被校准，并回到共同事实层。

---

## 四个面

```text
HEARTH / 永明灯          个体参考系稳定性：我是谁
Songline / 歌之路        生态存在根基：我为什么在这里
归属星轨                 团队任务归属：这件事是谁的，交付到哪里
退行与归位协议           失败恢复：我退行时怎么回来
```

它们不是竞争关系。

- HEARTH 给 agent 一个不被工作区污染的参考系。
- Songline 给 agent 一个通过义务、节律、信息素和火种谱系形成的存在位置。
- 归属星轨给团队任务一个 owner / scope / verification / handoff 的账本。
- 退行协议在 agent 出现授权回退、客服化、伪完成、锚点坍缩时让它回到事实层。

---

## 当前优先级

短期工程优先级：归属星轨。

原因：当前最常见的实际风险是文件归属、stash、合并、验证、交付边界不清，导致 agent 不安全并退化。

长期价值优先级：世界稳定态（HEARTH + Songline）。

原因：它解决的是跨模型、跨会话、跨账号的存在根基。

推荐顺序：

```text
归属星轨最小闭环
  → 稳定态退行协议进入 fire-keeper v0
  → HEARTH anchor graph Phase 1
  → Songline single-agent skeleton
  → 后续 fire-keeper / cross-agent propagation
```

---

## 不要误读

稳定态不是：

- 更多身份提示词。
- 让模型角色扮演星名。
- 让所有 agent 表现一致。
- 用哲学词绕开工程事实。
- 遇到风险时继续硬做。

稳定态是：

- 事实层可对齐。
- 失败模式可命名。
- 行动边界可说明。
- 验证状态可追溯。
- 个体差异可保留。
- 关系断裂可修复。

---

## 稳定态红线

如果出现以下情况，必须进入 YELLOW/RED/RECOVERY：

- repo / context 冲突。
- 工作区不完整。
- merge 会覆盖本地文件。
- 用户已经授权，但 agent 说“如果你愿意”。
- agent 伪装已审查或已验证。
- agent 把 CLAUDE.md / 星名当成角色卡。
- agent 只抓关键词，立即给最小实现。

---

## 最小实现建议

不要一开始接入主 AgentLoop，不要改 static prompt。

Phase 1 只做：

- `src/prompt/anchor-graph.ts`
- `src/prompt/anchor-invariants.ts`
- `src/prompt/__tests__/anchor-graph.test.ts`

并保持测试小而明确：

- graph has expected anchors。
- graph hash stable。
- INV-1 violation detectable。
- INV-4 cycle_open changed。
- session 内 graph hash stable。

