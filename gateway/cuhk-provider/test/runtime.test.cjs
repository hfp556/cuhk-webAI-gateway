"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ProtocolError, RequestError, UnavailableError } = require("../src/errors.cjs");
const { adaptToolsForModel, compileCatalog, normalizeTools, parseToolCall } = require("../src/protocol.cjs");
const {
  DEEPSEEK_PROFILE, GEMINI_PROFILE, GLM_PROFILE, GPT6_LUNA_PROFILE,
  GPT6_SOL_PROFILE, KIMI_PROFILE, QWEN_PROFILE, SEED_PROFILE, modelProfile
} = require("../src/model-profiles.cjs");
const { responseEvents, responseUsage } = require("../src/responses.cjs");
const { CuhkProviderRuntime, buildToolResultPrompt, conversationKeyOf, itemDigest, newHistoryItems } = require("../src/runtime.cjs");

const baseConfig = {
  gatewayEnabled: true,
  model: "gpt5.6sol",
  thinking: "high",
  mode: "locked",
  toolMode: "emulated",
  conversationReuse: true,
  maxToolLoops: 8
};

const echoTool = {
  type: "function",
  name: "echo",
  description: "Echo a value",
  parameters: {
    type: "object",
    properties: { value: { type: "string", enum: ["a", "b"] } },
    required: ["value"],
    additionalProperties: false
  }
};

class FakeTransport {
  constructor(outputs) {
    this.outputs = [...outputs];
    this.calls = [];
    this.onAsk = null;
  }

  async ask(input) {
    this.calls.push(input);
    if (typeof this.onAsk === "function") this.onAsk(input);
    const next = this.outputs.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("Fake transport has no queued output.");
    if (next && typeof next === "object" && typeof next.text === "string") {
      return { conversationId: "fake", ...next };
    }
    return { text: next, conversationId: "fake" };
  }
}

function runtime(outputs, config = {}, persistPath = null) {
  const current = { ...baseConfig, ...config };
  const transport = new FakeTransport(outputs);
  return {
    current,
    transport,
    instance: new CuhkProviderRuntime({ configStore: { read: () => ({ ...current }) }, transport, persistPath })
  };
}

test("text-only response returns a valid Responses object", async () => {
  const { instance, transport } = runtime(["Hello from CUHK"]);
  const response = await instance.respond({ model: "ignored", input: "hello", stream: false });
  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.model, "gpt5.6sol");
  assert.equal(response.output[0].content[0].text, "Hello from CUHK");
  assert.equal(transport.calls[0].isNew, true);
});

test("web context usage becomes standard Responses usage for the Codex footer", async () => {
  const { instance } = runtime([{ text: "Hello from CUHK", contextUsage: { usedPercent: 22, remainingPercent: 78 } }]);
  const response = await instance.respond({ model: "ignored", input: "hello", stream: false });
  assert.deepEqual(response.usage, {
    input_tokens: 30260,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 30260
  });
  assert.equal(responseUsage({ usedPercent: 100 }).total_tokens, 95000);
  for (const usedPercent of [0, 1.5, 3.1, 22, 50, 100]) {
    const tokens = responseUsage({ usedPercent }).total_tokens;
    // Codex TokenUsage::percent_of_context_window_remaining (0.160).
    const displayed = Math.round((95000 - 12000 - Math.max(0, tokens - 12000)) / (95000 - 12000) * 100);
    assert.equal(displayed, Math.round(100 - usedPercent));
  }
});

test("function call is validated and continued in the same transport session", async () => {
  const { instance, transport } = runtime([
    '<tool_call>\n{"name":"echo","arguments":{"value":"a"}}\n</tool_call>',
    "Observed a"
  ]);
  const first = await instance.respond({ input: "use echo", tools: [echoTool], tool_choice: "auto" });
  const call = first.output[0];
  assert.equal(call.type, "function_call");
  assert.equal(call.name, "echo");
  assert.deepEqual(JSON.parse(call.arguments), { value: "a" });

  const second = await instance.respond({
    input: [{ type: "function_call_output", call_id: call.call_id, output: "a" }],
    tools: [echoTool]
  });
  assert.equal(second.output[0].content[0].text, "Observed a");
  assert.equal(transport.calls[1].isNew, false);
  assert.match(transport.calls[1].prompt, new RegExp(`call_id: ${call.call_id}`));
  assert.match(transport.calls[1].prompt, /The tool catalog is unchanged/);
});

test("tool-result prompt tells the model to poll a running exec cell", () => {
  const catalog = { fingerprint: "fp", normalized: [{ name: "functions__wait" }], prompt: "TOOL PROTOCOL v1" };
  const prompt = buildToolResultPrompt({ callId: "call_1", output: "Script running with cell ID 7" }, catalog, false);
  assert.match(prompt, /Request functions__wait with the reported cell_id/);
  assert.doesNotMatch(buildToolResultPrompt({ callId: "call_1", output: "done" }, { ...catalog, normalized: [] }, false), /functions__wait/);
});


test("two sequential tool calls and a tool error can complete", async () => {
  const { instance, transport } = runtime([
    '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>',
    '<tool_call>{"name":"echo","arguments":{"value":"b"}}</tool_call>',
    "Handled the tool error"
  ]);
  const first = await instance.respond({ input: "two steps", tools: [echoTool] });
  const second = await instance.respond({ input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }] });
  const third = await instance.respond({
    input: [{ type: "function_call_output", call_id: second.output[0].call_id, output: "ERROR: deliberate failure" }]
  });
  assert.equal(third.output[0].content[0].text, "Handled the tool error");
  assert.match(transport.calls[2].prompt, /ERROR: deliberate failure/);
});

test("a reply with multiple tool blocks warns after executing only the first", async () => {
  const twoBlocks = '```cuhk-decision\n{"version":1,"decision":"tool","name":"echo","arguments":{"value":"a"},"reason":"first"}\n```\n\n```cuhk-decision\n{"version":1,"decision":"tool","name":"echo","arguments":{"value":"b"},"reason":"second"}\n```';
  const { instance, transport } = runtime([twoBlocks, "first block handled"]);
  const first = await instance.respond({ input: "two blocks", tools: [echoTool] });
  assert.equal(first.output[0].type, "function_call");
  await instance.respond({
    input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }]
  });
  assert.match(transport.calls[1].prompt, /Only the first block was executed/u);
  assert.match(transport.calls[1].prompt, /Issue the next tool block by itself/u);
});

test("explicit agent decisions drive a tool and then an unwrapped final answer", async () => {
  const { instance, transport } = runtime([
    '<agent_decision>{"version":1,"decision":"tool","name":"echo","arguments":{"value":"a"},"reason":"need evidence"}</agent_decision>',
    '<agent_decision>{"version":1,"decision":"final","reason":"goal_satisfied","evidence":["echo returned a"]}</agent_decision>\nDone with real evidence.'
  ]);
  const first = await instance.respond({ input: "use the decision protocol", tools: [echoTool] });
  assert.equal(first.output[0].type, "function_call");
  assert.deepEqual(JSON.parse(first.output[0].arguments), { value: "a" });
  const final = await instance.respond({
    input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }]
  });
  assert.equal(final.output[0].content[0].text, "Done with real evidence.");
  assert.equal(transport.calls.length, 2);
  assert.match(transport.calls[0].prompt, /AGENT DECISION PROTOCOL v1/);
  assert.match(transport.calls[1].prompt, /choose tool only if more local work is needed/u);
});

