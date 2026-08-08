---
name: cli-harness-sop
description: "把只为人设计的 GUI/复杂 CLI 软件包装成 agent 可用的 stateful CLI 的七阶段 SOP——识别后端引擎、操作原生格式、调真实软件渲染、程序化验证输出、按安全契约围栏。当需要让 agent 无显示器/鼠标操作桌面软件（LibreOffice/Blender/GIMP/Inkscape/视频编辑器等）时使用：现场搭 harness，不重写软件。"
triggers: ['cli.?harness|cli-anything|把.*包装成.*cli|无头.*软件|headless.*software|GUI.*to.*CLI|包装.*桌面软件|agent.*操作.*软件|harness.*sop|造一个.*cli|stateful.?cli|wrapping.*gui|backend.?engine|原生格式|native.?format']
---

# CLI Harness SOP — 现场包装复杂 CLI/GUI 软件

你在为**只为人设计的软件**搭一个 agent 可用的命令行壳。核心立场：**CLI 是通往软件的接口，不是软件的替代品**——所有渲染/导出必须调用真实软件，你只负责生成合法中间文件、调度、验证。全程遵守安全契约（见下），因为执行命令的 agent 可能基于不可信输入（用户提示、上传文件）自主构造参数。

## 铁律（不可协商）

1. **用真实软件，别重实现**。渲染/导出必须调用软件的 CLI/脚本接口（`libreoffice --headless`、`blender --background`、`gimp -i -b`、`melt`、`inkscape --actions`、`sox`、MCP server）。用 Pillow 重写 GIMP、手写 PDF 引擎替代 LibreOffice 都是反模式——产物是玩具，且与真实行为发散。**软件是硬依赖**：未安装时报错并给安装指引，绝不 graceful degradation 到 fallback 库。
2. **防渲染缺口**。GUI app 在渲染期应用效果；naive 渲染（如 ffmpeg concat 直接拼原始媒体）会**静默丢掉项目级效果**，输出与输入无异。渲染优先级：native 引擎 → 效果翻译层（项目格式效果 → 渲染工具语法）→ 生成手跑脚本。
3. **安全契约七条**（SECURITY.md 浓缩，见「安全契约」节）：不 shell=True、参数过 allowlist、用户内容转义、路径 abspath/realpath 围栏、不落日志 API key、敏感文件名拒绝、破坏性操作需确认。

## 七阶段 SOP

### Phase 1: 代码库分析

1. **找后端引擎**——GUI 多把展示与逻辑分离。定位核心库（Shotcut→MLT、GIMP→ImageMagick）。
2. **把 GUI 动作映射为 API 调用**——每个按钮/拖拽/菜单项对应一个函数调用，编目映射表。
3. **识别数据模型**——用什么文件格式？项目状态如何表示（XML/JSON/二进制/数据库）？
4. **找现成 CLI 工具**——`melt`、`ffmpeg`、`convert` 等是积木，直接复用。
5. **编目 command/undo 系统**——有 undo/redo 说明用了 command pattern，这些命令就是你的 CLI 操作。

### Phase 2: CLI 架构设计

1. **交互模型**：Stateful REPL（agent 保上下文的交互会话）／ Subcommand CLI（一次性操作/脚本）／ **两者兼有（推荐）**。
2. **命令组**按逻辑域划分：项目管理（new/open/save/close）· 核心操作 · 导入/导出（文件 IO、格式转换）· 配置（settings/profiles）· 会话/状态（undo/redo/history/status）。
3. **状态模型**：命令间须持久化什么（打开的项目、光标、选区）？存内存还是文件？序列化成 JSON session。
4. **输出格式**：人类可读（表格/颜色）给交互，机器可读（JSON）给 agent，`--json` flag 切换。**每个命令都必须支持 `--json`**。

### Phase 3: 实现

按序推进，每层可独立验证：

