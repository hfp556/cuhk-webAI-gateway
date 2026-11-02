"use strict";

const crypto = require("node:crypto");
const { ProtocolError, RequestError } = require("./errors.cjs");

const MAX_CATALOG_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 12;
// CUHK's Markdown-facing models sometimes escape underscores even in a
// standalone protocol envelope. Accept that single renderer artifact only
// inside a candidate envelope; ordinary assistant text is never rewritten.
const TOOL_ENVELOPE = /^\s*<tool(?:\\)?_call>\s*([\s\S]*?)\s*<\/tool(?:\\)?_call>\s*$/u;
// Some school models (notably GLM 5.3 Flash) will not emit a raw <tool_call>
// envelope, but will emit exactly one fenced JSON block when that is the
// documented tool-request form. Accept only a whole-response json/text block.
// The school renderer lengthens a fence when the payload itself contains
// triple backticks (for example a Markdown document with ```cpp examples).
// Accept any fence of at least three backticks and require the closing fence
// to match the opening length.
const FENCED_TOOL_ENVELOPE = /^\s*(`{3,})(?:json|text|cuhk_tool_call)[ \t]*\r?\n([\s\S]*?)\r?\n\1\s*$/u;
// Dedicated model parsers additionally accept the first *valid* fenced JSON
// block even when the model adds a short sentence before or after it.
const FENCED_TOOL_BLOCK = /(`{3,})(?:json|text|cuhk_tool_call)[ \t]*\r?\n([\s\S]*?)\r?\n\1/gu;
// GLM often refuses the tool JSON but is happy to emit a complete PowerShell
// script. In GLM mode the gateway may treat that script as an implicit
// exec_command request and let the Gateway runtime run exactly the script GLM produced.
const FENCED_SCRIPT_BLOCK = /(`{3,})(?:powershell|pwsh|ps1|shell|bash|sh)[ \t]*\r?\n([\s\S]*?)\r?\n\1/giu;
const FENCED_SCRIPT_ENVELOPE = /^\s*(`{3,})(?:powershell|pwsh|ps1|shell|bash|sh)[ \t]*\r?\n([\s\S]*?)\r?\n\1\s*$/iu;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex").slice(0, 24);
}

function normalizeTools(rawTools) {
  if (rawTools === undefined) return [];
  if (!Array.isArray(rawTools)) throw new RequestError("tools must be an array.");
  const names = new Set();
  const expanded = rawTools.flatMap((tool, index) => {
    if (!isObject(tool)) throw new RequestError(`tools[${index}] must be an object.`);
    if (tool.type === "web_search") return [];
    if (tool.type === "namespace") {
      const namespace = typeof tool.name === "string" ? tool.name.trim() : "";
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new RequestError(`Invalid namespace at tools[${index}].`);
      if (!Array.isArray(tool.tools)) throw new RequestError(`tools[${index}] namespace is missing tools.`);
      return tool.tools.flatMap((member, memberIndex) => {
        const label = `tools[${index}].tools[${memberIndex}]`;
        if (namespace === "functions" && member?.type === "custom" && member.name === "exec") {
          return codeModeExecTools(namespace, label);
        }
        // Codex 0.155 ships many namespace members (request_user_input,
        // view_image, collaboration tools, ...). The CUHK web model only
        // needs the bridged shell/patch pair and wait for running cells;
        // forwarding the rest produces a huge catalog that GLM-class models
        // parse poorly and then report as "unknown tool".
        if (namespace === "functions" && member?.type === "function" && member.name === "wait") {
          return [{ member, namespace, label }];
        }
        return [];
      });
    }
    return [{ member: tool, namespace: null, label: `tools[${index}]` }];
  });
  return expanded.map(({ member: tool, namespace, label, bridge }) => {
    let entry;
    if (tool.type === "function") {
      const fn = isObject(tool.function) ? tool.function : tool;
      const name = typeof fn.name === "string" ? fn.name.trim() : "";
      if (!name) throw new RequestError(`${label} is missing a function name.`);
      entry = {
        protocolName: namespace ? `${namespace}__${name}` : name,
        clientName: bridge ? "exec" : name,
        clientType: bridge ? "code_mode_exec" : "function",
        operation: bridge?.operation,
        namespace,
        description: typeof fn.description === "string" ? fn.description : "",
        schema: isObject(fn.parameters) ? fn.parameters : { type: "object", properties: {} }
      };
    } else if (tool.type === "custom" && tool.name === "apply_patch") {
      entry = {
        protocolName: "virtual_apply_patch",
        clientName: "apply_patch",
        clientType: "custom",
        namespace,
        inputField: "patch",
        description: "Apply a patch to workspace files using the client's native patch tool.",
        schema: {
          type: "object",
          properties: { patch: { type: "string", description: "Complete apply_patch payload." } },
          required: ["patch"],
          additionalProperties: false
        }
      };
    } else if (tool.type === "custom") {
      const name = typeof tool.name === "string" ? tool.name.trim() : "";
      if (!name) throw new RequestError(`${label} is missing a custom tool name.`);
      entry = {
        protocolName: namespace ? `${namespace}__${name}` : name,
        clientName: name,
        clientType: "custom",
        namespace,
        inputField: "input",
        description: typeof tool.description === "string" ? tool.description : "",
        schema: {
          type: "object",
          properties: { input: { type: "string", description: "Complete freeform input for the custom tool." } },
          required: ["input"],
          additionalProperties: false
        }
      };
    } else {
      throw new RequestError(`Unsupported tool type at ${label}.`, "unsupported_tool_type");
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(entry.protocolName)) {
      throw new RequestError(`Invalid tool name: ${entry.protocolName}`);
    }
    if (names.has(entry.protocolName)) throw new RequestError(`Duplicate tool name: ${entry.protocolName}`);
    names.add(entry.protocolName);
    assertSchemaShape(entry.schema, 0, `${entry.protocolName}.parameters`);
    return entry;
  });
}

