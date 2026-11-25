# 本地计分

先完成证据与规则裁决，再把问题 ID、参与文件、覆盖状态和必要计分参数交给 `scripts/score_review.py`。脚本使用 Python 标准库，接受 UTF-8 JSON 文件或标准输入，返回 JSON。使用 Skill 自己的绝对路径定位脚本，评审仓库不需要安装依赖或写入中间文件。计分输入无需传入源码、凭据、员工身份或完整策略。

```text
python <skill-dir>/scripts/score_review.py [input.json]
```

```json
{
  "scope_complete": true,
  "files": [
    {
      "path": "src/checkout.py",
      "action": "review_score",
      "coverage_complete": true,
      "findings": [
        {"id": "F1", "severity": "WARNING", "evidence_quality": "strong", "base_deduct": 7}
      ]
    },
    {"path": "generated/schema.json", "action": "review_no_score"}
  ],
  "ocr": {
    "coverage_complete": true,
    "independent_review_complete": true,
    "findings": [
      {"id": "F1", "classification": "code_supported", "attribution": "introduced", "severity": "general"}
    ]
  }
}
```

本例普通分和普通文件分均为 92，OCR 本地参考分也为 92，两者依据各自的算法。

## 普通预估分

- `scope_complete` 表示整笔范围清单已核实。所有变更文件各有一条记录，使用仓库相对路径并统一分隔符。文件的 `action` 为 `review_score`、`review_no_score`、`skip` 或 `unknown`。参与文件用 `coverage_complete` 标识已查完。发现数组仅传已核实且适用规则允许计分的问题，同根因 ID 在参与文件中只出现一次。待确认发现仍在报告中。
- 默认等级范围为 FATAL 50–70、ERROR 30–40、WARNING 5–15、REMIND 1–8。先把单项基础扣分夹到对应范围，然后乘 weak 0.8、normal 1.0 或 strong 1.2，按 Python `round` 取整，再夹到同一范围。省略 `base_deduct` 时使用该级最低值；选择更高基础扣分时应能指出具体影响或政策依据。若已有可信已发布 `scorePolicy`，把其中的 `no_issue_score`、`severity_bounds`、`evidence_factor` 作为顶层 `score_policy` 传入，只覆盖提供的参数。
- 删除文件，或至少删除 10 行且删除数至少是新增数的两倍、占增删总行数至少 70%，属于删除为主。如果该文件缺明确跨文件调用或实现锚点，给参与文件传 `"delete_guard": true`。对已有可计分的发现，严重和致命级降到 WARNING 并把单项扣分限制到 5–10。文件总扣分上限为 10。没有达到证据要求的风险仍不传入。
- 已查完的参评文件无可计分发现时为 95（可由策略覆盖）。有发现时取 `100 - 扣分总和`，普通场景限制在 0–94，删除约束按上条计算。所有参评文件分数算术平均，四舍五入取整。清单或文件参与状态不明、存在未评完参评文件时不给整笔分；无参评文件也不出分。上述结果是本次变更范围的本地试算。

## OCR 本地参考分

按需提供 `ocr` 段。只有全范围调查和独立复核都完成才给整笔分。`classification` 支持 `code_supported`、`needs_confirmation`、`unfinished`、`excluded`。其中 `code_supported` 仅在 `attribution` 为 `introduced`、且有有效严重度时纳入。已存在问题用 `preexisting`，待确认或未完成候选使整笔分暂缺。

从 100 减去最高档对应的扣分。有阻断时扣 55，其他阻断每项加 5、严重每项加 3、一般最多加 2，附加合计最多 10。有严重且无阻断时扣 35，其他严重每项加 5、一般每项加 2（一般合计最多 4），附加合计最多 10。只有一般及以下时，一般扣 8，每多一项一般加 2（附加最多 4）。仅轻微得 94，完整且无可扣分发现得 95。