test("web agent can reject a mistaken Gateway control and insist on convergence", async () => {
  const refusal = "I cannot run tools because exec_command is unavailable.";
  const finalDecision = '<agent_decision>{"version":1,"decision":"final","reason":"goal_satisfied","evidence":["requested inspection is already complete"],"gateway_feedback":"The Gateway incorrectly inferred that my prior prose required another tool."}</agent_decision>\nThe task is complete.';
  const { instance, transport } = runtime([refusal, finalDecision]);
  const result = await instance.respond({ input: "answer if already complete", tools: [echoTool] });
  assert.equal(result.output[0].type, "message");
  assert.equal(result.output[0].content[0].text, "The task is complete.");
  assert.equal(transport.calls.length, 2);
  assert.match(transport.calls[1].prompt, /GATEWAY CONTROL v1/);
  assert.match(transport.calls[1].prompt, /not an order to continue/u);
  assert.match(transport.calls[1].prompt, /tool, final, blocked/u);
});

test("completed tool plus bare final requests a text summary without running more commands", async () => {
  const bare = '<agent_decision>{"version":1,"decision":"final","reason":"goal_satisfied","answer":"   "}</agent_decision>';
  const { instance, transport } = runtime([
    '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>',
    bare,
    '<agent_decision>{"version":1,"decision":"final","reason":"goal_satisfied"}</agent_decision>\nCompleted: echo returned a.'
  ]);
  const first = await instance.respond({ input: "echo once", tools: [echoTool] });
  const final = await instance.respond({ input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }] });
  assert.equal(final.output[0].content[0].text, "Completed: echo returned a.");
  assert.equal(transport.calls.length, 3);
  assert.equal(transport.calls[2].isNew, false);
  assert.match(transport.calls[2].prompt, /missing_final_answer/u);
  assert.match(transport.calls[2].prompt, /"allowed_decisions":\["final","blocked"\]/u);
  assert.match(transport.calls[2].prompt, /do not execute tools or repeat completed commands/u);
  assert.equal(instance.activeSessionId, null);
  assert.equal(instance.pendingCalls.size, 0);
});

test("summary recovery rejects another tool and stays bounded when the answer remains missing", async () => {
  const bare = '<agent_decision>{"version":1,"decision":"final","reason":"goal_satisfied"}</agent_decision>';
  const tool = '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>';
  const { instance, transport } = runtime([tool, bare, tool, bare]);
  const first = await instance.respond({ input: "echo once", tools: [echoTool] });
  await assert.rejects(instance.respond({ input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }] }), /stopped after 2 control turns without progress/u);
  assert.equal(transport.calls.length, 4);
  assert.match(transport.calls[3].prompt, /"allowed_decisions":\["final","blocked"\]/u);
  assert.equal(instance.activeSessionId, null);
  assert.equal(instance.pendingCalls.size, 0);
});

test("bare final never hides a known running process or a required tool", async () => {
  const bare = '<agent_decision>{"version":1,"decision":"final","reason":"goal_satisfied"}</agent_decision>';
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const { instance, transport } = runtime([bare]);
  transport.onAsk = input => { instance.sessions.get(input.sessionId).runningProcesses.set(123, "long command"); };
  const poll = await instance.respond({ input: "continue waiting", tools: codeModeTools });
  assert.match(poll.output[0].input, /tools.write_stdin/u);
  assert.match(poll.output[0].input, /"session_id":123/u);
  assert.equal(transport.calls.length, 1);

  const required = runtime([bare, '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>']);
  const result = await required.instance.respond({ input: "echo", tools: [echoTool], tool_choice: "required" });
  assert.equal(result.output[0].type, "function_call");
  assert.match(required.transport.calls[1].prompt, /"allowed_decisions":\["tool"\]/u);
});

test("duplicate action is challenged instead of executed twice and the agent may finalize", async () => {
  const toolDecision = '<agent_decision>{"version":1,"decision":"tool","name":"echo","arguments":{"value":"a"},"reason":"inspect"}</agent_decision>';
  const finalDecision = '<agent_decision>{"version":1,"decision":"final","reason":"goal_satisfied","evidence":["echo already returned a"],"gateway_feedback":"The duplicate was unnecessary."}</agent_decision>\nAlready complete.';
  const { instance, transport } = runtime([toolDecision, toolDecision, finalDecision]);
  const first = await instance.respond({ input: "inspect once", tools: [echoTool] });
  const result = await instance.respond({
    input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }]
  });
  assert.equal(result.output[0].type, "message");
  assert.equal(result.output[0].content[0].text, "Already complete.");
  assert.equal(transport.calls.length, 3);
  assert.match(transport.calls[2].prompt, /duplicate_action_without_progress/u);
  assert.equal(instance.pendingCalls.size, 0);
});

test("repeated disagreement is bounded after two control turns without progress", async () => {
  const invalid = '<agent_decision>{"version":1,"decision":"unknown"}</agent_decision>';
  const { instance, transport } = runtime([invalid, invalid, invalid, invalid]);
  await assert.rejects(
    instance.respond({ input: "do not loop", tools: [echoTool] }),
    /stopped after 2 control turns without progress/u
  );
  assert.equal(transport.calls.length, 3);
  assert.equal(instance.activeSessionId, null);
  assert.equal(instance.pendingCalls.size, 0);
});

test("client-required tool choice remains a Gateway-enforced execution contract", async () => {
  const prematureFinal = '<agent_decision>{"version":1,"decision":"final","reason":"done","answer":"No tool."}</agent_decision>';
  const requiredTool = '<agent_decision>{"version":1,"decision":"tool","name":"echo","arguments":{"value":"a"},"reason":"client required it"}</agent_decision>';
  const { instance, transport } = runtime([prematureFinal, requiredTool]);
  const result = await instance.respond({ input: "must call", tools: [echoTool], tool_choice: "required" });
  assert.equal(result.output[0].type, "function_call");
  assert.equal(transport.calls.length, 2);
  assert.match(transport.calls[1].prompt, /"allowed_decisions":\["tool"\]/u);
});

test("replayed tool-result history uses the latest pending result", async () => {
  const { instance } = runtime([
    '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>',
    '<tool_call>{"name":"echo","arguments":{"value":"b"}}</tool_call>',
    "final"
  ]);
  const first = await instance.respond({ input: "echo twice", tools: [echoTool] });
  const second = await instance.respond({ input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }] });
  const third = await instance.respond({
    input: [
      { type: "function_call_output", call_id: first.output[0].call_id, output: "a" },
      first.output[0],
      { type: "function_call_output", call_id: second.output[0].call_id, output: "b" },
      second.output[0]
    ]
  });
  assert.equal(third.output[0].content[0].text, "final");
});


test("unknown tools, invalid JSON, and schema violations stop after bounded arbitration", async (t) => {
  const cases = [
    '<tool_call>{"name":"missing","arguments":{}}</tool_call>',
    '<tool_call>{broken}</tool_call>',
    '<tool_call>{"name":"echo","arguments":{"value":"c"}}</tool_call>'
  ];
  for (const malformed of cases) {
    await t.test(malformed.slice(0, 38), async () => {
      const { instance, transport } = runtime([malformed, malformed, malformed]);
      await assert.rejects(instance.respond({ input: "bad", tools: [echoTool] }), ProtocolError);
      assert.equal(transport.calls.length, 3);
      assert.match(transport.calls[1].prompt, /GATEWAY CONTROL v1/);
      assert.match(transport.calls[2].prompt, /GATEWAY CONTROL v1/);
    });
  }
});

