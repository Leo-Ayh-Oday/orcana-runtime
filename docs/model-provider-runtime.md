# Model Provider Runtime Guide

This document describes Orcana's model-provider runtime, TUI configuration flow, persistence behavior, compatibility requirements, and troubleshooting boundaries.

Last verified: 2026-07-11.

## Recommended setup

Use the official DeepSeek API as the default production path:

- Main agent: `deepseek-v4-pro`
- Low-cost sub-calls: `deepseek-v4-flash`
- Anthropic-compatible base URL: `https://api.deepseek.com/anthropic`

`deepseek-chat` and `deepseek-reasoner` are legacy aliases scheduled for retirement on 2026-07-24. New configurations should use the V4 model IDs directly.

DeepSeek is the strongest default for the current runtime because its official API has been exercised end to end with Orcana's streaming and Anthropic-style tool protocol. Other providers remain useful alternatives, but should be certified with their own credentials before being treated as production-equivalent.

## Supported provider paths

| Provider | Runtime protocol | Default base URL | Verification level |
| --- | --- | --- | --- |
| DeepSeek | Anthropic-compatible | `https://api.deepseek.com/anthropic` | Live request verified |
| Qwen / DashScope | OpenAI-compatible | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Endpoint verified |
| Kimi / Moonshot | OpenAI-compatible | `https://api.moonshot.ai/v1` | Endpoint verified |
| Zhipu GLM | OpenAI-compatible | `https://open.bigmodel.cn/api/coding/paas/v4` | Endpoint verified |
| SiliconFlow | OpenAI-compatible | `https://api.siliconflow.com/v1` | Endpoint verified |
| MiniMax | OpenAI-compatible | `https://api.minimax.io/v1` | Endpoint verified |
| StepFun | OpenAI-compatible | `https://api.stepfun.ai/step_plan/v1` | Endpoint verified |
| OpenRouter | OpenAI-compatible | `https://openrouter.ai/api/v1` | Endpoint verified |
| Custom relay | OpenAI-compatible | User supplied | Depends on relay |
| Ollama | OpenAI-compatible local | `http://localhost:11434/v1` | Configuration tested; local service not live-verified |
| LM Studio | OpenAI-compatible local | `http://localhost:1234/v1` | Configuration tested; local service not live-verified |

"Endpoint verified" means the configured route responded with an authentication error instead of `404`. It proves that the route exists, not that a real account has completed a streaming tool-use workflow.

## Configure from the TUI

Open the model selector:

```text
/models
```

Filter to a provider when needed:

```text
/models qwen
/models kimi
/models ollama
/models lmstudio
```

For a built-in hosted model:

1. Select the model.
2. Enter the provider API key when prompted.
3. Orcana saves the credential and switches the active session model.

For an OpenAI-compatible relay:

1. Select `Custom OpenAI-compatible`.
2. Enter the exact model ID exposed by the relay.
3. Enter the base URL, normally ending in `/v1`.
4. Enter the relay API key.

Use a base URL such as:

```text
https://relay.example.com/v1
```

Do not enter the complete request endpoint:

```text
https://relay.example.com/v1/chat/completions
```

Orcana appends `/chat/completions` itself.

For Ollama or LM Studio, select the provider-specific custom-model entry and enter the local model ID. Local providers do not require a fake API key.

## Relay compatibility contract

A relay is suitable for Orcana only if it preserves the parts of the OpenAI Chat Completions protocol required by an agent:

- streaming SSE responses;
- `tools` and `tool_choice` request fields;
- streamed `tool_calls` with stable call IDs;
- follow-up `role: "tool"` messages with `tool_call_id`;
- useful non-2xx response bodies;
- sufficient context and output limits for coding tasks.

JSON Schema output is forwarded through `response_format`. If a provider rejects API-level structured output, Orcana's structured-output layer can retry with prompt-level JSON instructions.

Provider-specific reasoning controls are less portable. A relay may accept ordinary chat and tools while ignoring or rejecting vendor-specific thinking-effort parameters. Certify `/effort` behavior separately before relying on it.

## Persistence and restart behavior

TUI configuration is global and survives process restarts:

```text
~/.deepseek-code/orcana.jsonc
~/.deepseek-code/auth.json
```

- `orcana.jsonc` stores provider metadata, base URLs, models, and the selected default.
- `auth.json` stores credential profiles.
- Project configuration is not loaded unless explicitly enabled.
- API keys are not written into the project repository.

Reconfiguration is normally unnecessary after restarting Orcana. If the model is missing after restart, inspect both files and confirm that the process is running under the same operating-system user.

## Runtime guarantees added in the provider hardening pass

- The official DeepSeek root URL is normalized to its Anthropic-compatible endpoint.
- OpenAI-compatible tool results are converted to standard `role: "tool"` messages.
- Explicit model routing is honored, including low-cost sub-call selection.
- `finish_reason: "length"` is treated as an incomplete response, not successful completion.
- OpenAI-compatible JSON Schema requests are forwarded through `response_format`.
- Ollama and LM Studio can be configured without API keys.
- Empty local-provider catalogs expose a custom model-ID entry in `/models`.

## Troubleshooting

### HTTP 404

Check the base URL before changing the API key.

- DeepSeek Anthropic format: `https://api.deepseek.com/anthropic`
- OpenAI-compatible services: supply the base URL before `/chat/completions`
- Ollama: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`

### HTTP 401 or 403

The route exists, but authentication failed. Confirm that the key belongs to the selected provider or relay and that the account is permitted to use the chosen model.

### Model not found

Model IDs are provider-specific and case-sensitive. Use the exact ID exposed by the provider's model-list endpoint or control panel.

### First turn works, tool continuation fails

The service may implement basic chat but not the full tool-call protocol. Confirm that it accepts `role: "tool"` messages and preserves `tool_call_id` values.

### Local provider cannot connect

Confirm that the service is listening before launching a run:

- Ollama: port `11434`
- LM Studio: port `1234`

Configuration success does not start either local service.

## Validation commands

The provider hardening pass was validated with:

```text
bun test tests/deepseek_provider.test.ts tests/openai_provider.test.ts tests/model_router.test.ts tests/runtime_model_config.test.ts tests/provider_retry.test.ts tests/structured_output.test.ts tests/config/config-loader.test.ts tests/config/auth-store.test.ts tests/tui/model-options.test.ts
bun run typecheck
bun run build
bun run test
```

Hosted providers without configured credentials were not billed or claimed as end-to-end verified. Their public endpoints were checked only for route existence.
