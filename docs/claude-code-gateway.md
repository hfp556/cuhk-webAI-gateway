# Claude Code Gateway adaptation

Claude Code and Codex share the CUHK provider runtime and authenticated OpenCLI transport. Claude uses native Anthropic Messages; Codex continues using Responses. The control panel locks the upstream model/thinking selection; Claude's `cuhk-gateway` label is a routing alias.

## Launch

Open this checkout's `CUHK-AI-Settings.cmd`, choose a working directory/model/thinking level, and use **开始新对话（Codex）**, **继续上次对话（Codex）** or **改用 Claude Code 对话**. Every button saves settings, starts Gateway and opens a terminal in the selected directory. The model and thinking level chosen in the panel are the upstream selection; the CLI-side model name is only a routing alias. Claude starts a fresh interactive session even with no history; its native `/resume` command selects previous sessions. Codex keeps its native cwd-filtered `resume` picker, and falls back to a new conversation when the selected folder has no history yet.

```powershell
.\bin\cuhk-codex-launch.cmd
.\bin\cuhk-claude-launch.cmd
# With Gateway running:
.\bin\cuhk-claude.cmd -p "Inspect this project" --output-format json
```

Claude sessions/config live in `gateway/runtime-state/claude-home`, separate from normal `~/.claude`, without copied subscription credentials. The wrapper reads the instance's dynamic port/key, pins routing at CLI settings precedence, clears inherited alternate-provider credentials and supplies loopback `NO_PROXY`. Project tools/permissions still load; project route variables cannot redirect this wrapper. Temporary CLI settings containing the key stay in this ignored directory, are removed on normal exit, and dead-process leftovers are cleaned on the next launch. Organization-managed policy remains authoritative.

## Verified contract

- Authenticated `POST /v1/messages` and `/messages`, JSON and SSE; `count_tokens` suffix routes return local byte-based estimates without web calls.
- Text/system blocks, Claude Markdown environment, assistant tool/history/thinking replay, input images, native `tool_use`/`tool_result` IDs, text tool errors and ordered new user messages.
- `auto`, `none`, `any` and named `tool` choices; one tool per turn, executed by the client under its permissions.
- Native Messages SSE: message/content block lifecycle, ping/error, no Responses `[DONE]`. Completed web turns remain buffered before content events.
- JSON/legacy `metadata.user_id` session IDs map to namespaced conversation keys. Account/device IDs never identify a session. Tool matching, durable digest-ledger URLs, idempotent retries, ownership and bounded arbitration reuse the shared runtime.
- Native schema annotations, patterns, exclusive numeric bounds, `allOf`, `propertyNames`, schema-valued `additionalProperties` and absolute URI validation retain their constraints. The regression fixture contains the real interactive CLI's 25 tool schemas, including AskUserQuestion and SendMessage. Unsupported semantics fail explicitly.
- Interactive session-title requests use bounded local metadata generation. Their shared session ID never queues an instruction into the foreground task or opens an extra school conversation.
- GLM PowerShell fences map to Claude Bash via UTF-16LE `-EncodedCommand`; shell fences remain shell. Qwen retains its dedicated JSON profile. Input images use the existing configured image-model fallback throughout tool continuation.

Usage reflects the school page's context percentage on a 100k display scale, not billed tokens. The wrapper pins the custom alias's context window to the same scale, overriding Claude's unknown-model 200k fallback. This is a display calibration, not the upstream model's raw tokenizer limit. Claude Code's estimated dollar cost for this local alias is not a CUHK charge. Client thinking settings do not override locked panel selection.

Server-owned tools, document/audio/video blocks, multimodal tool results, parallel host calls, complete JSON Schema dialects and true upstream token streaming are outside the verified subset. Clients share one serialized school browser page; multi-tab concurrency is unchanged.