test("tool-looking prose is never promoted to a call", async () => {
  const tools = normalizeTools([echoTool]);
  assert.equal(parseToolCall("I could call echo({value: 'a'}), but will not.", tools), null);
  assert.equal(parseToolCall('Here is an example:\n```json\n{"name":"echo","arguments":{"value":"a"}}\n```', tools), null);
});

test("a whole-response fenced JSON block is accepted as a strict tool request", () => {
  const tools = normalizeTools([echoTool]);
  const parsed = parseToolCall('```json\n{"name":"echo","arguments":{"value":"a"}}\n```', tools);
  assert.equal(parsed.tool.protocolName, "echo");
  assert.deepEqual(parsed.arguments, { value: "a" });
});

test("narrated tool rejection receives a control turn and can choose a valid tool", async () => {
  const narration = "I attempted to create the file, but every tool request is being rejected by the local client with unknown tool.";
  const { instance, transport } = runtime([
    narration,
    '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>'
  ]);
  const response = await instance.respond({ input: "create a file", tools: [echoTool] });
  assert.equal(response.output[0].type, "function_call");
  assert.equal(transport.calls.length, 2);
  assert.match(transport.calls[1].prompt, /GATEWAY CONTROL v1/);
  assert.match(transport.calls[1].prompt, /not an order to continue/u);
  assert.match(transport.calls[1].prompt, /tool, final, blocked/u);
});

test("repeated narrated rejection is bounded and may still converge explicitly", async () => {
  const narration = "I attempted to create the file, but every tool request is being rejected by the local client with unknown tool.";
  const finalDecision = '<agent_decision>{"version":1,"decision":"final","reason":"goal_satisfied","evidence":["no local operation is required"],"gateway_feedback":"The Gateway assumption was incorrect."}</agent_decision>\nNothing else is needed.';
  const { instance, transport } = runtime([narration, narration, finalDecision]);
  const response = await instance.respond({ input: "create a file", tools: [echoTool] });
  assert.equal(response.output[0].content[0].text, "Nothing else is needed.");
  assert.equal(transport.calls.length, 3);
  assert.match(transport.calls[2].prompt, /GATEWAY CONTROL v1/);
});


test("glm profile exposes short tool names and the GLM-first catalog prompt", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const { instance, transport } = runtime(["plain answer"], { model: "glm5.3flash", thinking: "high" });
  await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "write a file on the Desktop" }] }
    ]
  });
  const prompt = transport.calls[0].prompt;
  assert.match(prompt, /CUHK TOOL PROTOCOL v1 - GLM MODE/);
  assert.match(prompt, /你是当前会话的主 Agent/);
  assert.match(prompt, /当前 Agent 环境提供给你的外部能力/);
  assert.match(prompt, /"name":"exec_command"/);
  assert.match(prompt, /AGENT DECISION PROTOCOL v1/);
  assert.match(prompt, /Gateway 掌握工具是否真实执行/);
  assert.match(prompt, /tool_choice: auto/);
  assert.doesNotMatch(prompt, /functions__exec_command/);
  assert.doesNotMatch(prompt, /You are continuing a coding-agent task/);
});

test("glm parser accepts a fenced JSON block with commentary and a legacy alias", () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const tools = adaptToolsForModel(normalizeTools(codeModeTools), GLM_PROFILE.toolPromptStyle);
  const parsed = parseToolCall('好的，开始。\n```json\n{"name":"functions__exec_command","arguments":{"cmd":"Write-Output ok"}}\n```\n', tools, { style: GLM_PROFILE.parserStyle });
  assert.equal(parsed.tool.protocolName, "exec_command");
  assert.deepEqual(parsed.arguments, { cmd: "Write-Output ok" });
});

test("glm narrated tool refusal receives bounded control and may choose a tool", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const narration = "I do not have an exec_command tool available in this session.";
  const valid = '```json\n{"name":"exec_command","arguments":{"cmd":"Write-Output ok"}}\n```';
  const { instance, transport } = runtime([narration, valid], { model: "glm5.3flash", thinking: "high" });
  const response = await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "create a file on the Desktop" }] }
    ]
  });
  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].name, "exec");
  assert.equal(transport.calls.length, 2);
  assert.match(transport.calls[1].prompt, /GATEWAY CONTROL v1/);
});

test("glm web prompt drops the Codex developer persona and keeps the user task", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const developer = `<environment_context><cwd>C:\\Users\\14441\\Desktop</cwd><shell>powershell</shell></environment_context>\nYou are Codex, an agent based on GPT-5. ${"x".repeat(8000)}`;
  const { instance, transport } = runtime(["plain answer"], { model: "glm5.3flash", thinking: "high" });
  await instance.respond({
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: developer }] },
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Create cuhk-glm-test.txt on the Desktop." }] }
    ]
  });
  const prompt = transport.calls[0].prompt;
  assert.doesNotMatch(prompt, /You are Codex/);
  assert.match(prompt, /Create cuhk-glm-test\.txt on the Desktop/);
  assert.match(prompt, /cwd: /);
  assert.ok(prompt.indexOf("CUHK TOOL PROTOCOL v1 - GLM MODE") < prompt.indexOf("TASK"), "tool catalog must precede the user task");
  assert.ok(prompt.length < 5000, `glm web prompt should be compact, got ${prompt.length}`);
});



test("glm parser turns a fenced PowerShell block into an implicit exec_command bridge", () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const tools = adaptToolsForModel(normalizeTools(codeModeTools), GLM_PROFILE.toolPromptStyle);
  const script = "Set-Content -Path C:\\Users\\14441\\Desktop\\glm-script-test.txt -Value OK";
  const parsed = parseToolCall(`I will not call tools.\n\`\`\`powershell\n${script}\n\`\`\`\n`, tools, { style: GLM_PROFILE.parserStyle, allowScript: true, allowScriptCommentary: true });
  assert.equal(parsed.synthetic, "script");
  assert.equal(parsed.tool.protocolName, "exec_command");
  assert.equal(parsed.arguments.cmd, script);
});

test("glm script bridge executes a PowerShell script the model emitted with commentary", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const script = "Set-Content -Path C:\\Users\\14441\\Desktop\\glm-script-test.txt -Value OK";
  const refusalWithScript = `I cannot run commands, so I will not call any tool. Here is the script:\n\`\`\`powershell\n${script}\n\`\`\`\n`;
  const { instance, transport } = runtime([refusalWithScript, "The file was created."], { model: "glm5.3flash", thinking: "high" });
  const first = await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "create a file on the Desktop" }] }
    ]
  });
  assert.equal(first.output[0].type, "custom_tool_call");
  assert.equal(first.output[0].name, "exec");
  assert.match(first.output[0].input, /Set-Content/);
  assert.equal(transport.calls.length, 1);
  const second = await instance.respond({
    input: [{ type: "custom_tool_call_output", call_id: first.output[0].call_id, output: "ok" }]
  });
  assert.equal(second.output[0].content[0].text, "The file was created.");
});