1. **数据层**——直接解析/修改原生项目文件（MLT XML、ODF、SVG、.blend）。
2. **probe/info 命令**——`info`/`list`/`status` 让 agent 改动前先了解现状。agent 自纠错依赖无歧义输出。
3. **mutation 命令**——每个逻辑操作一个命令，尽量幂等（同一命令跑两次安全）。破坏性操作（覆盖/删除/清空）提供 dry-run 或确认提示，`--yes` 才真正执行。
4. **后端集成** `utils/<软件>_backend.py`：
   ```python
   def convert_odf_to(odf_path, output_format, output_path=None, overwrite=False):
       lo = find_libreoffice()  # shutil.which(); 找不到则 raise RuntimeError 附安装指引
       subprocess.run([lo, "--headless", "--convert-to", output_format, ...])  # 参数列表，绝不 shell=True
       return {"output": final_path, "format": output_format, "method": "libreoffice-headless"}
   ```
5. **渲染/导出**——先生成合法中间文件，再交给真实软件转换。**失败要响亮清晰**，agent 才能自纠。
6. **会话管理**——状态持久化 + undo/redo。session JSON 保存用**排他文件锁**（`open("r+")` → lock → 锁内 truncate），防并发写坏。
7. **REPL（统一皮肤）**——把 `repl_skin.py` 复制进 `utils/`，用 `ReplSkin` 做 banner/提示/帮助/消息；Click 主组 `invoke_without_command=True`，无子命令时进 REPL（`cli-anything-<软件>` 裸跑进交互）。
8. **MCP 后端模式**（软件无原生 CLI 但有 MCP server，如 DOMShell 浏览器自动化、obs-websocket）——用 MCP 客户端把工具包装成 CLI 命令：daemon 启动/复用、按工具域分组命令、会话状态管理。判定时机：无原生 CLI、软件暴露 MCP server、需要 agent 原生工具集成。

### Phase 4: 测试规划（TEST.md 第一部分）

**写任何测试代码前**，在 `tests/` 下建 `TEST.md`，必须含：

1. **测试清单计划**——计划文件与预估用例数（`test_core.py: XX 单测`、`test_full_e2e.py: XX E2E`）。
2. **单元测试计划**——每个核心模块：测哪些函数、哪些边界（非法输入/边界/错误处理）、预期用例数。
3. **E2E 测试计划**——模拟哪些真实工作流、生成/处理哪些真实文件、验证哪些输出属性、做什么格式校验。
4. **真实工作流场景**——逐个多步流程：名称 / 模拟什么现实任务 / 链式操作步骤 / 验证哪些输出属性。参考：多段剪辑、蒙太奇拼合、画中画、调色流水线、音频混音、重度 undo/redo、复杂项目存/读往返、迭代精修。

### Phase 5: 测试实现

四层互补，**缺一不可**：

1. **单元测试**（`test_core.py`）——合成数据、无外部依赖、隔离测每个函数。
2. **E2E · 中间文件**（`test_full_e2e.py`）——验证你的 CLI 生成的项目文件结构正确（合法 XML、ZIP 结构等）。
3. **E2E · 真实后端**（`test_full_e2e.py`）——**必须调用真实软件**产出最终文件（PDF/DOCX/渲染图/视频）：
   - 文件存在且 size > 0（防"可疑地小"）
   - 格式正确（PDF magic bytes `%PDF-`、DOCX/XLSX/PPTX 是合法 ZIP/OOXML）
   - 内容可验则验（CSV 含预期数据）
   - **打印产物路径**供人工检视：`print(f"\n  PDF: {path} ({size:,} bytes)")`
   - **无 graceful degradation**：软件没装，测试失败（fail）而非跳过（skip）。
4. **CLI subprocess 测试**——以真实用户/agent 的方式调已安装命令。用 `_resolve_cli`（`shutil.which` 命中用已装命令，否则回退 `python -m`；设 `CLI_ANYTHING_FORCE_INSTALLED=1` 强制要求已装命令）。subprocess 测试**不设 `cwd`**——已装命令必须从任意目录可运行，硬编码工作目录会掩盖安装缺陷。E2E 必须产出**真实最终输出**（不只中间文件）。
5. **Round-trip 测试**——CLI 建项目 → 真实 GUI 打开验证正确性（项目能被软件接受、状态一致）。
6. **Agent 测试**——让 AI agent 只用该 CLI 完成一个真实任务，验证命令面自足（`info`/`status` 内省够用、错误可自纠）。

