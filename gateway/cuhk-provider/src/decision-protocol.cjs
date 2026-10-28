"use strict";

const crypto = require("node:crypto");
const { ProtocolError } = require("./errors.cjs");
const { parseToolCall } = require("./protocol.cjs");

const DECISION_VERSION = 1;
const DECISION_ENVELOPE = /^\s*<agent_decision>\s*([\s\S]*?)\s*<\/agent_decision>([\s\S]*)$/u;
const FENCED_DECISION = /^\s*(`{3,})([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)\r?\n\1([\s\S]*)$/u;
const DECISION_FENCE_LANGUAGES = new Set(["cuhk-decision", "cuhk_decision", "agent_decision"]);
const MAX_REASON_CHARS = 2000;
const MAX_FEEDBACK_CHARS = 4000;
const MAX_EVIDENCE_ITEMS = 32;
const MAX_EVIDENCE_CHARS = 2000;

function decisionLanguage(profile = {}) {
  return ["glm", "deepseek", "kimi", "seed"].includes(profile.toolPromptStyle) ? "zh" : "en";
}

function boundedString(value, name, maximum, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ProtocolError(`Agent decision ${name} is required.`);
    return "";
  }
  if (typeof value !== "string") throw new ProtocolError(`Agent decision ${name} must be a string.`);
  const text = value.trim();
  if (required && !text) throw new ProtocolError(`Agent decision ${name} is required.`);
  if (text.length > maximum) throw new ProtocolError(`Agent decision ${name} is too long.`);
  return text;
}

function normalizeEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_ITEMS) {
    throw new ProtocolError(`Agent decision evidence must be an array of at most ${MAX_EVIDENCE_ITEMS} strings.`);
  }
  return value.map((item, index) => boundedString(item, `evidence[${index}]`, MAX_EVIDENCE_CHARS, true));
}

function firstJsonObjectEnd(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseDecisionObject(payload) {
  const cleaned = cleanDecisionPayload(payload);
  try { return JSON.parse(cleaned); }
  catch {
    // Huge hand-composed tool payloads occasionally gain one stray closing
    // brace at the boundary. Recover the first complete JSON object only when
    // the remaining text is exactly that one brace; any other trailing text is
    // still rejected. Catalog/schema validation runs on the recovered object.
    const end = firstJsonObjectEnd(cleaned);
    const rest = end >= 0 ? cleaned.slice(end + 1).trim() : "";
    if (end < 0 || (rest !== "" && rest !== "}")) {
      throw new ProtocolError("Agent decision envelope contains invalid JSON.");
    }
    try { return JSON.parse(cleaned.slice(0, end + 1)); }
    catch { throw new ProtocolError("Agent decision envelope contains invalid JSON."); }
  }
}

function parseDecisionJson(payload) {
  const value = parseDecisionObject(payload);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("Agent decision envelope must contain a JSON object.");
  }
  if (value.version !== DECISION_VERSION) throw new ProtocolError(`Agent decision version must be ${DECISION_VERSION}.`);
  if (!["tool", "final", "blocked"].includes(value.decision)) {
    throw new ProtocolError("Agent decision must be tool, final, or blocked.");
  }
  return value;
}

function cleanDecisionPayload(payload) {
  // The school renderer occasionally leaks its internal argument wrapper at
  // the edge of an otherwise byte-preserved code block. Strip only that exact
  // outer artifact; never rewrite JSON content or command arguments.
  return String(payload)
    .trim()
    .replace(/^<arg_value>\s*/u, "")
    .replace(/\s*<\/arg_value>$/u, "");
}

function parseAgentDecision(text, tools, options = {}) {
  const raw = String(text || "");
  let payload;
  let trailing = "";
  const envelope = DECISION_ENVELOPE.exec(raw);
  if (envelope) {
    payload = envelope[1];
    trailing = envelope[2].trim();
  } else {
    const fenced = FENCED_DECISION.exec(raw);
    if (fenced && isDecisionFence(fenced[2], fenced[3])) {
      payload = fenced[3];
      trailing = fenced[4].trim();
    }
  }
  if (payload === undefined) {
    if (/<\/?agent(?:\\)?_decision>|`{3,}(?:cuhk-decision|cuhk_decision|agent_decision)/u.test(raw)) {
      throw new ProtocolError("Assistant produced a malformed AGENT DECISION PROTOCOL v1 envelope.");
    }
    return null;
  }

  const value = parseDecisionJson(payload);
  if (value.decision === "tool" && value.arguments && typeof value.arguments === "object" && !Array.isArray(value.arguments)) {
    // Web models sometimes nest the diagnostic reason inside arguments; move
    // it out so a strict tool schema (additionalProperties:false) still accepts
    // the command instead of rejecting the whole turn.
    if (value.reason === undefined && typeof value.arguments.reason === "string") {
      value.reason = value.arguments.reason;
    }
    delete value.arguments.reason;
  }
  // `reason` is diagnostic for a tool request; the command and schema are what
  // execute. Web models sometimes omit it on a duplicated/truncated block, so a
  // tool decision defaults instead of failing before the tool can run.
  const reasonRequired = value.decision !== "tool";
  const reason = boundedString(value.reason, "reason", MAX_REASON_CHARS, reasonRequired) || "tool request";
  const gatewayFeedback = boundedString(value.gateway_feedback, "gateway_feedback", MAX_FEEDBACK_CHARS);
  const evidence = normalizeEvidence(value.evidence);

  if (value.decision === "tool") {
    if (typeof value.name !== "string" || !value.name.trim()) throw new ProtocolError("A tool decision requires name.");
    if (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) {
      throw new ProtocolError("A tool decision requires an arguments object.");
    }
    const parsed = parseToolCall(`<tool_call>${JSON.stringify({ name: value.name, arguments: value.arguments })}</tool_call>`, tools, options);
    // Web models sometimes append a blocked decision or an apology after an
    // otherwise valid tool request. The tool request is already validated
    // against the catalog, so execute it and ignore the trailing text instead
    // of discarding a real action over a cosmetic protocol violation. The
    // runtime records ignoredTrailingText for diagnostics.
    const additionalToolDecisions = /`{3,}[\s\S]*?"decision"\s*:\s*"tool"/u.test(trailing);
    return {
      kind: "tool",
      parsed,
      reason,
      evidence,
      gatewayFeedback,
      explicit: true,
      ignoredTrailingText: trailing.length > 0,
      additionalToolDecisions
    };
  }

  const answer = trailing || boundedString(value.answer, "answer", 256 * 1024);
  if (!answer && options.allowMissingAnswer !== true) {
    throw new ProtocolError(`A ${value.decision} decision requires final answer text after the envelope or in answer.`);
  }
  if (value.decision === "blocked" && value.requires_user !== undefined && typeof value.requires_user !== "boolean") {
    throw new ProtocolError("A blocked decision requires_user must be boolean when provided.");
  }
  return {
    kind: value.decision,
    answer,
    reason,
    evidence,
    gatewayFeedback,
    requiresUser: value.decision === "blocked" ? value.requires_user !== false : false,
    explicit: true
  };
}

function isDecisionFence(language, payload) {
  if (DECISION_FENCE_LANGUAGES.has(String(language || "").toLowerCase())) return true;
  // The CUHK renderer sometimes rewrites an unknown info string to `text`.
  // Accept a generic whole-response fence only when its JSON positively
  // identifies this protocol; legacy {name, arguments} blocks remain tools.
  try {
    const value = parseDecisionObject(String(payload).replace(/\\_/gu, "_"));
    return value?.version === DECISION_VERSION && ["tool", "final", "blocked"].includes(value?.decision);
  } catch {
    return false;
  }
}

function actionFingerprint(parsed) {
  if (!parsed) return null;
  return crypto.createHash("sha256")
    .update(`${parsed.tool.protocolName}\u0000${parsed.argumentJson}`)
    .digest("hex")
    .slice(0, 24);
}

function decisionProtocolPrompt(profile = {}, options = {}) {
  const language = decisionLanguage(profile);
  const tools = Array.isArray(options.tools) ? options.tools : [];
  const toolNames = tools.map((tool) => tool.name || tool.protocolName).filter(Boolean).join(", ") || "(none)";
  if (language === "zh") {
    return [
      "AGENT DECISION PROTOCOL v1（主协议）",
      "Gateway 掌握工具是否真实执行、exit_code、pending 状态和安全边界；你掌握用户目标的语义、下一步行动及任务是否完成。双方不得越权。",
      "每次回复先独立判断当前状态，再只选择 tool、final、blocked 之一。Gateway 的 CONTROL/REPAIR 是可质疑的诊断，不是必须继续执行的命令；若任务已完成，必须坚持 final，不得为了迎合 Gateway 编造新操作。",
      "tool：回复只能包含以下代码块，不得有前后文字。必须保留代码围栏，避免网页 Markdown 改写命令中的 $、反斜杠或下划线：",
      "```cuhk-decision",
      '{"version":1,"decision":"tool","name":"工具名","arguments":{},"reason":"仍需该操作的原因"}',
      "```",
      "如果决定调用工具，回复中只能有这一个工具决策块；不要同时输出 blocked、final、道歉或其他文字。环境里的 permission profile 只描述客户端沙箱，不会移除工具目录中的工具。",
      "每轮只能有一个工具决策块；不要在同一回复里重复或并列多个工具块，后续调用等结果返回后再发。",
      "写入较大文件时，分多次工具调用追加（单次内容约 4KB），避免一个巨大的 heredoc；写完用 wc -c 或 sed -n 验证。",
      "读取 DOCX/PDF 等二进制文件时，优先用 pandoc、libreoffice 或 unzip；命令失败时先读错误并换一种方式重试，不要直接 blocked。",
      "final：先输出决策代码块，随后直接写给用户的最终答复；最终答复中的命令、代码块和手动步骤只是文档，不会被 Gateway 当工具执行：",
      "```cuhk-decision",
      '{"version":1,"decision":"final","reason":"goal_satisfied","evidence":["真实证据"],"gateway_feedback":"如 Gateway 判断错误可在此指出"}',
      "```",
      "<给用户的最终答复，可包含 Markdown/代码块>",
      "blocked：无法安全继续或必须由用户决定时使用，并在决策代码块后解释：",
      "```cuhk-decision",
      '{"version":1,"decision":"blocked","reason":"阻塞原因","requires_user":true,"evidence":[]}',
      "```",
      "<给用户的阻塞说明>",
      `可用工具：${toolNames}`,
      "兼容说明：旧 TOOL PROTOCOL JSON/PowerShell 仍可解析，但上述决策协议优先且能避免误判。"
    ].join("\n");
  }
  return [
    "AGENT DECISION PROTOCOL v1 (primary protocol)",
    "The Gateway owns execution facts, exit codes, pending state, validation, and safety boundaries. You own task meaning, the next semantic action, and whether the user's goal is complete. Neither side may override the other's authority.",
    "Independently choose exactly one decision: tool, final, or blocked. A Gateway CONTROL/REPAIR message is a challenge you may reject, not an order to invent more work. If the goal is complete, insist on final.",
    "tool (the fenced block must be the whole reply; keep the fence so web Markdown cannot rewrite $, backslashes, or underscores in arguments):",
    "```cuhk-decision",
    '{"version":1,"decision":"tool","name":"tool_name","arguments":{},"reason":"why this operation is still needed"}',
    "```",
    "If you decide to call a tool, the tool decision must be the only content of the reply: do not also output blocked, final, an apology, or any other text. A permission profile in the environment only describes the client sandbox; it never removes a tool from the catalog.",
    "Emit exactly one tool decision per reply; do not duplicate or batch several tool blocks. Send the next call only after the previous result arrives.",
    "For large files, append in several tool calls (roughly 4KB each) instead of one huge heredoc, then verify with wc -c or sed.",
    "For binary documents (DOCX/PDF), use pandoc, libreoffice, or unzip; read a failed command's error and retry instead of blocking.",
    "final (write the user-facing answer after the decision block; code blocks there are documentation and are never executed):",
    "```cuhk-decision",
    '{"version":1,"decision":"final","reason":"goal_satisfied","evidence":["real evidence"],"gateway_feedback":"optional correction of a Gateway assumption"}',
    "```",
    "<user-facing final answer, Markdown allowed>",
    "blocked (explain after the decision block):",
    "```cuhk-decision",
    '{"version":1,"decision":"blocked","reason":"why progress is unsafe or impossible","requires_user":true,"evidence":[]}',
    "```",
    "<user-facing blocker explanation>",
    `Available tools: ${toolNames}`,
    "Legacy TOOL PROTOCOL JSON/script requests remain accepted for compatibility, but this decision protocol takes precedence."
  ].join("\n");
}

function decisionProtocolReminder(profile = {}) {
  return decisionLanguage(profile) === "zh"
    ? [
      "AGENT DECISION PROTOCOL v1 REMINDER",
      "独立选择 tool / final / blocked。Gateway 控制消息可被纠正；任务完成就选择 final，不要追加终检。",
      '格式：先输出 ```cuhk-decision 代码块，块内是决策 JSON；final/blocked 后必须写给用户的文字答复，tool 后不得有其他文字。必须保留代码围栏。'
    ].join("\n")
    : [
      "AGENT DECISION PROTOCOL v1 REMINDER",
      "Independently choose tool, final, or blocked. You may correct Gateway control assumptions; choose final when the goal is complete instead of inventing verification work.",
      'Format: emit a ```cuhk-decision fenced JSON block first. A final/blocked block must be followed by a user-facing text answer; a tool block must stand alone. Keep the fence.'
    ].join("\n");
}

module.exports = {
  DECISION_VERSION,
  actionFingerprint,
  decisionLanguage,
  decisionProtocolPrompt,
  decisionProtocolReminder,
  parseAgentDecision
};