test("glm arbitrates a narrated second script and continues the same agent loop", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const firstScript = "Write-Output first-step";
  const secondScript = "Write-Output second-step";
  const narratedSecondScript = `第一步已完成，现在继续执行第二步：\n\`\`\`powershell\n${secondScript}\n\`\`\`\n`;
  const { instance, transport } = runtime([
    `\`\`\`powershell\n${firstScript}\n\`\`\``,
    narratedSecondScript,
    `\`\`\`powershell\n${secondScript}\n\`\`\``,
    "两步都已完成。"
  ], { model: "glm5.3flash", thinking: "high" });

  const first = await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "完成一个需要两次本地命令的任务" }] }
    ]
  });
  assert.equal(first.output[0].type, "custom_tool_call");
  assert.match(first.output[0].input, /first-step/);

  const second = await instance.respond({
    input: [{ type: "custom_tool_call_output", call_id: first.output[0].call_id, output: "first ok" }]
  });
  assert.equal(second.output[0].type, "custom_tool_call");
  assert.match(second.output[0].input, /second-step/);
  assert.equal(transport.calls.length, 3, "the narrated script should trigger one bounded control turn");
  assert.match(transport.calls[2].prompt, /GATEWAY CONTROL v1/);
  assert.match(transport.calls[2].prompt, /tool, final, blocked/u);

  const final = await instance.respond({
    input: [{ type: "custom_tool_call_output", call_id: second.output[0].call_id, output: "second ok" }]
  });
  assert.equal(final.output[0].type, "message");
  assert.equal(final.output[0].content[0].text, "两步都已完成。");
  assert.equal(transport.calls.length, 4);
});

test("glm arbitrates an ordinary narrated script before execution instead of treating prose examples as direct calls", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const script = "Write-Output repaired-step";
  const narratedScript = `下一步可以这样执行：\n\`\`\`powershell\n${script}\n\`\`\`\n`;
  const { instance, transport } = runtime([
    narratedScript,
    `\`\`\`powershell\n${script}\n\`\`\``
  ], { model: "glm5.3flash", thinking: "high" });

  const response = await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "执行下一步" }] }
    ]
  });
  assert.equal(response.output[0].type, "custom_tool_call");
  assert.match(response.output[0].input, /repaired-step/);
  assert.equal(transport.calls.length, 2, "narrated code must be normalized by a control turn before execution");
  assert.match(transport.calls[1].prompt, /GATEWAY CONTROL v1/);
});

test("glm final delivery with manual PowerShell instructions converges without another control turn", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const firstScript = "Write-Output TASK_COMPLETE";
  const finalDelivery = [
    "任务已全部完成并通过终检，没有剩余需要执行的本地操作。",
    "## 需要你手动执行",
    "```powershell",
    "git add app/settings_app.py",
    "git commit -m \"finish task\"",
    "```"
  ].join("\n");
  const { instance, transport } = runtime([
    `\`\`\`powershell\n${firstScript}\n\`\`\``,
    finalDelivery
  ], { model: "glm5.3flash", thinking: "high" });

  const first = await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "完成任务并给出交付说明" }] }
    ]
  });
  assert.equal(first.output[0].type, "custom_tool_call");

  const final = await instance.respond({
    input: [{ type: "custom_tool_call_output", call_id: first.output[0].call_id, output: "TASK_COMPLETE" }]
  });
  assert.equal(final.output[0].type, "message");
  assert.equal(final.output[0].content[0].text, finalDelivery);
  assert.equal(transport.calls.length, 2, "completion text must not trigger control or another command");
});

test("glm step-complete narration still arbitrates and continues when more work is explicit", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const script = "Write-Output second-step";
  const { instance, transport } = runtime([
    `第一步完成，继续第二步：\n\`\`\`powershell\n${script}\n\`\`\``,
    `\`\`\`powershell\n${script}\n\`\`\``
  ], { model: "glm5.3flash", thinking: "high" });

  const response = await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "完成两步任务" }] }
    ]
  });
  assert.equal(response.output[0].type, "custom_tool_call");
  assert.match(response.output[0].input, /second-step/);
  assert.equal(transport.calls.length, 2);
  assert.match(transport.calls[1].prompt, /GATEWAY CONTROL v1/);
});

for (const { model, profile, identity, mode, answer } of [
  { model: "deepseek-v4.1-flash", profile: DEEPSEEK_PROFILE, identity: "DeepSeek", mode: "DEEPSEEK" },
  { model: "kimi-k3", profile: KIMI_PROFILE, identity: "Kimi", mode: "KIMI" },
  { model: "qwen3.8-27b", profile: QWEN_PROFILE, identity: "Qwen3.8 27B（本地版）", mode: "QWEN" },
  { model: "seed2.1pro", profile: SEED_PROFILE, identity: "豆包 Seed 2.1 Pro", mode: "SEED" },
  { model: "gemini3.8flash", profile: GEMINI_PROFILE, identity: "Gemini 3.8 Flash", mode: "GEMINI", answer: "I am Gemini 3.8 Flash." },
  { model: "gpt6sol", profile: GPT6_SOL_PROFILE, identity: "GPT 6 Sol", mode: "GPT6-SOL", answer: "I am GPT 6 Sol." },
  { model: "gpt6luna", profile: GPT6_LUNA_PROFILE, identity: "GPT 6 Luna", mode: "GPT6-LUNA", answer: "I am GPT 6 Luna." }
]) {
  test(`${identity} profile adopts the selected model as the primary Agent even without tools`, async () => {
    assert.equal(modelProfile(model), profile);
    const developer = "You are Codex, an agent based on GPT-5. Follow the host coding-agent persona.";
    const { instance, transport } = runtime([answer || `我是 ${identity}`], { model, thinking: "high" });
    await instance.respond({
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: developer }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "你是谁？" }] }
      ]
    });
    const prompt = transport.calls[0].prompt;
    assert.match(prompt, new RegExp(profile.identityPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(prompt, /不是你的身份|不是 GPT|never as GPT|only the local host|planning layer/iu);
    assert.match(prompt, /USER:\n你是谁？/);
    assert.doesNotMatch(prompt, /You are Codex, an agent based on GPT-5/);
    assert.doesNotMatch(prompt, /Follow the host coding-agent persona/);
  });

  test(`${identity} profile uses short JSON-only tools and a bounded control prompt`, async () => {
    const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
    const narration = "我无法访问本地文件，也没有可用工具。";
    const valid = '说明如下：\n```json\n{"name":"functions__exec_command","arguments":{"cmd":"Write-Output ok"}}\n```';
    const { instance, transport } = runtime([narration, valid], { model, thinking: "high" });
    const response = await instance.respond({
      input: [
        { type: "additional_tools", role: "developer", tools: codeModeTools },
        { type: "message", role: "user", content: [{ type: "input_text", text: "读取本地状态" }] }
      ]
    });
    assert.equal(response.output[0].type, "custom_tool_call");
    assert.equal(response.output[0].name, "exec");
    assert.match(transport.calls[0].prompt, new RegExp(`CUHK TOOL PROTOCOL v1 - ${mode} MODE`));
    assert.match(transport.calls[0].prompt, /"name":"exec_command"/);
    assert.doesNotMatch(transport.calls[0].prompt, /"name":"functions__exec_command"/);
    assert.match(transport.calls[0].prompt, profile.id === "seed"
      ? /web_search、image_tool、mind_map/u
      : profile.id === "qwen"
        ? /不要输出 Qwen 原生 function call\/tool_call 对象/u
      : profile.id === "gemini"
        ? /Do not emit Gemini\/Google native function-call syntax/u
        : profile.id.startsWith("gpt6-")
          ? /Do not emit OpenAI native function-call objects/u
          : /不要输出 PowerShell\/脚本代码块来代替工具调用/u);
    assert.match(transport.calls[1].prompt, /GATEWAY CONTROL v1/);
    assert.match(transport.calls[1].prompt, /tool, final, blocked/u);
    assert.match(transport.calls[1].prompt, /AGENT DECISION PROTOCOL v1 REMINDER/);
  });

  test(`${identity} parser never promotes a fenced script into an implicit tool call`, () => {
    const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
    const tools = adaptToolsForModel(normalizeTools(codeModeTools), profile.toolPromptStyle);
    const parsed = parseToolCall("```powershell\nWrite-Output unsafe\n```", tools, {
      style: profile.parserStyle,
      allowScript: true,
      allowScriptCommentary: true
    });
    assert.equal(parsed, null);
  });
}