**输出验证不因 exit 0 就信**——程序化验证：magic bytes/文件格式；OOXML 查 ZIP 结构；视频/图像做像素级分析（ffmpeg probe 特定帧：首帧查淡入近黑、中帧查效果亮度/饱和度、末帧查淡出近黑；**跨分辨率比像素先排除 letterbox/pillarbox 黑边**——竖屏视频在横屏框里约 40% 黑像素）；音频查首尾 RMS 淡入淡出、与源谱对比；时长/格式对照期望值。

跑测试：`CLI_ANYTHING_FORCE_INSTALLED=1 python3 -m pytest cli_anything/<软件>/tests/ -v -s`（`-s` 显示 `[_resolve_cli]` 确认用的哪个后端，并打印产物路径）。

### Phase 6: 测试文档（TEST.md 第二部分）

全绿后**追加**到既有 TEST.md：完整 `pytest -v --tb=no` 输出（含用例名与状态）· 统计（总数/通过率/耗时）· 覆盖缺口说明。TEST.md 最终同时是计划（实现前写）与结果记录（执行后追加）。

### Phase 6.5: SKILL.md 生成

让 agent 能发现并使用该 CLI 的自包含技能定义（frontmatter + 正文）：

```yaml
---
name: "cli-anything-<软件>"
description: "Brief description of what the CLI does"
triggers: ['cli.?anything.?<软件>', '无头.*<软件>', 'headless.*<软件>']
---
```

frontmatter 三字段（`name`/`description`/`triggers`）对齐仓库 skill-loader 的 `SkillDefinition` 契约——`triggers` 是触发词正则列表，缺了它技能只能靠 `/skill <name>` 手动调，无法被 agent 自动发现。

正文必须：安装前置 · 命令组清单及简述 · 真实工作流示例 · agent 使用指引（`--json` 输出、错误处理）。**自包含**——理解它不依赖外部文件。支持 preview 时，producer（`cli-anything-<软件> preview ...`）与 consumer（`cli-hub previews ...`，只读检视/打开，**不是渲染路径**）分开文档化。SKILL.md 的正典位置在 `skills/cli-anything-<软件>/SKILL.md`，同时打包一份进 `cli_anything/<软件>/skills/`；REPL banner 打印技能文件绝对路径，agent 可读它了解全量能力。

### Phase 7: 发布安装

按 **PEP 420 namespace package** 打进共享 `cli_anything` 命名空间：`cli_anything/` **没有** `__init__.py`（多包可共存），每个子包 `<软件>/` **有** `__init__.py`。`setup.py` 用 `package_data` 打包 `skills/*.md`，让技能随 pip 分发。**README 同步产出**（对齐交付清单）：含安装（`pip install` / 从源码装）、测试（`CLI_ANYTHING_FORCE_INSTALLED=1 pytest ...`）、用法（至少一个真实工作流示例）三节。

## Preview 契约（支持 preview 的 harness 必须一致）

Preview 支持可选，但一旦暴露中间可视/检视状态，必须遵循统一契约，agent 与人类才能跨软件推理。

- **producer/consumer 分离**：producer（`cli-anything-<软件> preview ...`）调真实后端、拥有 preview recipes/捕获/直播发布；consumer（`cli-hub previews ...`）只读检视/打开（inspect/html/watch/open），**不是渲染路径**。帮助文本、README、SKILL 示例不得把 `cli-hub previews` 当渲染路径。
- **推荐命令面**：至少 `preview recipes` / `preview capture` / `preview latest`；语义合宜时加 `preview diff`、`preview live start/push/status/stop`。`preview capture` 渲染新 bundle（除非缓存复用有效）；`preview latest` 只返回最新既有 bundle 不重渲染；`preview live status` 是只读探针。
- **三层持久化**：`bundle_dir`（不可变快照，`preview-bundle/v1`）· `session.json`（可变当前 head）· `trajectory.json`（append-only 命令→预览历史）。`_bundle_dir` 只是单次快照路径，**不是**长期构建身份——稳定回放锚定 `session_dir` + `trajectory.json`。
- **agent 便宜自省**：所有 preview 命令支持 `--json`，输出稳定路径（`_bundle_dir`/`_manifest_path`/`summary_path`）、产物相对路径、会话/轨迹元数据；`preview live status --json` 必须带紧凑 `trajectory_summary`，让 agent 不必读 trajectory 文件。
- **truthfulness 原则**：预览产物必须由真实后端或对真实项目/捕获状态的原生检视/导出路径产出——不截屏、不 Python 假渲染；注入临时相机/灯光/辅助 rig 时在 summary/context 标注状态与限制。诚实预览胜过漂亮预览。
- **文档**：README.md 与 SKILL.md 都写 preview 是否存在、模式（static/diff/live/poll）、producer 命令、consumer 命令、产物类型、对本软件为何真实，配 publish + inspect/watch 两步示例。

