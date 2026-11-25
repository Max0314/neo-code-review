"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const runFile = promisify(execFile);

const referenceFiles = [
  "ordinary-review.md",
  "ordinary-baseline.json",
  "ocr-review.md",
  "scoring.md",
];

function reviewTarget(message) {
  const instructions = typeof message.instructions === "string" ? message.instructions.trim() : "";
  const commit = /^--commit\s+([a-f0-9]{40})$/i.exec(instructions);
  if (commit) return { type: "commit", sha: commit[1].toLowerCase() };
  return instructions ? { type: "custom", instructions } : { type: "uncommittedChanges" };
}

function loadSkill() {
  const root = path.resolve(process.env.NEOCODER_HOME || path.join(os.homedir(), ".neocoder"), "skills", "neo-code-review");
  const body = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
  const references = referenceFiles.map((name) => "## " + name + "\n" + fs.readFileSync(path.join(root, "references", name), "utf8"));
  return { root, content: [body, ...references].join("\n\n") };
}

function scopeInstructions(target) {
  if (target.type === "commit") {
    return "审查固定提交 " + target.sha + "。用 git show 检查本提交及其父版的真实代码，按原评审范围读取。";
  }
  if (target.type === "custom") return "沿用原审查范围和要求：" + target.instructions;
  return "沿用原入口的未提交变更范围，包括暂存、未暂存及未跟踪。";
}

function buildFollowupInstructions(target, original, skill, sources) {
  return [
    "这是自动触发的公司规则追评，原普通评审已完成。保持只读；原结果由宿主原样保留。本轮只输出新增可核实的问题、同根因的补充证据和待确认事项。同一根因不得重复计分。",
    scopeInstructions(target),
    "先核对变更。如果改动的失败分支新增清空、覆盖或回滚行为，先执行 Skill 的独立失败路径核对。沿真实调用点核对把底层失败转成异常或返回值的源码，以及状态消费者。使用宿主标明版本的实读材料，缺决定性实现时用实际工具补读。提交审查固定到同一 SHA。",
    "按原生评审输出格式给新增发现，并在 overall_explanation 说明采用的规则和覆盖缺口。已核实且适用时，使用 Skill 的本地计分说明。评分脚本所在地：" + path.join(skill.root, "scripts", "score_review.py"),
    "--- 本地 Skill 与规则 ---\n" + skill.content,
    ...(sources.length ? ["--- 宿主从固定 Git 对象补读的材料 ---\n" + sources.join("\n\n")] : []),
    "--- 原评审（只作去重和证据补充） ---\n" + original,
  ].join("\n\n");
}