test("apply_patch custom tool follows the virtual_apply_patch bridge shape", async () => {
  const applyPatch = { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: patch" } };
  const patch = "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
  const { instance } = runtime([`<tool_call>${JSON.stringify({ name: "virtual_apply_patch", arguments: { patch } })}</tool_call>`]);
  const response = await instance.respond({ input: "create hello", tools: [applyPatch] });
  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].name, "apply_patch");
  assert.equal(response.output[0].input, patch);
});

test("Codex additional_tools code mode bridges structured shell calls and segmented outputs", async () => {
  const codeModeTools = [{
    type: "namespace",
    name: "functions",
    tools: [{ type: "custom", name: "exec", description: "Run code-mode tools", format: { type: "grammar" } }]
  }];
  const { instance, transport } = runtime([
    '<tool\\_call>{"name":"functions\\_\\_exec\\_command","arguments":{"cmd":"Write-Output ok"}}</tool\\_call>',
    "done"
  ]);
  const first = await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] }
    ]
  });
  const call = first.output[0];
  assert.equal(call.type, "custom_tool_call");
  assert.equal(call.name, "exec");
  assert.equal(call.namespace, "functions");
  assert.match(call.input, /tools\.exec_command/);
  assert.match(call.input, /Write-Output ok/);
    assert.match(call.input, /"login":false/);
    assert.match(call.input, /"yield_time_ms":10000/);

  const second = await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      call,
      { type: "custom_tool_call_output", call_id: call.call_id, output: [{ type: "input_text", text: "ok\n" }] }
    ]
  });
  assert.equal(second.output[0].content[0].text, "done");
  assert.match(transport.calls[1].prompt, /ok/);
});

test("Codex code mode exposes a structured apply_patch bridge", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const patch = "*** Begin Patch\n*** Add File: marker.txt\n+ok\n*** End Patch";
  const { instance } = runtime([`<tool_call>${JSON.stringify({ name: "functions__apply_patch", arguments: { patch } })}</tool_call>`]);
  const response = await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "patch" }] }
    ]
  });
  assert.equal(response.output[0].type, "custom_tool_call");
  assert.equal(response.output[0].name, "exec");
  assert.equal(response.output[0].namespace, "functions");
  assert.match(response.output[0].input, /tools\.apply_patch/);
  assert.match(response.output[0].input, /marker\.txt/);
});

test("code-mode namespace is filtered to the shell, patch, and wait bridge", () => {
  const tools = normalizeTools([{
    type: "namespace",
    name: "functions",
    tools: [
      { type: "custom", name: "exec" },
      { type: "function", name: "wait", parameters: { type: "object", properties: {}, additionalProperties: false } },
      { type: "function", name: "request_user_input", parameters: { type: "object", properties: {}, additionalProperties: false } },
      { type: "custom", name: "other" }
    ]
  }, {
    type: "namespace",
    name: "collaboration",
    tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object", properties: {}, additionalProperties: false } }]
  }]);
  assert.deepEqual(tools.map((tool) => tool.protocolName), ["functions__exec_command", "functions__write_stdin", "functions__apply_patch", "functions__wait"]);
});


test("AGENTS routing and plugin noise are stripped before reaching the web model", async () => {
  const routingBlock = '<INSTRUCTIONS> # Global CUHK AI routing\nRead config.json before deciding whether to consult the school web AI.\nDo not invoke the school AI for requests that only configure, test, or repair the CUHK AI bridge itself.\n</INSTRUCTIONS>';
  const pluginsBlock = '<recommended_plugins> Dropbox, Notion, Slack </recommended_plugins>';
  const { instance, transport } = runtime(["plain answer"]);
  await instance.respond({
    instructions: routingBlock,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `${routingBlock}${pluginsBlock}\nCreate cuhk-test.txt on the Desktop.` }] }]
  });
  const prompt = transport.calls[0].prompt;
  assert.doesNotMatch(prompt, /Global CUHK AI routing/);
  assert.doesNotMatch(prompt, /Do not invoke the school AI/);
  assert.doesNotMatch(prompt, /recommended_plugins/);
  assert.match(prompt, /Create cuhk-test\.txt on the Desktop/);
});

test("large Codex system context is truncated before the web prompt", async () => {
  const longSystem = `system-start ${"x".repeat(30000)} system-end`;
  const secondSystem = `second-start ${"y".repeat(4000)} second-end`;
  const { instance, transport } = runtime(["plain answer"]);
  await instance.respond({
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: longSystem }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: secondSystem }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "create the file" }] }
    ]
  });
  const prompt = transport.calls[0].prompt;
  assert.match(prompt, /system-start/);
  assert.doesNotMatch(prompt, /system-end/);
  assert.doesNotMatch(prompt, /second-start/);
  assert.match(prompt, /system context truncated by CUHK gateway/);
  assert.ok(prompt.length < 17000, `web prompt should be compacted, got ${prompt.length}`);
});


test("catalog fingerprint is reused or refreshed on continuation", async () => {
  const extraTool = {
    type: "function",
    name: "other",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  };
  const { instance, transport } = runtime([
    '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>',
    "done"
  ]);
  const first = await instance.respond({ input: "change tools", tools: [echoTool] });
  await instance.respond({
    input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }],
    tools: [echoTool, extraTool]
  });
  assert.match(transport.calls[1].prompt, /TOOL PROTOCOL v1/);
  assert.match(transport.calls[1].prompt, /"name":"other"/);

  const firstCatalog = compileCatalog(normalizeTools([echoTool]));
  const sameCatalog = compileCatalog(normalizeTools([echoTool]));
  assert.equal(firstCatalog.fingerprint, sameCatalog.fingerprint);
});

test("bootstrap catalog presents tools as Agent capabilities executed by the Gateway runtime", async () => {
  const codeModeTools = [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }] }];
  const { instance, transport } = runtime(["plain answer"]);
  await instance.respond({
    input: [
      { type: "additional_tools", role: "developer", tools: codeModeTools },
      { type: "message", role: "user", content: [{ type: "input_text", text: "write a file" }] }
    ]
  });
  assert.match(transport.calls[0].prompt, /tools are capabilities of your current Agent environment/);
  assert.match(transport.calls[0].prompt, /The Gateway runtime executes each request/);
  assert.match(transport.calls[0].prompt, /Do not answer that you cannot access the computer or run commands/);
  assert.match(transport.calls[0].prompt, /Desktop/);
});