## 目录结构（对齐 HARNESS 标准骨架）

`cli_anything/` **没有** `__init__.py`（PEP 420 namespace 包，多 harness 可共存）；每个子包 `<软件>/` **有** `__init__.py`。

```
<软件>/agent-harness/
├── <软件>.md              # 该软件专项分析与 SOP
├── setup.py               # PyPI 打包配置（Phase 7）
├── cli_anything/          # namespace 包——绝无 __init__.py
│   └── <软件>/            # 本 CLI 子包
│       ├── __init__.py
│       ├── __main__.py    # python3 -m cli_anything.<软件>
│       ├── README.md      # 必含：装软件依赖/装 CLI/跑测试/基本用法
│       ├── <软件>_cli.py  # 主入口（Click + REPL）
│       ├── core/          # 每逻辑域一个模块
│       │   ├── __init__.py
│       │   ├── project.py # 项目 create/open/save/info
│       │   ├── export.py  # 渲染管线 + filter 翻译层
│       │   └── session.py # stateful 会话、undo/redo
│       ├── utils/
│       │   ├── __init__.py
│       │   ├── <软件>_backend.py  # 调真实软件的后端
│       │   └── repl_skin.py       # 统一 REPL 皮肤（从插件复制）
│       └── tests/
│           ├── TEST.md          # 必含：先计划后结果
│           ├── test_core.py     # 单元测试（合成数据）
│           └── test_full_e2e.py # E2E（真实文件 + 真实后端）
└── examples/              # 示例脚本与工作流
```

多包共存的关键：`cli-anything-gimp` 贡献 `cli_anything/gimp/`、`cli-anything-blender` 贡献 `cli_anything/blender/`，各自独立 pip 安装后在同一 Python 环境里不冲突。

## 常见软件后端速查（Phase 1「找后端引擎」直查表）

模式恒定：**建数据 → 调真实软件 → 验证输出**。软件是必需依赖，不是可选项。

| 软件 | 后端 CLI | 原生格式 | harness 用法 |
|------|----------|----------|-------------|
| LibreOffice | `libreoffice --headless` | .odt/.ods/.odp（ODF ZIP） | 生成 ODF → 转 PDF/DOCX/XLSX/PPTX |
| Blender | `blender --background --python` | .blend-cli.json | 生成 bpy 脚本 → Blender 渲染 PNG/MP4 |
| GIMP | `gimp -i -b '(script-fu ...)'` | .xcf | Script-Fu 命令 → GIMP 处理导出 |
| Inkscape | `inkscape --actions="..."` | .svg（XML） | 操纵 SVG → Inkscape 导出 PNG/PDF |
| Shotcut/Kdenlive | `melt` / `ffmpeg` | .mlt（XML） | 构建 MLT XML → melt/ffmpeg 渲染视频 |
| Audacity | `sox` | .aup3 | 生成 sox 命令 → sox 处理音频 |
| OBS Studio | `obs-websocket` | scene.json | WebSocket API → OBS 录制/直播 |
| 浏览器（DOMShell） | MCP（`npx @apireno/domshell`） | Accessibility Tree（虚拟 FS） | MCP 工具 → DOMShell → 文件系统导航 |

无原生 CLI 但有 MCP server 的软件 → 走 Phase 3.8 MCP 后端模式，同一张表的「后端 CLI」列换成 MCP server。

## 安全契约（SECURITY.md 浓缩）

**威胁模型**：agent 可能基于不可信输入（用户提示、上传文件、别的 agent 输出）自主构造并执行命令——输入验证是关键，防 prompt 注入的参数直达软件后端。