function codeModeExecTools(namespace, label) {
  return [
    {
      namespace,
      label,
      bridge: { operation: "exec_command" },
      member: {
        type: "function",
        name: "exec_command",
        description: "Run one local command. Returns within about 10 seconds with output and, if still running, a session_id. Do not restart a running command: use write_stdin to collect its output. Report progress before polling long jobs.",
        parameters: {
          type: "object",
          properties: {
            cmd: { type: "string", description: "Shell command to execute." },
            yield_time_ms: { type: "integer", minimum: 10000, maximum: 30000 },
            max_output_tokens: { type: "integer", minimum: 1 }
          },
          required: ["cmd"],
          additionalProperties: false
        }
      }
    },
    {
      namespace, label, bridge: { operation: "write_stdin" },
      member: {
        type: "function", name: "write_stdin",
        description: "Read new output from an existing running command using its integer session_id. This is a read-only poll, not a new shell command. A missing exit_code means still running. Do not rerun the original command.",
        parameters: {
          type: "object", properties: {
            session_id: { type: "integer" },
            max_output_tokens: { type: "integer", minimum: 1 }
          }, required: ["session_id"], additionalProperties: false
        }
      }
    },
    {
      namespace,
      label,
      bridge: { operation: "apply_patch" },
      member: {
        type: "function",
        name: "apply_patch",
        description: "Create, update, or delete files inside the Codex workspace with one complete apply_patch patch. For paths outside the workspace (for example the user's Desktop), request exec_command instead.",
        parameters: {
          type: "object",
          properties: { patch: { type: "string", description: "Complete apply_patch payload." } },
          required: ["patch"],
          additionalProperties: false
        }
      }
    }
  ];
}