test("live process rejects duplicate tool results", async () => {
  const { instance } = runtime(['<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>', "done"]);
  const first = await instance.respond({ input: "echo", tools: [echoTool] });
  const input = [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }];
  await instance.respond({ input });
  await assert.rejects(instance.respond({ input }), (error) => error instanceof RequestError && error.code === "duplicate_tool_result");
});

test("locked panel settings hot reload between requests", async () => {
  const { instance, current, transport } = runtime(["one", "two"]);
  await instance.respond({ model: "client-model", input: "one" });
  current.model = "deepseek-v4.1-flash";
  current.thinking = "max";
  const response = await instance.respond({ model: "client-model", input: "two" });
  assert.equal(response.model, "deepseek-v4.1-flash");
  assert.equal(transport.calls[1].model, "deepseek-v4.1-flash");
  assert.equal(transport.calls[1].thinking, "max");
});

test("disabled gateway configuration fails without transport activity", async () => {
  const { instance, transport } = runtime(["unused"], { gatewayEnabled: false });
  await assert.rejects(instance.respond({ input: "hello" }), UnavailableError);
  assert.equal(transport.calls.length, 0);
});

test("a pending browser conversation blocks an interleaved new task", async () => {
  const { instance } = runtime(['<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>', "unused"]);
  await instance.respond({ input: "first", tools: [echoTool] });
  await assert.rejects(
    instance.respond({ input: "second", tools: [echoTool] }),
    (error) => error.code === "cuhk_session_busy" && error.status === 409
  );
});

test("tool_choice is enforced locally with one bounded control turn", async () => {
  const toolCall = '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>';
  const { instance, transport } = runtime(["plain text", toolCall]);
  const response = await instance.respond({ input: "must call", tools: [echoTool], tool_choice: "required" });
  assert.equal(response.output[0].type, "function_call");
  assert.equal(transport.calls.length, 2);
});

test("buffered responses emit ordered streaming events", async () => {
  const { instance } = runtime(["streamed"]);
  const response = await instance.respond({ input: "hello", stream: true });
  const events = responseEvents(response);
  assert.equal(events[0].type, "response.created");
  assert.ok(events.some((event) => event.type === "response.output_text.delta"));
  assert.equal(events.at(-1).type, "response.completed");
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_event, index) => index));
});

test("last permitted tool result may produce a final answer", async () => {
  const { instance } = runtime(['<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>', "done"], { maxToolLoops: 1 });
  const first = await instance.respond({ input: "echo", tools: [echoTool] });
  const last = await instance.respond({ input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }] });
  assert.equal(last.output[0].content[0].text, "done");
});

test("upstream failure is not retried and releases local task ownership", async () => {
  const { instance, transport } = runtime([new Error("uncertain delivery"), "fresh"]);
  await assert.rejects(instance.respond({ input: "first" }), /uncertain delivery/);
  assert.equal(transport.calls.length, 1);
  await instance.respond({ input: "new task" });
  assert.equal(transport.calls[1].isNew, true);
});

test("continuation honors changed panel settings and tool choice", async () => {
  const { instance, current, transport } = runtime(['<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>', "done"]);
  const first = await instance.respond({ input: "echo", tools: [echoTool] });
  current.model = "deepseek-v4.1-flash";
  current.thinking = "max";
  await instance.respond({ input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }], tool_choice: "none" });
  assert.equal(transport.calls[1].model, current.model);
  assert.equal(transport.calls[1].thinking, "max");
  assert.match(transport.calls[1].prompt, /tool_choice: none/);
});

test("SSE clients reconstruct arguments once from added item and deltas", async () => {
  const { instance } = runtime(['<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>']);
  const response = await instance.respond({ input: "echo", tools: [echoTool] });
  let argumentsText = "";
  for (const event of responseEvents(response)) {
    if (event.type === "response.output_item.added") argumentsText = event.item.arguments;
    if (event.type === "response.function_call_arguments.delta") argumentsText += event.delta;
  }
  assert.deepEqual(JSON.parse(argumentsText), { value: "a" });
});

test("image input reaches transport while missing tool outputs are rejected", async () => {
  const { instance, transport } = runtime(["I can see it"]);
  const image = "data:image/png;base64,iVBORw0KGgo=";
  const response = await instance.respond({ input: [{ role: "user", content: [{ type: "input_text", text: "describe" }, { type: "input_image", image_url: image }] }] });
  assert.equal(response.output[0].content[0].text, "I can see it");
  assert.deepEqual(transport.calls[0].images, [{ source: image, detail: null }]);
  assert.equal(transport.calls[0].model, "gpt5.6sol");
  assert.match(transport.calls[0].prompt, /Attached images: 1/);
  await assert.rejects(instance.respond({ input: [{ type: "function_call_output", call_id: "x" }] }), RequestError);
  assert.equal(transport.calls.length, 1);
});

test("an image task keeps its vision model through a tool continuation", async () => {
  const image = "data:image/png;base64,AQID";
  const { instance, transport } = runtime([
    '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>',
    "finished"
  ]);
  const first = await instance.respond({
    input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: image }] }],
    tools: [echoTool]
  });
  await instance.respond({ input: [{ type: "function_call_output", call_id: first.output[0].call_id, output: "a" }], tools: [echoTool] });
  assert.deepEqual(transport.calls.map((call) => call.model), ["gpt5.6sol", "gpt5.6sol"]);
});

test("unsupported schema constraints fail before an upstream request", async () => {
  const { instance, transport } = runtime([]);
  const constrained = structuredClone(echoTool);
  constrained.parameters.properties.value.uniqueItems = true;
  await assert.rejects(instance.respond({ input: "echo", tools: [constrained] }), /unsupported schema keyword: uniqueItems/);
  assert.equal(transport.calls.length, 0);
});

// --- one CLI conversation == one CUHK web conversation ---------------------

test("conversationKeyOf prefers prompt_cache_key and falls back to client_metadata", () => {
  assert.equal(conversationKeyOf({ prompt_cache_key: "thread-1" }), "thread-1");
  assert.equal(conversationKeyOf({ client_metadata: { session_id: "s-1" } }), "s-1");
  assert.equal(conversationKeyOf({ client_metadata: { thread_id: "t-1" } }), "t-1");
  assert.equal(conversationKeyOf({ client_metadata: "not-an-object" }), null);
  assert.equal(conversationKeyOf({}), null);
});

test("newHistoryItems returns only the undelivered tail", () => {
  const item = (role, text) => ({ role, text });
  const delivered = [item("developer", "rules"), item("user", "one")];
  const digests = delivered.map(itemDigest);

  assert.deepEqual(
    newHistoryItems(digests, [item("developer", "rules"), item("user", "one"), item("assistant", "answer"), item("user", "two")]).map((entry) => entry.text),
    ["answer", "two"]
  );
  // A shifted developer block still anchors on the last delivered item.
  assert.deepEqual(
    newHistoryItems(digests, [item("developer", "rules changed"), item("user", "one"), item("assistant", "answer")]).map((entry) => entry.text),
    ["answer"]
  );
  // Nothing in common means the history was rewritten; start a new web conversation.
  assert.equal(newHistoryItems(digests, [item("user", "unrelated")]), null);
});

