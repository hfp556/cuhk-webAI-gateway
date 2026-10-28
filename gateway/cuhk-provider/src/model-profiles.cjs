"use strict";

const GENERIC_PROFILE = Object.freeze({
  id: "generic",
  toolPromptStyle: "generic",
  parserStyle: "generic",
  compactWebPrompt: false
});

function chineseAgentPrompt(identityName) {
  return `你是当前会话的主 Agent，模型标识为 ${identityName}。你负责理解用户目标、规划步骤、决定是否调用工具、核对真实结果并完成最终答复。被问及模型身份时，直接依据该模型标识回答。`;
}

function englishAgentPrompt(identityName) {
  return `You are the primary Agent for this conversation. Your model identifier is ${identityName}. You own the complete task: understand the user's goal, plan the work, decide when to use tools, verify real results, and deliver the final answer. When asked about your model identity, answer directly from this identifier.`;
}

// GLM 5.x frequently treats the generic "functions__name" catalog as a set of
// unavailable web tools and then narrates that refusal. Its dedicated profile
// uses short tool names, a Chinese-first tool protocol, a GLM-specific parser,
// no Codex developer persona in the web prompt, and bounded arbitration.
const GLM_PROFILE = Object.freeze({
  id: "glm",
  identityName: "GLM",
  identityPrompt: chineseAgentPrompt("GLM"),
  toolPromptStyle: "glm",
  parserStyle: "glm",
  compactWebPrompt: true,
  scriptBridge: true
});

// DeepSeek and Kimi receive the same Codex request envelope as GPT models, but
// that envelope describes the local orchestrator rather than the selected web
// model. Give each family an explicit identity and a compact, short-name tool
// protocol instead of letting the host's GPT persona leak into the web model.
const DEEPSEEK_PROFILE = Object.freeze({
  id: "deepseek",
  identityName: "DeepSeek",
  identityPrompt: chineseAgentPrompt("DeepSeek"),
  toolPromptStyle: "deepseek",
  parserStyle: "deepseek",
  dedicatedJsonTools: true,
  compactWebPrompt: true,
  scriptBridge: false
});

const KIMI_PROFILE = Object.freeze({
  id: "kimi",
  identityName: "Kimi",
  identityPrompt: chineseAgentPrompt("Kimi"),
  toolPromptStyle: "kimi",
  parserStyle: "kimi",
  dedicatedJsonTools: true,
  compactWebPrompt: true,
  scriptBridge: false
});

// The on-premises Qwen model is exposed through the school's text chat UI.
// Keep its identity distinct from the host Codex model and require the same
// explicit JSON bridge used by other non-native tool-capable web models.
const QWEN_PROFILE = Object.freeze({
  id: "qwen",
  identityName: "Qwen3.8 27B（本地版）",
  identityPrompt: chineseAgentPrompt("Qwen3.8 27B（本地版）"),
  toolPromptStyle: "qwen",
  parserStyle: "qwen",
  dedicatedJsonTools: true,
  compactWebPrompt: true,
  scriptBridge: false
});

const SEED_PROFILE = Object.freeze({
  id: "seed",
  identityName: "豆包 Seed 2.1 Pro",
  identityPrompt: chineseAgentPrompt("豆包 Seed 2.1 Pro"),
  toolPromptStyle: "seed",
  parserStyle: "seed",
  dedicatedJsonTools: true,
  compactWebPrompt: true,
  scriptBridge: false
});

const GEMINI_PROFILE = Object.freeze({
  id: "gemini",
  identityName: "Gemini 3.8 Flash",
  identityPrompt: englishAgentPrompt("Gemini 3.8 Flash"),
  toolPromptStyle: "gemini",
  parserStyle: "gemini",
  dedicatedJsonTools: true,
  compactWebPrompt: true,
  scriptBridge: false
});

const GPT6_SOL_PROFILE = Object.freeze({
  id: "gpt6-sol",
  identityName: "GPT 6 Sol",
  identityPrompt: englishAgentPrompt("GPT 6 Sol"),
  toolPromptStyle: "gpt6-sol",
  parserStyle: "gpt6-sol",
  dedicatedJsonTools: true,
  compactWebPrompt: true,
  scriptBridge: false
});

const GPT6_LUNA_PROFILE = Object.freeze({
  id: "gpt6-luna",
  identityName: "GPT 6 Luna",
  identityPrompt: englishAgentPrompt("GPT 6 Luna"),
  toolPromptStyle: "gpt6-luna",
  parserStyle: "gpt6-luna",
  dedicatedJsonTools: true,
  compactWebPrompt: true,
  // The full JSON catalog makes GPT 6 Luna refuse local tool use; a short
  // decision contract keeps the same protocol while staying under the page's
  // refusal threshold. Runtime and tool validation are unchanged.
  compactToolContract: true,
  scriptBridge: false
});

function modelProfile(model) {
  const key = String(model || "").trim().toLowerCase();
  if (key.startsWith("glm")) return GLM_PROFILE;
  if (key.startsWith("deepseek")) return DEEPSEEK_PROFILE;
  if (key.startsWith("kimi")) return KIMI_PROFILE;
  if (key === "qwen3.8-27b") return QWEN_PROFILE;
  if (key === "seed2.1pro" || key.startsWith("doubao-seed-2-1-pro")) return SEED_PROFILE;
  if (key === "gemini3.8flash" || key.startsWith("gemini-3.8-flash")) return GEMINI_PROFILE;
  if (key === "gpt6sol" || key === "gpt-6-sol") return GPT6_SOL_PROFILE;
  if (key === "gpt6luna" || key === "gpt-6-luna") return GPT6_LUNA_PROFILE;
  return GENERIC_PROFILE;
}

module.exports = {
  DEEPSEEK_PROFILE,
  GEMINI_PROFILE,
  GENERIC_PROFILE,
  GLM_PROFILE,
  GPT6_LUNA_PROFILE,
  GPT6_SOL_PROFILE,
  KIMI_PROFILE,
  QWEN_PROFILE,
  SEED_PROFILE,
  modelProfile
};