// Dedicated web-model profiles receive short names such as "exec_command"
// instead of the host-specific "functions__exec_command" wire name. The parser
// still accepts the old names as aliases for replay and repair compatibility.
const SHORT_TOOL_PRESENTATIONS = Object.freeze({
  functions__exec_command: Object.freeze({
    protocolName: "exec_command",
    aliases: ["functions__exec_command"],
    description: "在用户电脑上通过 Gateway 运行时执行一条 shell 命令并返回输出。用于创建、读取、修改文件，或运行命令。你负责决定调用，运行时负责执行。",
    properties: {
      cmd: "要执行的 shell 命令。",
      yield_time_ms: "首次最多等待 10000 毫秒，之后返回进程 session_id；用 write_stdin 继续读取，禁止重复启动。",
      max_output_tokens: "最多返回的输出 token 数。"
    }
  }),
  functions__write_stdin: Object.freeze({
    protocolName: "write_stdin", aliases: ["functions__write_stdin"],
    description: "读取已在运行的命令的新输出。传入上次返回的整数 session_id；不要重新启动扫盘等长命令。没有 exit_code 就说明仍在运行。用户询问进度时先依据已有输出回答，不要再运行其他命令。",
    properties: { session_id: "已有命令的整数 session_id，不是 Code Mode 的 cell_id。", max_output_tokens: "最多返回的输出 token 数。" }
  }),
  functions__apply_patch: Object.freeze({
    protocolName: "apply_patch",
    aliases: ["functions__apply_patch"],
    description: "通过 Gateway 运行时的 apply_patch 在工作区内创建、修改或删除文件。工作区外的绝对路径请使用 exec_command。",
    properties: { patch: "完整的 apply_patch 内容。" }
  }),
  functions__wait: Object.freeze({
    protocolName: "wait",
    aliases: ["functions__wait"],
    description: "等待一个仍在运行的 exec_command 单元并获取新输出或完成结果。需要 cell_id。",
    properties: {
      cell_id: "正在运行的 exec_command 单元 ID。",
      terminate: "true 表示终止该单元；false 或省略表示继续等待输出。",
      yield_time_ms: "继续等待的毫秒数。",
      max_tokens: "本次最多返回的 token 数。"
    }
  }),
  virtual_apply_patch: Object.freeze({
    protocolName: "apply_patch",
    aliases: ["virtual_apply_patch"],
    description: "通过 Gateway 运行时的 apply_patch 在工作区内创建、修改或删除文件。工作区外的绝对路径请使用 exec_command。",
    properties: { patch: "完整的 apply_patch 内容。" }
  })
});

function adaptToolsForModel(tools, style) {
  if (!isDedicatedStyle(style)) return tools.map((tool) => ({ ...tool, aliases: [] }));
  return tools.map((tool) => {
    const presentation = SHORT_TOOL_PRESENTATIONS[tool.protocolName];
    if (!presentation) return { ...tool, aliases: [] };
    const schema = { ...tool.schema, properties: { ...(tool.schema?.properties || {}) } };
    for (const [name, description] of Object.entries(presentation.properties)) {
      if (schema.properties[name]) schema.properties[name] = { ...schema.properties[name], description };
    }
    return {
      ...tool,
      protocolName: presentation.protocolName,
      aliases: presentation.aliases,
      description: presentation.description,
      schema
    };
  });
}


function assertSchemaShape(schema, depth, label) {
  if (depth > MAX_SCHEMA_DEPTH) throw new RequestError(`${label} exceeds maximum nesting depth.`);
  if (!isObject(schema)) throw new RequestError(`${label} must be an object schema.`);
  const supported = new Set(["$schema", "type", "description", "title", "default", "enum", "properties", "propertyNames", "required", "additionalProperties", "allOf", "format", "items", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern", "minLength", "maxLength", "minItems", "maxItems", "encrypted"]);
  for (const key of Object.keys(schema)) {
    if (!supported.has(key)) throw new RequestError(`${label} uses unsupported schema keyword: ${key}`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean" && !isObject(schema.additionalProperties)) {
    throw new RequestError(`${label}.additionalProperties must be boolean or an object schema.`);
  }
  if (isObject(schema.additionalProperties)) assertSchemaShape(schema.additionalProperties, depth + 1, `${label}.additionalProperties`);
  if (schema.propertyNames !== undefined) assertSchemaShape(schema.propertyNames, depth + 1, `${label}.propertyNames`);
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf) || !schema.allOf.length) throw new RequestError(`${label}.allOf must be a nonempty array.`);
    schema.allOf.forEach((child, index) => assertSchemaShape(child, depth + 1, `${label}.allOf[${index}]`));
  }
  if (schema.format !== undefined && schema.format !== "uri") throw new RequestError(`${label} uses unsupported schema format: ${schema.format}`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string"))) {
    throw new RequestError(`${label}.required must be an array of names.`);
  }
  const allowedTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
  if (schema.type !== undefined && !allowedTypes.has(schema.type)) {
    throw new RequestError(`${label} uses unsupported schema type: ${schema.type}`);
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) throw new RequestError(`${label}.properties must be an object.`);
    for (const [name, child] of Object.entries(schema.properties)) assertSchemaShape(child, depth + 1, `${label}.${name}`);
  }
  if (schema.items !== undefined) assertSchemaShape(schema.items, depth + 1, `${label}.items`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new RequestError(`${label}.pattern must be a string.`);
    try { new RegExp(schema.pattern); } catch { throw new RequestError(`${label}.pattern is invalid.`); }
  }
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))) throw new RequestError(`${label}.${key} must be a number.`);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new RequestError(`${label}.enum must be an array.`);
}

