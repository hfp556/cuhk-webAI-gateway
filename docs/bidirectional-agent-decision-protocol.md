# Bidirectional Agent Decision Protocol

Status: implemented as `AGENT DECISION PROTOCOL v1`.

## Why this exists

The old loop treated Gateway as the only controller. When prose looked like a failed tool request, Gateway sent a model-specific imperative repair message. That fixed some premature stops, but it also let an imperfect Gateway heuristic override a correct completion judgment. A finished task could therefore alternate forever between a forced repair prompt and another command.

The replacement starts from two independent sources of truth:

- Gateway can prove execution facts: which call was accepted, arguments after validation, exit status, pending processes, tool-result identity, and safety limits.
- The web Agent can judge task meaning: whether the user's goal is satisfied, whether another semantic action is useful, and whether user input is required.

Neither source alone is sufficient. The protocol keeps both authorities explicit and makes disagreement finite.

## Agent decisions

On a tool-capable turn the preferred response begins with exactly one decision envelope.

```cuhk-decision
{"version":1,"decision":"tool","name":"exec_command","arguments":{"cmd":"..."},"reason":"..."}
```

A `tool` decision block is the whole response. The fence is required because the school page's Markdown renderer can otherwise rewrite `$`, backslashes, and underscores inside commands. Gateway validates the name and arguments against the actual catalog before exposing a client-native call.

Web models sometimes append a second `blocked` decision, an apology, or other prose after an otherwise valid tool request. Gateway executes the **first** explicit tool request and ignores the trailing text (logged as `tool_decision_with_trailing_text`). The trailing content is never interpreted as a second dispatch, and the tool still passes catalog and schema validation, so a cosmetic protocol violation cannot discard a real action. The preferred form remains a standalone tool block.

The renderer may relabel an unknown `cuhk-decision` info string as `text`. A whole-response generic fence is therefore accepted only when its JSON positively contains `version: 1` and a valid `decision`; ordinary legacy `{name, arguments}` JSON remains on the tool compatibility path.

The page has also been observed appending its internal `</arg_value>` marker immediately after otherwise valid decision JSON. The parser strips that exact marker only at the payload boundary. It does not rewrite JSON fields or command text, and normal catalog/schema validation still follows.

```cuhk-decision
{"version":1,"decision":"final","reason":"goal_satisfied","evidence":["..."],"gateway_feedback":"..."}
```

```text
User-facing Markdown answer.
```

`final` is the web Agent's explicit convergence decision. Text and code blocks after the envelope are delivery documentation and are never reinterpreted as executable calls. `gateway_feedback` lets the Agent record why a Gateway challenge was incorrect.

A terminal decision must include a user-facing text answer after the envelope or in its `answer` field. After tool execution, that answer summarizes the actual outcome. If `final` or `blocked` omits the answer, Gateway requests it in the same web conversation with reason `missing_final_answer`, allowing only `final`/`blocked` and no additional tools. This uses the existing two-control-turn limit; repeated failure is reported as a protocol error rather than silently completing. Known running processes and client-required tool calls retain precedence over this summary recovery.

```cuhk-decision
{"version":1,"decision":"blocked","reason":"...","requires_user":true,"evidence":[]}
```

```text
User-facing blocker explanation.
```

`blocked` is terminal for the current loop. It distinguishes a real user/external dependency from task completion.

## Gateway control and arbitration

Gateway sends `GATEWAY CONTROL v1` only when it has a concrete protocol or execution-state concern, such as invalid decision JSON, a tool that is not in the catalog, a client-required tool choice, ambiguous legacy narration, or an identical action repeated immediately after it completed.

The control message contains structured facts and the allowed decisions for that turn. It explicitly states that it is a challenge, not an order. The Agent must reassess independently and can:

- correct the call with `tool`;
- reject the Gateway assumption and choose `final`;
- choose `blocked` when progress needs the user.

Two consecutive control turns are allowed without real progress. A valid new tool action or a returned tool result resets the counter. A third disagreement terminates with a protocol error. This is the circuit breaker that guarantees convergence of the controller even when the semantic task itself cannot converge.

Gateway may override a semantic `final` only for facts inside its authority. The implemented example is a known local process that is still running: Gateway converts the turn into a poll rather than falsely reporting completion. Client `tool_choice: required` is likewise an external execution contract, not a Gateway guess.

## No-progress rule

After a non-polling tool result, Gateway remembers a privacy-safe fingerprint of the tool name and canonical arguments. If the very next decision proposes the identical action and no new user input intervened, Gateway challenges it as `duplicate_action_without_progress` instead of executing it twice. The Agent can explain why a repeat is genuinely necessary by choosing a changed action, or converge with `final`.

Polling calls are exempt because repeated observation of a live process is progress toward a known terminal state.

## Compatibility and rollout

Legacy `<tool_call>` envelopes, fenced JSON, and GLM's narrow PowerShell bridge remain accepted. They are parsed after the explicit decision protocol. Ordinary legacy final text also remains valid unless it looks like an ambiguous tool narration; this allows existing clients and model behavior to migrate without a flag day.

The preferred protocol is injected on bootstrap and reminded on continuations and tool-result turns. Readiness diagnostics expose only the control-turn count and a fixed reason code; prompts, arguments, and tool output are not added to health data.

Conversation ownership is a prerequisite for bidirectional checking. A new task clicks and verifies a genuinely blank page (`/chat/`, zero visible turns, composer present); a continuation navigates to and verifies its recorded `/chat/c/<id>` before any write. This prevents a valid CONTROL or tool result from being delivered to an unrelated conversation when the school SPA restores or the user opens another history item.

## Invariants

1. No tool executes without catalog and schema validation.
2. Gateway execution facts cannot be contradicted by prose.
3. Gateway heuristics cannot force the Agent to invent additional work.
4. An explicit `final` or `blocked` ends the semantic loop unless a known running process or client contract prevents it.
5. Repeated identical actions are challenged before execution.
6. Disagreement without progress is bounded and terminates visibly.
7. Legacy formats never take precedence over a valid explicit decision.
8. No bootstrap or continuation is written until its conversation identity is verified.
9. The first explicit `tool` decision wins over trailing prose; trailing text is ignored and logged, never executed.

## Completion-summary regression

Offline coverage includes a completed tool followed by a bare `final`, rejection
of further tool execution during summary recovery, bounded missing answers, and
precedence for running processes and client-required tools.

With authenticated CUHK Chrome and no other task using the page:

```powershell
node gateway/cuhk-provider/test/completion-summary-online.cjs
node bin/cuhk-gateway.cjs start
node gateway/cuhk-provider/test/codex-svg-summary-online.cjs
```

The first test uses a real Codex CLI and browser transport, removing the first
real final answer's body at the transport boundary to exercise summary recovery.
It checks that a real summary reaches the CLI and the local command runs once.
The second uses the normal Gateway launcher and the ten-diving-pigs SVG task
with an explicit local-save requirement, without asking for a summary. It checks
that an animated SVG file exists and a text answer arrives after the final tool.
Both store reports and raw diagnostics only in ignored `gateway/runtime-state/`.

Verified on 2026-10-27 with Codex CLI `0.164.0-alpha.11.1` and Qwen
`qwen3.8-27b`: 184 offline tests passed; missing-answer injection recovered a real
summary with exactly one local command (`xhigh`); the SVG test created ten pig
instances with synchronized animations through native `apply_patch`, then
delivered a textual summary (`low`). The SVG test requests a compact reusable
shape and a local file so it exercises the CLI tool path rather than the web
page's built-in canvas. Original configuration bytes were restored, with no
active task or pending tool left after acceptance.