function rememberSourceReads(entry, item) {
  if (entry.target.type !== "commit" || item?.type !== "commandExecution" || item.exitCode !== 0) return;
  const command = String(item.command || "");
  if (!/\b(?:Get-Content|git\s+show|rg)\b/i.test(command)) return;
  for (const part of command.split(";")) {
    const start = Number(/-Skip\s+(\d+)/i.exec(part)?.[1] || 0);
    const count = Math.min(Number(/-First\s+(\d+)/i.exec(part)?.[1] || 90), 120);
    for (const match of part.matchAll(/(?:^|[\s'":])([\w.-]+(?:[\\/][\w.-]+)+\.(?:[cm]?[jt]sx?|py|go|java|rs|cs|cpp|c|h))(?=$|[\s'"|])/gi)) {
      const file = match[1].replaceAll("\\", "/");
      if (file.split("/").some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) continue;
      const windows = entry.sourceReads.get(file) || [];
      if (windows.length === 0 && entry.sourceReads.size >= 6) continue;
      if (windows.length < 3 && !windows.some((window) => window.start === start)) {
        windows.push({ start, count });
        entry.sourceReads.set(file, windows);
      }
    }
  }
}

async function readCommitSources(provider, entry) {
  if (entry.target.type !== "commit" || !entry.workspace) return [];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_CONFIG_(?:COUNT|(?:KEY|VALUE)_\d+)$/i.test(key)));
  const options = { cwd: entry.workspace, env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 5000, windowsHide: true };
  const head = entry.target.sha;
  const diff = runFile("git", ["--no-pager", "show", "--format=", "--no-ext-diff", "--no-textconv", "--unified=3", head, "--"], options)
    .then(({ stdout }) => "### 固定提交差异 @ " + head + "\n" + stdout.slice(0, 30000) + (stdout.length > 30000 ? "\n[差异材料截断]" : ""))
    .catch(() => null);
  const results = await Promise.all([...entry.sourceReads].map(async ([file, windows]) => {
    try {
      const { stdout } = await runFile("git", ["--no-pager", "show", head + ":" + file], options);
      const lines = stdout.split(/\r?\n/);
      const selected = new Set();
      for (const { start, count } of windows) {
        for (let i = start; i < Math.min(start + count, lines.length); i++) selected.add(i);
      }
      const material = [...selected].sort((a, b) => a - b).map((i) => (i + 1) + ": " + lines[i]).join("\n");
      if (!material) return null;
      provider.outputChannel?.appendLine("[neocoder] company review source: " + file + " @ " + head);
      return "### " + file + " @ " + head + "\n" + material.slice(0, 14000);
    } catch {
      return null;
    }
  }));
  return [await diff, ...results].filter(Boolean);
}

function update(view, entry, status, fields) {
  view?.webview.postMessage({
    type: "reviewItemUpdate",
    value: { requestedAt: entry.requestedAt, status, ...fields },
  });
}

function failReview(view, entry, detail) {
  if (entry.original !== undefined) {
    update(view, entry, "success", { reviewText: entry.original + "\n\n> 公司规则追评未完成：" + detail });
  } else {
    update(view, entry, "error", { errorMessage: detail });
  }
}

async function startCodeReview(provider, message) {
  const requestedAt = typeof message.requestedAt === "number" ? message.requestedAt : Date.now();
  const threadId = provider.currentStatusThreadId();
  const entry = {
    requestedAt, threadId, target: reviewTarget(message), phase: "original",
    workspace: provider.getWorkspaceRootPath?.(), sourceReads: new Map(),
  };
  const view = provider.view;
  view?.webview.postMessage({
    type: "reviewStarted",
    value: { requestedAt, hint: "正在进行原评审…" },
  });
  if (!threadId) {
    failReview(view, entry, "当前会话尚未启动 thread，请先发送一条消息");
    return;
  }
  try {
    const response = await provider.client.request("review/start", {
      threadId,
      target: entry.target,
      delivery: "inline",
    });
    if (!response?.turn?.id) throw new Error("评审请求缺少回合标识");
    if (provider.currentStatusThreadId() !== threadId) {
      failReview(view, entry, "评审期间会话已切换");
      return;
    }
    provider.inflightReviewsByTurn.set(response.turn.id, entry);
  } catch (error) {
    failReview(view, entry, error?.code === -32601 ? "当前服务不支持 /review" : String(error?.message || error));
  }
}

async function advanceReview(provider, turnId, entry) {
  entry.phase = "starting";
  try {
    const skill = loadSkill();
    const sources = await readCommitSources(provider, entry);
    if (provider.inflightReviewsByTurn.get(turnId) !== entry) return;
    const response = await provider.client.request("review/start", {
      threadId: entry.threadId,
      delivery: "inline",
      target: { type: "custom", instructions: buildFollowupInstructions(entry.target, entry.original, skill, sources) },
    });
    if (provider.inflightReviewsByTurn.get(turnId) !== entry) return;
    if (!response?.turn?.id) throw new Error("追评请求缺少回合标识");
    provider.inflightReviewsByTurn.delete(turnId);
    entry.phase = "followup";
    provider.inflightReviewsByTurn.set(response.turn.id, entry);
  } catch (error) {
    if (provider.inflightReviewsByTurn.get(turnId) !== entry) return;
    provider.inflightReviewsByTurn.delete(turnId);
    provider.outputChannel?.appendLine("[neocoder] company review follow-up could not start");
    failReview(provider.view, entry, error?.code === "ENOENT" ? "未找到已安装的公司评审 Skill" : "追评请求启动失败");
  }
}

function reviewNotification(provider, message) {
  const { method, params = {} } = message;
  if (!["item/completed", "turn/completed", "error"].includes(method)) return;
  const turnId = params.turn?.id || params.turnId || (params.item?.type === "exitedReviewMode" ? params.item.id : null);
  const entry = provider.inflightReviewsByTurn.get(turnId);
  if (!entry || params.threadId !== entry.threadId) return;

  const item = params.item;
  if (method === "item/completed" && entry.phase === "original") rememberSourceReads(entry, item);
  if (method === "item/completed" && item?.type === "exitedReviewMode") {
    if (!item.review?.trim()) return;
    if (entry.phase === "original") {
      entry.original = item.review;
      update(provider.view, entry, "success", { reviewText: entry.original + "\n\n> 正在追加公司规则追评…" });
    } else if (entry.phase === "followup") {
      provider.inflightReviewsByTurn.delete(turnId);
      update(provider.view, entry, "success", { reviewText: entry.original + "\n\n## 公司规则追评\n\n" + item.review });
    }
    return;
  }

  if (method === "error" && !params.willRetry) {
    provider.inflightReviewsByTurn.delete(turnId);
    failReview(provider.view, entry, entry.phase === "original" ? params.error?.message || "原评审失败" : "公司规则追评失败");
  } else if (method === "turn/completed" && entry.phase !== "starting") {
    if (entry.phase === "original" && entry.original !== undefined && params.turn?.status === "completed") {
      void advanceReview(provider, turnId, entry);
    } else {
      provider.inflightReviewsByTurn.delete(turnId);
      failReview(provider.view, entry, "该回合未返回完整评审结果");
    }
  }
}

module.exports = { failReview, reviewNotification, startCodeReview };