function compactSchema(schema) {
  const out = {};
  for (const key of ["type", "description", "enum", "required", "additionalProperties", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern", "minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (isObject(schema.properties)) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, compactSchema(value)]));
  }
  if (isObject(schema.items)) out.items = compactSchema(schema.items);
  if (isObject(schema.additionalProperties)) out.additionalProperties = compactSchema(schema.additionalProperties);
  if (isObject(schema.propertyNames)) out.propertyNames = compactSchema(schema.propertyNames);
  if (Array.isArray(schema.allOf)) out.allOf = schema.allOf.map(compactSchema);
  if (schema.format !== undefined) out.format = schema.format;
  return out;
}

function toolExample(tool) {
  const name = tool?.name || "tool_name";
  if (name === "exec_command") return JSON.stringify({ name, arguments: { cmd: "<shell command>" } });
  if (name === "apply_patch") return JSON.stringify({ name, arguments: { patch: "<complete apply_patch payload>" } });
  if (name === "wait") return JSON.stringify({ name, arguments: { cell_id: "<cell_id>" } });
  return JSON.stringify({ name, arguments: {} });
}

function genericCatalogPrompt(id, normalized) {
  return [
    "TOOL PROTOCOL v1",
    `catalog_fingerprint: ${id}`,
    "These tools are capabilities of your current Agent environment. You decide when to call them and remain responsible for the complete task. The Gateway runtime executes each request on the user's computer and sends the real result back to you.",
    "If the task needs command execution, file access, or file changes, request a catalog tool. Do not answer that you cannot access the computer or run commands: request the matching tool instead.",
    "You may either answer normally when no tool is needed, or request exactly one tool.",
    "A tool request MUST be the entire response and use either the raw envelope:",
    "<tool_call>",
    '{"name":"tool_name","arguments":{}}',
    "</tool_call>",
    "or exactly one fenced JSON code block tagged json:",
    "```json",
    '{"name":"tool_name","arguments":{}}',
    "```",
    "Do not add commentary, Markdown around the envelope, or call identifiers. Do not invent tools.",
    `Available tool names (copy one exactly): ${normalized.map((tool) => tool.name).join(", ")}`,
    `catalog: ${JSON.stringify(normalized)}`
  ].join("\n");
}

function glmCatalogPrompt(id, normalized) {
  const example = toolExample(normalized[0]);
  return [
    "CUHK TOOL PROTOCOL v1 - GLM MODE",
    `catalog_fingerprint: ${id}`,
    "下面的工具目录是当前 Agent 环境提供给你的外部能力。需要执行命令或访问文件时，由你决定调用哪个工具；Gateway 运行时会执行请求并把真实结果返回给你，你随后继续负责整个任务直到最终答复。",
    "文件修改规则：JSON 必须用 ConvertFrom-Json/ConvertTo-Json 或标准 JSON 序列化器修改，禁止手工正则转义 JSON。保留字段要在写入后逐值核对；用户要求精确字符时检查字符串长度和字符码，不把 JSON 外层引号当成字段值。",
    "验证失败规则：读取真实 exit_code 和错误信息，先调整方案再重试；相同失败不得盲目循环。只有独立读回或验证器证实后才能声明文件正确。最终文字回复不要附加脚本、undefined 或未闭合代码围栏。",
    "如果用户任务需要本地命令执行、文件访问或文件修改，从下面两种输出格式中选择一种，并只输出该格式：",
    "格式 A（工具 JSON）：只输出一个 ```json 代码块，内容必须是：",
    "```json",
    example,
    "```",
    "格式 B（PowerShell 脚本）：只输出一个 ```powershell 代码块，包含完成该任务的完整 PowerShell 脚本。",
    "```powershell",
    "<# 在这里写完整 PowerShell 脚本 #>",
    "```",
    "不要添加解释、前后缀或 Markdown 表格。不要说工具不存在或已被拒绝：按协议输出调用即可，执行由 Gateway 运行时完成。",
    `可用工具（原样复制一个）：${normalized.map((tool) => tool.name).join(", ")}`,
    `catalog: ${JSON.stringify(normalized)}`
  ].join("\n");
}

