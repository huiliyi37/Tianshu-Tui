// Diagram skeleton templates — layer-3 of the mermaid diagram template library.
// Semantic shapes (layer-1) are baked in; palettes (layer-2) are appended
// separately once the cross-renderer compat test confirms which classDef
// palettes are portable. See docs/superpowers/plans/2026-06-07-mermaid-diagram-template-library.md
//
// Shape vocabulary (renderer-portable, core mermaid syntax):
//   {{hexagon}}   = LLM / model
//   [[subroutine]] = agent / processor
//   [(cylinder)]  = data store / DB
//   {rhombus}     = decision / branch
//   (rounded)     = external input / user
//   [rect]        = plain module
//   ([stadium])   = entry / terminal
// Edge vocabulary: --> sync/read · ==> write/strong · -.-> async/event · --label--> labeled

export type DiagramType =
  | 'architecture'
  | 'dataflow'
  | 'sequence'
  | 'flowchart'
  | 'comparison'
  | 'state'

export interface DiagramTemplate {
  type: DiagramType
  title: string
  /** one-line description for /diagram list */
  desc: string
  /** the mermaid skeleton body (without fences) */
  skeleton: string
}

export const DIAGRAM_TEMPLATES: Record<DiagramType, DiagramTemplate> = {
  architecture: {
    type: 'architecture',
    title: '分层架构图',
    desc: '入口/逻辑/存储分层，语义形状标注角色',
    skeleton: `flowchart TD
    subgraph IN["入口层"]
        E1(用户/外部输入)
        E2([CLI/API 入口])
    end
    subgraph LOGIC["逻辑层"]
        A1[[核心处理器]]
        A2{{LLM/模型}}
        A3{关键决策}
    end
    subgraph STORE["存储层"]
        S1[(主存储)]
        S2[(缓存)]
    end
    E1 --> A1
    E2 --> A1
    A1 --> A2
    A2 --> A3
    A3 -->|命中| S1
    A3 -.异步.-> S2`,
  },
  dataflow: {
    type: 'dataflow',
    title: '数据流图',
    desc: '左→右数据管道，读/写/旁路区分',
    skeleton: `flowchart LR
    SRC(数据源) --> T1[清洗] --> T2[转换] --> T3{{推理}}
    T3 ==> SINK[(落库)]
    T3 -.旁路.-> LOG[(日志)]`,
  },
  sequence: {
    type: 'sequence',
    title: '时序图',
    desc: '参与者间消息往返时序',
    skeleton: `sequenceDiagram
    participant U as 用户
    participant S as 服务
    participant L as LLM
    participant D as 存储
    U->>S: 请求
    S->>D: 读上下文
    D-->>S: 返回
    S->>L: 调用
    L-->>S: 结果
    S->>U: 响应`,
  },
  flowchart: {
    type: 'flowchart',
    title: '决策流',
    desc: '条件分支 + 兜底（最常用）',
    skeleton: `flowchart TD
    START([开始]) --> Q1{条件 A?}
    Q1 -->|是| ACT1[动作 1]
    Q1 -->|否| Q2{条件 B?}
    Q2 -->|是| ACT2[动作 2]
    Q2 -->|否| FALLBACK[兜底]
    ACT1 --> END([结束])
    ACT2 --> END
    FALLBACK --> END`,
  },
  comparison: {
    type: 'comparison',
    title: '并列对比图',
    desc: '两方案并排，特性对照',
    skeleton: `flowchart TB
    subgraph OPT_A["方案 A"]
        direction TB
        A1[特性 1]
        A2[特性 2]
    end
    subgraph OPT_B["方案 B"]
        direction TB
        B1[特性 1]
        B2[特性 2]
    end`,
  },
  state: {
    type: 'state',
    title: '状态机',
    desc: '状态转移 + 起止',
    skeleton: `stateDiagram-v2
    [*] --> 空闲
    空闲 --> 处理中: 收到任务
    处理中 --> 完成: 成功
    处理中 --> 失败: 异常
    失败 --> 空闲: 重试
    完成 --> [*]`,
  },
}

export const DIAGRAM_TYPES = Object.keys(DIAGRAM_TEMPLATES) as DiagramType[]

export function isDiagramType(s: string): s is DiagramType {
  return (DIAGRAM_TYPES as string[]).includes(s)
}

/** Render a template as a complete fenced mermaid block ready to drop into markdown. */
export function renderDiagramBlock(type: DiagramType): string {
  const t = DIAGRAM_TEMPLATES[type]
  return '```mermaid\n' + t.skeleton + '\n```'
}

/** Build the full markdown file content for a /diagram emit. */
export function buildDiagramDoc(type: DiagramType): string {
  const t = DIAGRAM_TEMPLATES[type]
  return `# ${t.title}（${type}）

> 由 /diagram 生成的骨架。替换节点文字即可。在 VSCode/GitHub/Obsidian 打开本文件查看渲染。
> 形状语义：{{六边形}}=LLM · [[子程序]]=Agent · [(圆柱)]=存储 · {菱形}=决策 · (圆角)=输入 · [矩形]=模块 · ([体育场])=入口

${renderDiagramBlock(type)}
`
}

/** Format the /diagram list output. */
export function formatDiagramList(): string {
  const lines = DIAGRAM_TYPES.map((k) => {
    const t = DIAGRAM_TEMPLATES[k]
    return `  ${k.padEnd(13)} — ${t.title}：${t.desc}`
  })
  return `可用图型（/diagram <type>）：\n${lines.join('\n')}`
}
