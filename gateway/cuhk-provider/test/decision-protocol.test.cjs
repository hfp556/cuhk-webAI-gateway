"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ProtocolError } = require("../src/errors.cjs");
const { adaptToolsForModel, normalizeTools, parseToolCall } = require("../src/protocol.cjs");
const { GLM_PROFILE } = require("../src/model-profiles.cjs");
const {
  actionFingerprint,
  decisionProtocolPrompt,
  parseAgentDecision
} = require("../src/decision-protocol.cjs");

const echoTool = {
  type: "function",
  name: "echo",
  parameters: {
    type: "object",
    properties: { value: { type: "string", enum: ["ok"] } },
    required: ["value"],
    additionalProperties: false
  }
};

const tools = adaptToolsForModel(normalizeTools([echoTool]), GLM_PROFILE.toolPromptStyle);

test("agent decision tool validates against the real catalog", () => {
  const decision = parseAgentDecision(
    '<agent_decision>{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok"},"reason":"need evidence"}</agent_decision>',
    tools,
    { style: "glm" }
  );
  assert.equal(decision.kind, "tool");
  assert.equal(decision.parsed.tool.protocolName, "echo");
  assert.deepEqual(decision.parsed.arguments, { value: "ok" });
  assert.equal(decision.reason, "need evidence");
  assert.match(actionFingerprint(decision.parsed), /^[a-f0-9]{24}$/u);
});

test("a reason nested inside arguments is moved out before validation", () => {
  const decision = parseAgentDecision(
    '```cuhk-decision\n{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok","reason":"nested"}}\n```',
    tools
  );
  assert.equal(decision.kind, "tool");
  assert.equal(decision.reason, "nested");
  assert.deepEqual(decision.parsed.arguments, { value: "ok" });
});

test("multiple tool blocks are flagged so the runtime can warn the model", () => {
  const text = '```cuhk-decision\n{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok"},"reason":"first"}\n```\n\n```cuhk-decision\n{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok"},"reason":"second"}\n```';
  const decision = parseAgentDecision(text, tools);
  assert.equal(decision.kind, "tool");
  assert.equal(decision.additionalToolDecisions, true);
});

test("agent decision final preserves markdown and manual code as answer text", () => {
  const answer = "任务完成。\n```powershell\nWrite-Output manual\n```";
  const decision = parseAgentDecision(
    `<agent_decision>{"version":1,"decision":"final","reason":"goal_satisfied","evidence":["exit 0"],"gateway_feedback":"no more work"}</agent_decision>\n${answer}`,
    tools
  );
  assert.equal(decision.kind, "final");
  assert.equal(decision.answer, answer);
  assert.deepEqual(decision.evidence, ["exit 0"]);
  assert.equal(decision.gatewayFeedback, "no more work");
});

test("fenced decisions preserve command syntax and allow final trailing text", () => {
  const tool = parseAgentDecision(
    '```cuhk-decision\n{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok"},"reason":"$ and backslashes stay literal"}\n```',
    tools,
    { style: "glm" }
  );
  assert.equal(tool.kind, "tool");
  assert.deepEqual(tool.parsed.arguments, { value: "ok" });
  const final = parseAgentDecision(
    '```cuhk-decision\n{"version":1,"decision":"final","reason":"goal_satisfied","evidence":[]}\n```\nONLINE_LOOP_CONVERGED',
    tools
  );
  assert.equal(final.answer, "ONLINE_LOOP_CONVERGED");
});

test("renderer-relabelled text fences remain decisions but legacy JSON stays separate", () => {
  const final = parseAgentDecision(
    '```text\n{"version":1,"decision":"final","reason":"goal_satisfied","evidence":["exit_code=0"]}\n```\nDone.',
    tools
  );
  assert.equal(final.kind, "final");
  assert.equal(final.answer, "Done.");
  assert.equal(parseAgentDecision('```json\n{"name":"echo","arguments":{"value":"ok"}}\n```', tools), null);
});