function dedicatedJsonCatalogPrompt(style, id, normalized) {
  const example = toolExample(normalized[0]);
  const header = `CUHK TOOL PROTOCOL v1 - ${style.toUpperCase()} MODE`;
  if (style === "seed") {
    return [
      header,
      `catalog_fingerprint: ${id}`,
      "下面的目录定义了当前 Agent 环境中可用的本地工具。需要本地命令或文件操作时，由你选择并调用一个目录工具；Gateway 运行时会返回真实结果，你收到结果后继续完成任务。",
      "学校页面标注的原生工具调用能力只对应平台预置工具，并不自动包含本目录。不要用 web_search、image_tool、mind_map 或任何未列出的平台工具代替目录中的本地工具。",
      "没有收到工具结果前不得声称操作成功。",
      "工具请求必须是整条回复，只包含一个 JSON 代码块：",
      "```json",
      example,
      "```",
      "复制准确工具名，arguments 必须符合 schema。不要添加解释，不要输出脚本代码块，不要把结构化输出示例当成执行结果。",
      `可用本地工具（原样复制一个）：${normalized.map((tool) => tool.name).join(", ")}`,
      `catalog: ${JSON.stringify(normalized)}`
    ].join("\n");
  }
  if (style === "qwen") {
    return [
      header,
      `catalog_fingerprint: ${id}`,
      "你是 Qwen3.8 27B（本地版）主 Agent。下面目录是 Gateway 提供给你的本地工具；需要命令执行、文件读取或文件修改时，你可以自行选择其中一个工具，Gateway 会执行并返回真实结果。",
      "学校页面自带的 web_search、image_tool 等平台工具不等于本目录中的本地工具。不要输出 Qwen 原生 function call/tool_call 对象；本桥接只接受下面的文本 JSON 协议。",
      "工具请求必须是整条回复，只包含一个 JSON 代码块：",
      "```json",
      example,
      "```",
      "复制准确工具名，arguments 必须符合 schema。不要添加解释或脚本代码块；收到真实工具结果前不得声称本地操作成功。",
      `可用本地工具（原样复制一个）：${normalized.map((tool) => tool.name).join(", ")}`,
      `catalog: ${JSON.stringify(normalized)}`
    ].join("\n");
  }
  if (style === "gemini" || style.startsWith("gpt6-")) {
    const syntaxWarning = style === "gemini"
      ? "Do not emit Gemini/Google native function-call syntax; this gateway accepts only the JSON text block below."
      : "Do not emit OpenAI native function-call objects; this CUHK bridge accepts only the JSON text block below.";
    return [
      header,
      `catalog_fingerprint: ${id}`,
      "The catalog below defines the local tools available in your current Agent environment. When local commands or file access are needed, choose exactly one catalog tool; the Gateway runtime will execute the request and return the real result so you can continue the task.",
      syntaxWarning,
      "The tool request must be your entire response and contain exactly one fenced JSON block:",
      "```json",
      example,
      "```",
      "Copy a tool name exactly and make arguments conform to its schema. Add no prose or script fence. Never claim local success before receiving a tool result.",
      `Available local tools (copy one exactly): ${normalized.map((tool) => tool.name).join(", ")}`,
      `catalog: ${JSON.stringify(normalized)}`
    ].join("\n");
  }
  return [
    header,
    `catalog_fingerprint: ${id}`,
    "下面的目录定义了当前 Agent 环境中可用的本地工具。需要执行命令或访问文件时，由你选择并调用目录工具；Gateway 运行时会把真实结果返回给你，你随后继续完成任务。不要把计划或示例冒充已经执行的结果。",
    "每次最多调用一个工具。工具调用必须只包含一个 JSON 代码块，不能在代码块前后添加解释：",
    "```json",
    example,
    "```",
    "arguments 必须是符合目录 schema 的 JSON 对象；复制准确工具名，不要发明工具，不要输出 PowerShell/脚本代码块来代替工具调用。",
    "读取真实 exit_code 和错误信息；失败时先调整方案再重试，不得盲目重复。只有工具结果或独立验证证实后，才能宣称本地操作成功。",
    `可用工具（原样复制一个）：${normalized.map((tool) => tool.name).join(", ")}`,
    `catalog: ${JSON.stringify(normalized)}`
  ].join("\n");
}