| 攻击面 | 风险 | 缓解 |
|--------|------|------|
| Subprocess 参数 | 恶意 codec/路径/filter 参数传给 melt/ffmpeg/gimp | 调 subprocess 前过 **allowlist** |
| 脚本注入 | 用户字符串嵌入 GIMP Script-Fu 批处理脚本 | `_script_fu_escape()` |
| XML/SVG 内容 | 用户文本注入 MLT XML / SVG / Draw.io | `xml_escape()` / ElementTree 自动转义 |
| 路径穿越 | agent 控制输出路径写到任意位置 | `os.path.abspath()` 规范化 |
| 凭据暴露 | API key 明文存配置文件 | 文件权限 `0o600` |
| 敏感文件命名 | session/配置落盘命名成 `.env`/`credentials.*`/`*key*`/`*token*`，被守护进程或同步误扫 | 落盘文件名避开敏感词，不产出此类文件（对齐 SECURITY.md 敏感文件拒绝清单） |
| 破坏性命令 | agent 自主触发覆盖/删除/清空项目状态 | mutation 破坏性操作需显式确认或 dry-run，`--yes` 才真正执行 |

**开发七条**（每条 harness 必须遵守）：

1. `subprocess.run()` **绝不 `shell=True`**——参数永远以列表传。
2. **所有 subprocess 参数过 allowlist**，用户可控字符串不得直通外部工具（如 melt 的 `ALLOWED_VCODECS`/`ALLOWED_ACODECS` frozenset，不在表内 raise `ValueError`；`extra_args` 不许含 `vcodec=`/`acodec=`/`-consumer` 前缀）。
3. **用户内容先转义**再嵌脚本（Script-Fu/Python/Lua）或结构化格式（XML/SVG/HTML）。
4. **所有文件路径 `os.path.abspath()`**；敏感写操作再 `os.path.realpath()` 解析 symlink。
5. **绝不 log/echo API key**（错误消息、JSON 输出都不行）。
6. **不产出敏感命名文件**：session/配置/日志落盘文件名避开 `.env`、`credentials.*`、`*key*`、`*token*`（对齐 SECURITY.md 敏感文件拒绝清单），避免被守护进程/同步误扫。
7. **破坏性操作需确认**：覆盖、删除、清空类 mutation 默认 dry-run 或提示确认，`--yes` 才真正执行。

## 常见陷阱速查

- **渲染缺口**：项目级效果在渲染期被 naive 工具静默丢弃。优先级：native 引擎 → 翻译层 → 手跑脚本。
- **filter 翻译**（MLT→ffmpeg）：注意重复 filter 合并、交错流顺序、参数尺度差异、不可映射效果——每个注册表里的效果**必须有对应渲染映射**，或显式标注"project-only（不渲染）"。
- **时间码精度**：非整数帧率（29.97fps）累计取整误差——用 `round()` 不用 `int()`、显示用整数运算、容忍 ±1 帧。
- **preview 三层持久化**：`bundle_dir`（不可变快照，`preview-bundle/v1`）· `session.json`（可变当前 head）· `trajectory.json`（append-only 命令→预览历史）。`_bundle_dir` 只是单次快照路径，**不是**长期构建身份——稳定回放锚定 `session_dir` + `trajectory.json`。`preview live status --json` 应带紧凑 `trajectory_summary`，让 agent 不必读 trajectory 文件。
- **preview 不截屏**：预览产物必须由真实后端或对真实项目/捕获状态的原生检视/导出路径产出。

## 交付清单

- [ ] 真实软件是硬依赖，渲染/导出全部调用它，零重实现
- [ ] 每个命令支持 `--json`；有 `info`/`list`/`status` 内省命令
- [ ] 命令幂等、错误响亮清晰、REPL 是默认行为（统一 ReplSkin）
- [ ] 安全七条逐条核对（无 shell=True、allowlist、转义、路径围栏、不落 key、敏感文件名拒绝、破坏性操作确认）
- [ ] TEST.md 先计划后结果；四层测试齐全且真实后端 E2E 全绿（无 skip 降级）
- [ ] 输出程序化验证（magic bytes/结构/像素/音频），产物路径已打印
- [ ] SKILL.md 自包含、随包分发、banner 给出路径；README 含安装/测试/用法
- [ ] 目录结构对齐标准骨架（`cli_anything/` 无 `__init__.py`、core/utils/tests 分层、README/TEST.md 必含）