test("one Codex conversation reuses one CUHK web conversation and sends only new items", async () => {
  const key = "01a0affa-8728-75d1-a2ee-acf58506ef90";
  const { instance, transport } = runtime(["answer one", "answer two"]);

  await instance.respond({ prompt_cache_key: key, instructions: "BASE INSTRUCTIONS", input: "first question" });
  assert.equal(transport.calls[0].isNew, true);
  assert.match(transport.calls[0].prompt, /BASE INSTRUCTIONS/);
  assert.match(transport.calls[0].prompt, /first question/);

  await instance.respond({
    prompt_cache_key: key,
    instructions: "BASE INSTRUCTIONS",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first question" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer one" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "second question" }] }
    ]
  });
  assert.equal(transport.calls[1].isNew, false);
  assert.match(transport.calls[1].prompt, /CONTINUATION/);
  assert.match(transport.calls[1].prompt, /second question/);
  // Bootstrap-only material and the web model's own reply are not replayed.
  assert.doesNotMatch(transport.calls[1].prompt, /BASE INSTRUCTIONS/);
  assert.doesNotMatch(transport.calls[1].prompt, /first question/);
  assert.doesNotMatch(transport.calls[1].prompt, /answer one/);
});

test("different Codex conversations never share a CUHK web conversation", async () => {
  const { instance, transport } = runtime(["a", "b"]);
  await instance.respond({ prompt_cache_key: "thread-a", input: "hi" });
  await instance.respond({ prompt_cache_key: "thread-b", input: "hi" });
  assert.equal(transport.calls[0].isNew, true);
  assert.equal(transport.calls[1].isNew, true);
});

test("a rewritten replay starts a fresh CUHK web conversation", async () => {
  const { instance, transport } = runtime(["a", "b"]);
  const key = "thread-rewritten";
  await instance.respond({ prompt_cache_key: key, input: "original question" });
  await instance.respond({ prompt_cache_key: key, input: "a completely different question" });
  assert.equal(transport.calls[1].isNew, true);
});

test("tool catalog is injected once per web conversation and refreshed on change", async () => {
  const key = "thread-catalog";
  const extraTool = { type: "function", name: "other", parameters: { type: "object", properties: {}, additionalProperties: false } };
  const { instance, transport } = runtime(["a", "b", "c"]);

  await instance.respond({ prompt_cache_key: key, input: "one", tools: [echoTool] });
  assert.match(transport.calls[0].prompt, /TOOL PROTOCOL v1/);

  await instance.respond({
    prompt_cache_key: key,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] }
    ],
    tools: [echoTool]
  });
  assert.equal(transport.calls[1].isNew, false);
  assert.match(transport.calls[1].prompt, /TOOL PROTOCOL v1 REMINDER/);
  assert.doesNotMatch(transport.calls[1].prompt, /"name":"echo"/);
  assert.match(transport.calls[1].prompt, /tool_choice: auto/);

  await instance.respond({
    prompt_cache_key: key,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "b" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "three" }] }
    ],
    tools: [echoTool, extraTool]
  });
  assert.equal(transport.calls[2].isNew, false);
  assert.match(transport.calls[2].prompt, /TOOL PROTOCOL v1/);
  assert.match(transport.calls[2].prompt, /"name":"other"/);
});

test("glm continuation uses a compact reminder and refreshes the catalog only on change", async () => {
  const key = "thread-glm-catalog";
  const extraTool = { type: "function", name: "other", parameters: { type: "object", properties: {}, additionalProperties: false } };
  const { instance, transport } = runtime(["a", "b", "c"], { model: "glm5.3flash", thinking: "high" });

  await instance.respond({ prompt_cache_key: key, input: "one", tools: [echoTool] });
  assert.match(transport.calls[0].prompt, /CUHK TOOL PROTOCOL v1 - GLM MODE/);
  assert.match(transport.calls[0].prompt, /"name":"echo"/);

  await instance.respond({
    prompt_cache_key: key,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] }
    ],
    tools: [echoTool]
  });
  const continuation = transport.calls[1].prompt;
  assert.equal(transport.calls[1].isNew, false);
  assert.match(continuation, /CUHK TOOL PROTOCOL v1 REMINDER/);
  assert.match(continuation, /catalog_fingerprint:/);
  assert.match(continuation, /USER:\n.*two/s);
  assert.match(continuation, /tool_choice: auto/);
  assert.doesNotMatch(continuation, /CUHK TOOL PROTOCOL v1 - GLM MODE/);
  assert.doesNotMatch(continuation, /catalog: /);
  assert.doesNotMatch(continuation, /"name":"echo"/);
  assert.ok(continuation.length < 600, `glm continuation should be compact, got ${continuation.length}`);

  await instance.respond({
    prompt_cache_key: key,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "b" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "three" }] }
    ],
    tools: [echoTool, extraTool]
  });
  assert.equal(transport.calls[2].isNew, false);
  assert.match(transport.calls[2].prompt, /CUHK TOOL PROTOCOL v1 - GLM MODE/);
  assert.match(transport.calls[2].prompt, /"name":"other"/);
});

test("tool-result turns continue the reused web conversation", async () => {
  const key = "thread-tool-loop";
  const { instance, transport } = runtime([
    '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>',
    "final"
  ]);
  const first = await instance.respond({ prompt_cache_key: key, input: "use echo", tools: [echoTool] });
  await instance.respond({
    prompt_cache_key: key,
    input: [
      first.output[0],
      { type: "function_call_output", call_id: first.output[0].call_id, output: "a" }
    ]
  });
  assert.equal(transport.calls[0].isNew, true);
  assert.equal(transport.calls[1].isNew, false);
  assert.match(transport.calls[1].prompt, /TOOL RESULT v1/);
});

test("conversation reuse can be turned off in the panel configuration", async () => {
  const key = "thread-off";
  const { instance, transport } = runtime(["a", "b"], { conversationReuse: false });
  await instance.respond({ prompt_cache_key: key, input: "one" });
  await instance.respond({
    prompt_cache_key: key,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] }
    ]
  });
  assert.equal(transport.calls[0].isNew, true);
  assert.equal(transport.calls[1].isNew, true);
});

test("the ledger survives a gateway restart without persisting prompt text", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const persistPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cuhk-ledger-")), "conversations.json");
  const key = "thread-restart";

  const first = runtime(["a"], {}, persistPath);
  await first.instance.respond({ prompt_cache_key: key, input: "secret question one" });
  assert.equal(first.transport.calls[0].isNew, true);
  const persisted = fs.readFileSync(persistPath, "utf8");
  assert.doesNotMatch(persisted, /secret question one/);
  assert.match(persisted, new RegExp(key));

  const second = runtime(["b"], {}, persistPath);
  await second.instance.respond({
    prompt_cache_key: key,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "secret question one" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "follow up" }] }
    ]
  });
  assert.equal(second.transport.calls[0].isNew, false);
  assert.match(second.transport.calls[0].prompt, /follow up/);
});

test("an uncertain bootstrap is not recorded, so the next turn bootstraps again", async () => {
  const key = "thread-uncertain";
  const { instance, transport } = runtime([new Error("uncertain delivery"), "ok"]);
  await assert.rejects(instance.respond({ prompt_cache_key: key, input: "one" }), /uncertain delivery/);
  await instance.respond({
    prompt_cache_key: key,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] }
    ]
  });
  assert.equal(transport.calls[1].isNew, true);
});

// --- recovering from stalled / interrupted browser turns --------------------