test("confirmed renderer arg_value residue is stripped only at the payload boundary", () => {
  const decision = parseAgentDecision(
    '```text\n{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok"},"reason":"needed"}</arg_value>\n```',
    tools,
    { style: "glm" }
  );
  assert.equal(decision.kind, "tool");
  assert.deepEqual(decision.parsed.arguments, { value: "ok" });
  const internal = parseAgentDecision(
    '```cuhk-decision\n{"version":1,"decision":"final","reason":"contains </arg_value> internally","answer":"x"}\n```',
    tools
  );
  assert.equal(internal.reason, "contains </arg_value> internally");
});

test("agent decision blocked carries an explicit user handoff", () => {
  const decision = parseAgentDecision(
    '<agent_decision>{"version":1,"decision":"blocked","reason":"approval needed","requires_user":true,"answer":"请确认。"}</agent_decision>',
    tools
  );
  assert.equal(decision.kind, "blocked");
  assert.equal(decision.requiresUser, true);
  assert.equal(decision.answer, "请确认。");
});

test("a bare final is recognized only when runtime explicitly requests missing-answer recovery", () => {
  const bare = '```cuhk-decision\n{"version":1,"decision":"final","reason":"goal_satisfied"}\n```';
  assert.throws(() => parseAgentDecision(bare, tools), /requires final answer text/u);
  const decision = parseAgentDecision(bare, tools, { allowMissingAnswer: true });
  assert.equal(decision.kind, "final");
  assert.equal(decision.answer, "");
});

test("malformed and invalid decisions fail before any tool execution", () => {
  assert.throws(
    () => parseAgentDecision('<agent_decision>{broken}</agent_decision>', tools),
    ProtocolError
  );
  assert.throws(
    () => parseAgentDecision('<agent\\_decision>{"version":1,"decision":"tool"}</agent\\_decision>', tools),
    /malformed/u
  );
  assert.throws(
    () => parseAgentDecision('<agent_decision>{"version":1,"decision":"tool","name":"echo","arguments":{"value":"bad"},"reason":"needed"}</agent_decision>', tools),
    /not an allowed enum/u
  );
  const noReason = parseAgentDecision(
    '<agent_decision>{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok"}}</agent_decision> trailing',
    tools
  );
  assert.equal(noReason.kind, "tool");
  assert.equal(noReason.reason, "tool request");
  assert.equal(noReason.ignoredTrailingText, true);
  const tolerant = parseAgentDecision(
    '<agent_decision>{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok"},"reason":"needed"}</agent_decision> trailing',
    tools
  );
  assert.equal(tolerant.kind, "tool");
  assert.equal(tolerant.ignoredTrailingText, true);
  assert.deepEqual(tolerant.parsed.arguments, { value: "ok" });
  // The web model sometimes emits a valid tool request followed by a blocked
  // decision and an apology. The tool must still execute; the trailing
  // decision is documentation, not a second dispatch.
  const hedged = parseAgentDecision(
    '```text\n{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok"},"reason":"read"}\n```\n\n```text\n{"version":1,"decision":"blocked","reason":"no tool"}\n```\n\n抱歉，我没有拿到输出。',
    tools
  );
  assert.equal(hedged.kind, "tool");
  assert.equal(hedged.ignoredTrailingText, true);
});

test("variable-length fences and a stray trailing brace are recovered", () => {
  const payload = '{"version":1,"decision":"tool","name":"echo","arguments":{"value":"ok"},"reason":"large write"}';
  const decision = parseAgentDecision("````text\n" + payload + "}\n````", tools);
  assert.equal(decision.kind, "tool");
  assert.deepEqual(decision.parsed.arguments, { value: "ok" });

  const toolJson = parseToolCall(
    '````json\n{"name":"echo","arguments":{"value":"ok"}}\n````',
    tools,
    { style: "glm" }
  );
  assert.equal(toolJson.tool.protocolName, "echo");
});

test("decision protocol states the authority split and right to reject Gateway control", () => {
  const prompt = decisionProtocolPrompt(GLM_PROFILE, { tools: [{ name: "echo" }] });
  assert.match(prompt, /Gateway 掌握工具是否真实执行/u);
  assert.match(prompt, /你掌握用户目标的语义/u);
  assert.match(prompt, /若任务已完成，必须坚持 final/u);
  assert.match(prompt, /gateway_feedback/u);
  assert.match(prompt, /可用工具：echo/u);
});
