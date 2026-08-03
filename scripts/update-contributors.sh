#!/usr/bin/env bash
# update-contributors.sh — 从 git 历史提取外部贡献者，更新 CONTRIBUTORS.md。
#
# 规则：从 merge commit 提取被合并分支的全部作者，排除仓库拥有者（huiliyi37）。
# 每个作者关联其涉及的 PR 和标题。

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$REPO_DIR/CONTRIBUTORS.md"
OWNER="huiliyi37"

cd "$REPO_DIR"

# 收集所有 merge commit（排除 sync:、Merge remote、Merge branch 等内部合并）
declare -A AUTHOR_PRS

while IFS=$'\t' read -r hash subject; do
  # 只处理 "Merge PR #N" 格式的合并提交
  pr_num=$(echo "$subject" | sed -n 's/.*Merge PR #\([0-9]*\).*/\1/p')
  if [ -z "$pr_num" ]; then continue; fi

  # 取该合并引入的所有 commit 的作者
  while IFS= read -r author; do
    [ -z "$author" ] && continue
    email="${author#*<}"
    email="${email%>}"
    name="${author%% <*}"
    if [ "$name" = "$OWNER" ]; then continue; fi
    key="$name <$email>"
    AUTHOR_PRS["$key"]="${AUTHOR_PRS[$key]:-} #$pr_num"
  done < <(git log --format="%an <%ae>" "$hash"~1.."$hash" | sort -u)
done < <(git log --oneline --format="%H %s" main | grep "^[a-f0-9]* Merge PR #")

cat > "$OUTPUT" <<'HEADER'
# Contributors ✨

感谢以下贡献者（按首次贡献时间排序）：

| GitHub | 贡献 | PR |
|--------|------|-----|
HEADER

for author in "${!AUTHOR_PRS[@]}"; do
  name="${author%% <*}"
  prs="${AUTHOR_PRS[$author]}"
  pr_links=""
  for pr in $prs; do
    pr_num="${pr#\#}"
    pr_links="$pr_links [#$pr_num](https://github.com/huiliyi37/Tianshu-Tui/pull/$pr_num),"
  done
  pr_links="${pr_links%,}"
  # 简单描述：取 PR 标题的前 40 字符
  echo "| **$name** | $pr_links |"
done >> "$OUTPUT"

cat >> "$OUTPUT" <<'FOOTER'

本文件由 `scripts/update-contributors.sh` 自动生成。运行 `bash scripts/update-contributors.sh` 更新。
FOOTER

echo "CONTRIBUTORS.md updated."
