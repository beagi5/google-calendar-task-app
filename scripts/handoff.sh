#!/usr/bin/env bash
# 外部モデル（Gemini Pro 等）に独立検証を依頼するためのパケットを作る。
#
#   bash scripts/handoff.sh .claude/briefs/20260915-foo.md [base-ref]
#
# 仕様と差分だけを出力する。実装の経緯・会話履歴は一切含めない。
# 外部モデルが実装者の思考を見られないことが、この検証の価値そのもの。

set -euo pipefail

BRIEF="${1:-}"
BASE="${2:-HEAD}"

if [[ -z "$BRIEF" || ! -f "$BRIEF" ]]; then
  echo "usage: bash scripts/handoff.sh <brief-path> [base-ref]" >&2
  echo "例: bash scripts/handoff.sh .claude/briefs/20260915-token-refresh.md main" >&2
  exit 1
fi

OUT="$(mktemp -t handoff.XXXXXX.md)"

{
  echo "以下は、あるコード変更の「仕様」と「実際の差分」です。"
  echo "あなたの仕事は、差分が仕様を満たしているかの判定だけです。"
  echo
  echo "- 修正案やリファクタ提案は書かないでください。"
  echo "- 「たぶん満たしている」と推測せず、差分に根拠がある場合のみ合格としてください。"
  echo "- 仕様に書かれていない変更が差分に含まれていたら、それも指摘してください。"
  echo "- 成功基準が曖昧で判定できない場合は「判定不能」と書いてください。"
  echo
  echo "出力形式: 基準ごとに「合格 / 不合格 / 判定不能」＋根拠となる該当行。"
  echo
  echo "---"
  echo
  echo "# 仕様"
  echo
  cat "$BRIEF"
  echo
  echo "---"
  echo
  echo "# 差分 (base: ${BASE})"
  echo
  echo '```diff'
  git diff "${BASE}" -- . ':(exclude)package-lock.json' ':(exclude)server/package-lock.json'
  echo '```'
} > "$OUT"

echo "書き出しました: $OUT" >&2
echo "行数: $(wc -l < "$OUT")" >&2
echo >&2
cat "$OUT"