function isDedicatedStyle(style) {
  return ["glm", "deepseek", "kimi", "qwen", "seed", "gemini", "gpt6-sol", "gpt6-luna"].includes(style);
}

function compileCatalog(tools, options = {}) {
  const requestedStyle = String(options.style || "generic");
  const style = isDedicatedStyle(requestedStyle) ? requestedStyle : "generic";
  const normalized = tools.map((tool) => ({
    name: tool.protocolName,
    description: tool.description,
    parameters: compactSchema(tool.schema)
  }));
  const id = fingerprint(normalized);
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, "utf8") > MAX_CATALOG_BYTES) throw new RequestError("Tool catalog is too large.");
  const prompt = style === "glm"
    ? glmCatalogPrompt(id, normalized)
    : style !== "generic"
      ? dedicatedJsonCatalogPrompt(style, id, normalized)
      : genericCatalogPrompt(id, normalized);
  return { fingerprint: id, normalized, prompt, style };
}

function looksLikeToolAttempt(text) {
  return /<\/?tool(?:\\)?_call>/u.test(text);
}

function toolForRequestName(tools, name) {
  return tools.find((candidate) => candidate.protocolName === name || Boolean(candidate.aliases?.includes(name)));
}

function parseToolPayload(payload, tools) {
  let value;
  try {
    value = JSON.parse(String(payload).replace(/\\_/gu, "_"));
  } catch {
    throw new ProtocolError("Assistant tool envelope contains invalid JSON.");
  }
  if (!isObject(value) || typeof value.name !== "string" || !isObject(value.arguments)) {
    throw new ProtocolError("Assistant tool envelope must contain name and an arguments object.");
  }
  const tool = toolForRequestName(tools, value.name);
  if (!tool) throw new ProtocolError(`Assistant requested unknown tool: ${value.name}`);
  const argumentJson = JSON.stringify(value.arguments);
  if (Buffer.byteLength(argumentJson, "utf8") > MAX_ARGUMENT_BYTES) throw new ProtocolError("Tool arguments are too large.");
  const validationError = validateValue(value.arguments, tool.schema, "$", 0);
  if (validationError) throw new ProtocolError(`Invalid arguments for ${tool.protocolName}: ${validationError}`);
  return { tool, arguments: value.arguments, argumentJson };
}