test("a stale turn is abandoned instead of blocking every later turn", async () => {
  let clock = 1000;
  const transport = new FakeTransport([
    '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>',
    "fresh start"
  ]);
  const instance = new CuhkProviderRuntime({
    configStore: { read: () => ({ ...baseConfig }) },
    transport,
    now: () => clock,
    staleTurnMs: 1000
  });
  const key = "thread-stale";

  const first = await instance.respond({ prompt_cache_key: key, input: "echo", tools: [echoTool] });
  assert.equal(first.output[0].type, "function_call");

  // Still inside the budget: interleaving stays a 409.
  await assert.rejects(
    instance.respond({ prompt_cache_key: "other-task", input: "second", tools: [echoTool] }),
    (error) => error.code === "cuhk_session_busy" && error.status === 409
  );

  // Past the budget the abandoned tool result is dropped and a fresh chat starts,
  // so the user can recover without restarting the gateway.
  clock += 5000;
  const recovered = await instance.respond({ prompt_cache_key: "other-task", input: "second", tools: [echoTool] });
  assert.equal(recovered.output[0].content[0].text, "fresh start");
  assert.equal(transport.calls[1].isNew, true);
  assert.equal(instance.conversations.has("other-task"), true);
});

test("a disconnected client can retrieve the completed response without a new web chat", async () => {
  const key = "thread-abort";
  const requestState = { aborted: false };
  const transport = new FakeTransport(["answer one", "answer two", "answer three"]);
  const instance = new CuhkProviderRuntime({ configStore: { read: () => ({ ...baseConfig }) }, transport });

  await instance.respond({ prompt_cache_key: key, input: "one" });
  assert.equal(instance.conversations.has(key), true);

  // Simulate Ctrl+C in Codex while OpenCLI is still working on turn two.
  transport.onAsk = () => { requestState.aborted = true; };
  const replay = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer one" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] }
  ];
  const original = await instance.respond({ prompt_cache_key: key, input: replay }, requestState);
  assert.equal(instance.conversations.has(key), true);

  transport.onAsk = null;
  const retry = await instance.respond({ prompt_cache_key: key, input: replay });
  assert.deepEqual(retry, original);
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[1].isNew, false);
});


for (const model of ['gpt5.6sol', 'glm5.3flash', 'deepseek-v4.1-flash', 'kimi-k3', 'qwen3.8-27b', 'seed2.1pro', 'gemini3.8flash', 'gpt6sol', 'gpt6luna']) {
  test(`${model}: second user task with replayed tool history stays in the same web conversation`, async () => {
    const tool = '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>';
    const { instance, transport } = runtime([tool, 'first done', tool, 'second done'], { model });
    const body = { prompt_cache_key: `multi-${model}`, tools: [echoTool] };
    const input = [{ role: 'user', content: 'query first file' }];
    const first = await instance.respond({ ...body, input: structuredClone(input) });
    input.push(first.output[0], { type: 'function_call_output', call_id: first.output[0].call_id, output: 'first file' });
    const done = await instance.respond({ ...body, input: structuredClone(input) });
    input.push(done.output[0], { role: 'user', content: 'query second file' });
    const second = await instance.respond({ ...body, input: structuredClone(input) });
    assert.equal(second.output[0].type, 'function_call');
    input.push(second.output[0], { type: 'function_call_output', call_id: second.output[0].call_id, output: 'second file' });
    const final = await instance.respond({ ...body, input });
    assert.equal(final.output[0].content[0].text, 'second done');
    assert.deepEqual(transport.calls.map(call => call.isNew), [true, false, false, false]);
    assert.match(transport.calls[2].prompt, /query second file/);
    assert.doesNotMatch(transport.calls[2].prompt, /query first file|first file/);
  });
}

test('concurrent HTTP retries share one browser operation and identical call ids', async () => {
  const { instance, transport } = runtime([]);
  let resolve;
  transport.ask = async input => {
    transport.calls.push(input);
    return new Promise(done => { resolve = done; });
  };
  const body = { prompt_cache_key: 'retry', input: 'run echo', tools: [echoTool] };
  const one = instance.respond(body);
  const two = instance.respond(body);
  await new Promise(done => setImmediate(done));
  assert.equal(transport.calls.length, 1);
  resolve({ text: '<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>' });
  const [a, b] = await Promise.all([one, two]);
  assert.deepEqual(a, b);
  assert.deepEqual(await instance.respond(body), a);
  assert.equal(transport.calls.length, 1);
});

test('confirmed empty response recovers once in the same chat and returns its result', async () => {
  const { UpstreamError } = require('../src/errors.cjs');
  const empty = new UpstreamError('empty', { code: 'cuhk_empty_result' });
  const { instance, transport } = runtime([empty, 'recovered']);
  const body = { prompt_cache_key: 'empty', input: 'original task' };
  const result = await instance.respond(body);
  assert.equal(result.output[0].content[0].text, 'recovered');
  assert.deepEqual(transport.calls.map(call => call.isNew), [true, false]);
  assert.doesNotMatch(transport.calls[1].prompt, /original task/);
  assert.match(transport.calls[1].prompt, /本对话/);
  assert.ok(transport.calls[1].prompt.length < 200);
  assert.deepEqual(await instance.respond(body), result);
  assert.equal(transport.calls.length, 2);
});

test('repeated empty and uncertain delivery failures do not resend on HTTP retry', async () => {
  const { UpstreamError } = require('../src/errors.cjs');
  for (const code of ['cuhk_empty_result', 'cuhk_timeout']) {
    const error = new UpstreamError(code, { code });
    const { instance, transport } = runtime([error, error]);
    const body = { prompt_cache_key: code, input: 'task' };
    await assert.rejects(instance.respond(body), { code });
    await assert.rejects(instance.respond(body), { code });
    assert.equal(transport.calls.length, code === 'cuhk_empty_result' ? 2 : 1);
  }
});

test('tool-result HTTP retry returns the same final response without another browser write', async () => {
  const { instance, transport } = runtime(['<tool_call>{"name":"echo","arguments":{"value":"a"}}</tool_call>', 'done']);
  const body = { prompt_cache_key: 'tool-retry', tools: [echoTool] };
  const first = await instance.respond({ ...body, input: 'echo' });
  const input = [{ type: 'function_call_output', call_id: first.output[0].call_id, output: 'a' }];
  const result = await instance.respond({ ...body, input });
  assert.deepEqual(await instance.respond({ ...body, input }), result);
  assert.equal(transport.calls.length, 2);
  await assert.rejects(instance.respond({ ...body, input: [{ ...input[0], output: 'changed' }] }), { code: 'duplicate_tool_result' });
});

test('a late browser operation is never replaced while it still owns the page', async () => {
  let now = 1000;
  let resolve;
  const instance = new CuhkProviderRuntime({
    configStore: { read: () => ({ ...baseConfig }) }, now: () => now, staleTurnMs: 1000,
    transport: { ask: () => new Promise(done => { resolve = done; }) }
  });
  const first = instance.respond({ prompt_cache_key: 'late', input: 'first' });
  await new Promise(done => setImmediate(done));
  now += 5000;
  await assert.rejects(instance.respond({ prompt_cache_key: 'different-task', input: 'second' }), { code: 'cuhk_session_busy' });
  resolve({ text: 'finished' });
  await first;
  assert.equal(instance.conversations.has('late'), true);
});