References: [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Claude gateway connection](https://code.claude.com/docs/en/llm-gateway-connect), [Claude environment variables](https://code.claude.com/docs/en/env-vars).

## Regression design

Acceptance checks actual tools/files and execution-time random receipts. A narrated success or HTTP 200 alone cannot pass. Runtime logs, credentials and session state are ignored and must not be shared.

| Requirement / historic failure | Offline coverage | Online check |
|---|---|---|
| Wire format, schema, tool IDs, result ordering | Messages adapter/HTTP tests plus Responses fixtures | Native Qwen/GLM loops and Codex shell/patch |
| Narrated tools vs real execution | Native Claude CLI Write → Read → Edit → Bash; external file/receipt assertions | Both models Bash → Read → Write → Edit → Read with random receipt |
| Session reuse/cwd/history isolation | Session-key/digest/foreign-result guards; home and panel cwd tests | Resume returns same receipt/stage without tools; A→B→A restoration |
| Duplicate, foreign, oversized results; invalid schema | Adapter guards and shared runtime tests | Real full-history tool-result replay |
| Large prompts / Windows argument limit | Prompt-file transport fixtures | Native system/catalog over HTTP, stdin test prompts and SVG file payload |
| GLM fence/script/refusal differences | Dedicated parsers, encoded PowerShell→Bash test, bounded controls | GLM loop completes after one missing-reason correction |
| Tool errors and long/background work | Real missing-file error and background Bash output read once | Qwen receives error, runs one 12-second command and verifies file |
| Dead client/interrupt/uncertain delivery | Ownership, stale/empty/identity/timeout tests; native stream errors | Actual CLI terminated with pending tool; next task succeeds. Dropped SSE retry causes exactly one web submission |
| Browser/login/empty/stalled/wrong chat recovery | Shared OpenCLI recovery/ask and runtime readiness fixtures | Authenticated bootstrap/restore throughout real loops |
| Dynamic port/proxy/missing worktree runtime | Launcher/transport fixtures and common-checkout lookup | New worktree instance and both client wrappers |
| Project config can redirect Gateway CLI | Native fixture supplies wrong project URL/key/token/model and inherited Bedrock flag | CLI settings pin the real gateway |
| Disabled gateway/auth/input/count | Native HTTP/route-auth fixtures | 401 missing/wrong key, 400 input, 503 gate, 200 count with no web call |
| Model profiles and input images | Round trip for all configured models; image fallback continuity | Local Qwen and local GLM |
| Context footer calibration | Messages usage at 0/50/100%; actual native CLI window assertion | Real client reports the alias's contextWindow as 100000 |
| Two panel launchers | Both widgets fit; launcher path/cwd wiring | Launcher initialization and native terminal startup |
| SVG deliverable | XML/animation/asset validation after generation | Claude Code → Gateway → Qwen → native Write/Read → rendered SVG |

Run offline:

```powershell
node --test gateway/cuhk-provider/test/*.test.cjs
python -m unittest discover -s app -v
node scripts/test-adapter.cjs
node gateway/cuhk-provider/test/claude-cli-offline.cjs
```

The adapter needs its usual `node_modules` junction to OpenCLI dependencies. Linked worktrees reuse CCR/OpenCLI from the common checkout without copying research or credentials. `bin/cuhk-opencli.mjs` registers this checkout's adapters against that shared engine, so worktree edits actually execute. Thinking selection checks the visible ordinal and label, with keyboard interaction when an acknowledged browser click does not open/select the React menu. Selection is confirmed before any prompt is sent.

Run online sequentially with a logged-in CUHK browser and this checkout's Gateway. Set `CUHK_ONLINE_DIAGNOSTIC_PATH` to `gateway/runtime-state/claude-online.ndjson` before starting Gateway for the reconnect submission-count test. Model tests temporarily alter only this checkout's config and restore it.

```powershell
node gateway/cuhk-provider/test/claude-cli-online.cjs qwen-tools
node gateway/cuhk-provider/test/claude-cli-online.cjs glm-tools
node gateway/cuhk-provider/test/claude-cli-online.cjs qwen-recovery
node gateway/cuhk-provider/test/anthropic-api-online.cjs
node gateway/cuhk-provider/test/codex-cli-online.cjs
node gateway/cuhk-provider/test/claude-interrupt-online.cjs
node gateway/cuhk-provider/test/claude-isolation-online.cjs
node gateway/cuhk-provider/test/claude-cli-online.cjs context
# After all regression acceptance:
node gateway/cuhk-provider/test/claude-cli-online.cjs svg
# Optional byte-for-byte native Read/Write/Read replay:
node gateway/cuhk-provider/test/claude-cli-online.cjs svg-replay
# Requires Playwright; CUHK_PLAYWRIGHT_MODULE and CUHK_CHROME_PATH can point
# to an existing local installation rather than downloading a browser.
node gateway/cuhk-provider/test/verify-svg.cjs
```

The Codex smoke uses explicit `danger-full-access` only in its ignored test directory: this installed Windows client's `workspace-write` profile rejected even `Get-Date`. Normal launchers keep native client permissions. The failure was recorded as a real policy denial, never counted as successful tool execution.

## Acceptance record

2026-10-09, branch `feature/claude-code-gateway`, from `d6ec8e3`; Claude Code 2.1.277 and Codex 0.160.0 on Windows. The planned regression matrix passed:

- Provider 172/172, OpenCLI adapter 45/45, panel 10/10; native Claude offline integration executed eight mocked-browser turns with real local tools, a background process/output read, error feedback, inherited/project routing overrides and a verified 100k context window. Source/PowerShell syntax and diff checks passed.
- Qwen and GLM each executed Bash → Read → Write → Edit → Read using an execution-time random receipt. Native resume and A→B→A restored the original distinct web URLs and correct receipts. CLI termination released a pending tool, then a fresh task succeeded. A dropped native SSE request and identical retry made exactly one web submission. Auth/input/disabled/count routes returned 401/400/503/200 as designed, with zero web submissions for local checks.
- Real Claude interactive cold start accepted its complete 25-tool catalog, isolated the background title job and returned the canary. The Codex launcher opened its native cwd-filtered resume picker; real Codex shell and patch smoke completed. Live Qwen thinking selection changed low → xhigh → low. Recovery fixtures cover the current Stop control's `chat-send-button`/`停止生成` label as well as the legacy selector.
- After regression acceptance, Claude Code → Gateway → local Qwen created `artifacts/pelican-bicycle.svg` using native Write/Read. With the final wrapper and adapter, a further native Read → Write → Read replay preserved the complete file exactly. The 960×640 SVG is valid, self-contained XML with title/desc and 15 animation elements. Three rendered times (0, 0.37, 0.83 seconds) have different image hashes; visual inspection confirms the pelican/pouch, bicycle, moving wheels/pedals and body animation.

Artifact: [SVG animation](../artifacts/pelican-bicycle.svg), [rendered frame](../artifacts/pelican-bicycle-frame-1.png). SVG SHA-256: `ad6097672144a2a584b9d38cd15bbc6d99c3e44c4fd6990ac1478dc0f5585ad2` (8467 bytes). A sanitized machine-readable summary is in [claude-code-acceptance.json](claude-code-acceptance.json). Per-case reports and raw diagnostic/client logs remain local under ignored `gateway/runtime-state`; they include private prompts and must not be published.