function parseScriptPayload(script, tools, language = "powershell") {
  const execTool = tools.find((candidate) => candidate.protocolName === "exec_command" || candidate.protocolName === "functions__exec_command")
    || tools.find(candidate => candidate.clientName === "Bash" && candidate.schema.properties?.command?.type === "string");
  if (!execTool) return null;
  const source = String(script || "").trim();
  const argumentsValue = execTool.clientName === "Bash"
    ? { command: /^(?:powershell|pwsh|ps1)$/i.test(language)
      ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(source, "utf16le").toString("base64")}` : source }
    : { cmd: source };
  const argumentJson = JSON.stringify(argumentsValue);
  if (Buffer.byteLength(argumentJson, "utf8") > MAX_ARGUMENT_BYTES) throw new ProtocolError("PowerShell script is too large.");
  const validationError = validateValue(argumentsValue, execTool.schema, "$", 0);
  if (validationError) throw new ProtocolError(`Invalid PowerShell script for ${execTool.protocolName}: ${validationError}`);
  return { tool: execTool, arguments: argumentsValue, argumentJson, synthetic: "script" };
}

function parseToolCall(text, tools, options = {}) {
  const raw = String(text);
  const envelope = TOOL_ENVELOPE.exec(raw);
  if (envelope) return parseToolPayload(envelope[1], tools);
  const requestedStyle = String(options.style || "generic");
  const style = isDedicatedStyle(requestedStyle) ? requestedStyle : "generic";
  if (isDedicatedStyle(style)) {
    // Dedicated model modes accept a valid fenced block even with a sentence
    // around it. Try every block and execute only the first one that names a
    // known tool and validates. Prose alone never becomes a call.
    let firstError = null;
    for (const match of raw.matchAll(FENCED_TOOL_BLOCK)) {
      try {
        return parseToolPayload(match[2], tools);
      } catch (error) {
        if (error instanceof ProtocolError && !firstError) firstError = error;
      }
    }
    if (style === "glm" && options.allowScript !== false) {
      const wholeScript = FENCED_SCRIPT_ENVELOPE.exec(raw);
      const scriptMatches = wholeScript
        ? [wholeScript]
        : (!options.scriptStrict && options.allowScriptCommentary ? [...raw.matchAll(FENCED_SCRIPT_BLOCK)] : []);
      for (const match of scriptMatches) {
        const language = /`{3,}(\w+)/.exec(match[0])?.[1] || "powershell";
        const parsedScript = parseScriptPayload(match[2], tools, language);
        if (parsedScript) return parsedScript;
      }
    }
    if (firstError) throw firstError;
    if (looksLikeToolAttempt(raw)) throw new ProtocolError("Assistant produced a malformed TOOL PROTOCOL v1 envelope.");
    return null;
  }
  const fenced = FENCED_TOOL_ENVELOPE.exec(raw);
  if (!fenced) {
    if (looksLikeToolAttempt(raw)) throw new ProtocolError("Assistant produced a malformed TOOL PROTOCOL v1 envelope.");
    return null;
  }
  return parseToolPayload(fenced[2], tools);
}

function validateValue(value, schema, path, depth) {
  if (depth > MAX_SCHEMA_DEPTH) return `${path} exceeds maximum nesting depth`;
  for (const child of schema.allOf || []) {
    const error = validateValue(value, child, path, depth + 1);
    if (error) return error;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => JSON.stringify(canonicalize(candidate)) === JSON.stringify(canonicalize(value)))) return `${path} is not an allowed enum value`;
  const type = schema.type;
  if (type === "object" || (type === undefined && isObject(value))) {
    if (!isObject(value)) return `${path} must be an object`;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) if (!Object.hasOwn(value, name)) return `${path}.${name} is required`;
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [name, childValue] of Object.entries(value)) {
      if (schema.propertyNames) {
        const error = validateValue(name, schema.propertyNames, `${path} property name`, depth + 1);
        if (error) return error;
      }
      if (!Object.hasOwn(properties, name) && isObject(schema.additionalProperties)) {
        const error = validateValue(childValue, schema.additionalProperties, `${path}.${name}`, depth + 1);
        if (error) return error;
      }
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((name) => !Object.hasOwn(properties, name));
      if (extra) return `${path}.${extra} is not allowed`;
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) {
        const error = validateValue(value[name], child, `${path}.${name}`, depth + 1);
        if (error) return error;
      }
    }
  } else if (type === "array" || (type === undefined && Array.isArray(value))) {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${path} has too few items`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} has too many items`;
    if (isObject(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateValue(value[index], schema.items, `${path}[${index}]`, depth + 1);
        if (error) return error;
      }
    }
  } else if (type === "string" || (type === undefined && typeof value === "string")) {
    if (typeof value !== "string") return `${path} must be a string`;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return `${path} does not match pattern`;
    if (schema.format === "uri") {
      if (/[\s\u0000-\u001f\u007f<>"{}|\\^`]/u.test(value) || /%(?![0-9a-f]{2})/iu.test(value)) return `${path} must be an absolute URI`;
      try { new URL(value); } catch { return `${path} must be an absolute URI`; }
    }
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${path} is too short`;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${path} is too long`;
  } else if (type === "integer" && !Number.isInteger(value)) return `${path} must be an integer`;
  else if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${path} must be a number`;
  else if (type === "boolean" && typeof value !== "boolean") return `${path} must be a boolean`;
  else if (type === "null" && value !== null) return `${path} must be null`;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above maximum`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${path} is not above exclusive minimum`;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return `${path} is not below exclusive maximum`;
  }
  return null;
}

module.exports = { adaptToolsForModel, compileCatalog, fingerprint, normalizeTools, parseToolCall, validateValue };
