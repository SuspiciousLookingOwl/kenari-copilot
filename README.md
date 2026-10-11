<div align="center">

![Kenari logo](assets/logo.png)

# Kenari Provider for Copilot

</div>

> [!IMPORTANT]
> **This is a community extension. It is not affiliated with, officially maintained by, or endorsed by Kenari.**

> [!IMPORTANT]
> **This is a modified fork of [OnesoftQwQ/opencode-go-copilot](https://github.com/OnesoftQwQ/opencode-go-copilot), adapted for Kenari. Refactor was assisted with AI tools and reviewed by me.**

Integrate [Kenari](https://kenari.id) into GitHub Copilot Chat as a VS Code extension.

The model list is read from Kenari's public `GET /v1/models` endpoint, so new models appear without an extension update. Each model is routed through the protocol it declares (OpenAI-compatible Chat Completions, OpenAI Responses, or Anthropic Messages), and reasoning effort levels are resolved from the catalog's `reasoning_options`.

### Usage

1. **Set API Key**: `Ctrl+Shift+P` → `Kenari: Set Kenari API Key` and paste a `kn-` key from the [Kenari dashboard](https://kenari.id/keys)
2. **Show Models**: Click the settings icon in the model picker → **Language Models** panel → set your desired models to Visible
3. **Select Model**: In the Copilot Chat bottom model picker, choose a "Kenari" model
4. **Start chatting**

### Status Bar: Plan Quota & Token Indicator

The status bar shows your Kenari plan quota for the tightest rolling window (e.g. `Kenari wk 16%`, or `Kenari --` before the first fetch). Hover the status bar item to see:

- **Plan quota**: the active plan, weekly / monthly utilization with reset countdowns, the active coupon, and your account balance.
- **Token usage**: cumulative input/output token counts, plus the cumulative cache hit count and cache hit rate for models that return cache metrics in an OpenAI-compatible format.

![status bar usage and token tooltip](/assets/screenshots/status_bar_usage.png)

Click the status bar item or run `Kenari: Check Kenari Plan Quota` to refresh immediately. The tooltip usage section and the background refresh interval are controlled by `kenari.showUsageInTooltip` (default `true`) and `kenari.usageRefreshInterval` (default 5 minutes). The advanced token indicator can be disabled with `kenari.enableThirdPartyTokenIndicator` (default `true`); the native Copilot token indicator always stays visible.

> [!NOTE]
> Reading quota and balance needs an unrestricted account key. Shared and restricted keys are refused by Kenari with HTTP 403, and the extension then keeps showing the last known values (or `Kenari --`).

### Git Commit Messages

Click the **magic wand** button in the Source Control (SCM) panel to auto-generate a commit message.

You can configure the model, language, number of recent commits to reference, and whether to attach context files. The button can be hidden with `kenari.enableCommitGeneration` (default `true`).

### Model Temperature Presets

Quickly switch temperature presets via `Ctrl+Shift+P` → `Kenari: Set Model Temperature Preset`.

Built-in presets:

| Preset         | Temperature |
| -------------- | ----------- |
| Precise        | 0.0         |
| Balanced       | 1.0         |
| Creative       | 1.2         |
| Extra Creative | 1.7         |

You can also configure `kenari.temperature` and `kenari.top_p` directly in `settings.json` (requires `kenari.modelPreset` set to `"custom"`).

### Extended Vision Understanding

This extension adds **extended vision understanding** capability to **text-only models** that do not natively support vision. When you send a message with an image to these models, they can call a vision-capable model to answer specific questions about the image, and then answer based on the description.

You can configure the vision model and whether to enable thinking when describing images via `kenari.visionProxyModel` (default `qwen3-7-plus`) and `kenari.visionProxyThinking` (default `false`).

### Model Catalog & Free Models

The model list and all metadata (context length, output limit, vision, reasoning levels, tool calling) come from `GET https://kenari.id/v1/models`, which is public and needs no API key.

- The list is cached for `kenari.modelListRefreshInterval` (default `60000` ms); run `Kenari: Update Kenari Model List (forced)` to refresh it manually.
- `:free` models are shown with a "Free" marker in the picker. They cost nothing to call but have per-minute and daily limits set by your account tier.
- The last successful list is cached on disk, so the model picker still works when Kenari is temporarily unreachable.

### Reasoning Effort

Models that support thinking expose a reasoning effort selector in the model picker:

- Models with declared effort levels (e.g. `low` / `medium` / `high` / `max`) show those levels; a "Disabled" option appears only when the model actually accepts an off switch.
- Models with a simple on/off toggle show `Disabled` / `Thinking`.
- Models that always think show only their available levels.

Requests are mapped to Kenari's documented controls: `reasoning_effort` / `reasoning` on Chat Completions, `output_config.effort` / `thinking` on Messages, and `reasoning.effort` on Responses.

### Output Token Budget

Kenari reserves balance for the worst case of a request before it runs: the estimated input plus `max_tokens` at the output price. Several models advertise an output ceiling just below their whole context window (e.g. 943,718 on a 1M window), so requesting that capability on every call would reserve the price of a full-length answer each time — and Kenari would silently lower `max_tokens` when the balance cannot cover it, cutting the answer short with `finish_reason: length`.

The extension therefore caps the requested `max_tokens` at **32,768** per call. The model's real capability is still declared to VS Code, and the upstream limit still applies; this only bounds what a single request asks for. If you need a longer single response than that, raise `MAX_REQUESTED_OUTPUT_TOKENS` in `src/catalogModels.ts`.

### Error Handling and Retries

Failures are handled by HTTP status and Kenari's `code` (or `error.type` on Messages), never by the message text:

- **Retried**: `429` with `rate_limit_exceeded`, `free_quota_rpm`, `upstream_error`, `passthrough_busy`; plus `500`, `502`, `503` and `504`. `Retry-After` is honoured when present; otherwise exponential backoff with jitter is used.
- **Not retried**: any `402` (`insufficient_balance`, `payg_limit_reached`, `key_spend_cap_reached`), `free_quota_daily`, `plan_limit_reached`, and rejections that need a different request (bad request, context length, content policy, entitlement).
- Failures that arrive **after** a stream has started (where the HTTP status is already `200`) surface as errors too, instead of silently truncating the answer.

### Proxy / Gateway (Advanced)

Advanced users can route inference requests (chat and Git commit message generation) through a self-hosted proxy/gateway for observability, key routing or compression. Run `Kenari: Set Proxy Base URL` and acknowledge the compatibility notice; the proxy must be fully compatible with the official endpoint (same protocols, paths, model IDs and headers, and unmodified streaming responses). Quota and model list requests always use the official endpoint. Leave the value empty to disable.

### Commands

All commands are available from the command palette (`Ctrl+Shift+P` → `Kenari: ...`):

| Command                                              | Description                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Kenari: Set Kenari API Key`                         | Set or clear the API key (stored in VS Code SecretStorage).                      |
| `Kenari: Get Kenari API Key`                         | Open the Kenari dashboard to create an API key.                                  |
| `Kenari: Open Kenari Settings`                       | Open the extension settings page.                                                |
| `Kenari: Check Kenari Plan Quota`                    | Refresh and show plan quota and balance.                                         |
| `Kenari: Update Kenari Model List (forced)`          | Force a model list refresh.                                                      |
| `Kenari: Set Model Temperature Preset`               | Switch the temperature preset.                                                   |
| `Kenari: Set Proxy Base URL`                         | Configure the inference proxy base URL.                                          |
| `Kenari: Generate Commit Message with Kenari`        | Generate a commit message (also available as the SCM toolbar magic wand button). |
| `Kenari: Generate Commit Message with Kenari - Stop` | Abort commit message generation.                                                 |

### Configuration

Available in `settings.json`:

```json
{
	"kenari.commitLanguage": "auto",
	"kenari.commitModel": "deepseek-v4-flash",
	"kenari.commitMessagePrompt": "",
	"kenari.requestTimeout": 600000,
	"kenari.recentCommitsCount": 10,
	"kenari.commitIncludeCommitDiff": false,
	"kenari.commitAttachContextFiles": true
}
```

| Setting                                 | Default             | Description                                                                                                                                                                                             |
| --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kenari.requestTimeout`                 | `600000`            | Maximum time (ms) for a single API request. Increase if long responses time out.                                                                                                                        |
| `kenari.delay`                          | `0`                 | Delay (ms) between consecutive API requests to avoid rate limiting.                                                                                                                                     |
| `kenari.retry.enabled`                  | `true`              | Retry failed API requests with exponential backoff.                                                                                                                                                     |
| `kenari.retry.max_attempts`             | `3`                 | Maximum number of retry attempts.                                                                                                                                                                       |
| `kenari.retry.interval_ms`              | `1000`              | Initial delay (ms) before the first retry; grows exponentially.                                                                                                                                         |
| `kenari.retry.status_codes`             | `[]`                | Additional HTTP status codes that trigger a retry, on top of 429/500/502/503/504.                                                                                                                       |
| `kenari.modelPreset`                    | `precise`           | Active temperature preset ID. Set to `custom` to use the manual `temperature` / `top_p` values.                                                                                                         |
| `kenari.temperature`                    | `null`              | Temperature (0.0 - 2.0) used when `modelPreset` is `custom`.                                                                                                                                            |
| `kenari.top_p`                          | `null`              | top_p (0.0 - 1.0) used when `modelPreset` is `custom`.                                                                                                                                                  |
| `kenari.modelPresets`                   | built-in presets    | Preset definitions (`id`, `label`, `temperature`, optional `top_p`).                                                                                                                                    |
| `kenari.modelListRefreshInterval`       | `60000`             | Cache TTL (ms) for the Kenari model list. Minimum 30000.                                                                                                                                                |
| `kenari.enableThirdPartyTokenIndicator` | `true`              | Show the advanced token indicator in the status bar tooltip.                                                                                                                                            |
| `kenari.showUsageInTooltip`             | `true`              | Show the Kenari plan quota section in the status bar tooltip.                                                                                                                                           |
| `kenari.usageRefreshInterval`           | `5`                 | Background quota refresh interval (minutes, 1-60).                                                                                                                                                      |
| `kenari.enableCommitGeneration`         | `true`              | Show the generate commit message button in the SCM panel.                                                                                                                                               |
| `kenari.commitLanguage`                 | `auto`              | Language for Git commit messages: `English` or `Indonesian`. `auto` detects it from recent commits (defaults to English).                                                                               |
| `kenari.commitModel`                    | `deepseek-v4-flash` | Model ID used for commit message generation.                                                                                                                                                            |
| `kenari.commitMessagePrompt`            | `""`                | Custom system prompt for commit message generation.                                                                                                                                                     |
| `kenari.recentCommitsCount`             | `10`                | Number of recent commits used as style reference. Set to 0 to disable.                                                                                                                                  |
| `kenari.commitIncludeCommitDiff`        | `false`             | Include the actual diffs of recent commits in the style reference.                                                                                                                                      |
| `kenari.commitAttachContextFiles`       | `true`              | Attach AGENTS.md and README.md from the repository root as extra context.                                                                                                                               |
| `kenari.visionProxyModel`               | `qwen3-7-plus`      | Vision model used by the `ask_image` tool. Any vision-capable Kenari model works.                                                                                                                       |
| `kenari.visionProxyThinking`            | `false`             | Enable thinking/reasoning in the vision proxy model.                                                                                                                                                    |
| `kenari.visionMaxRounds`                | `5`                 | Maximum number of vision proxy follow-up rounds per request.                                                                                                                                            |
| `kenari.readFileLines`                  | `0`                 | Automatically adjust `read_file` tool calls to read this many lines. 0 disables.                                                                                                                        |
| `kenari.inferenceBaseUrl`               | `""`                | Advanced: route inference requests through a self-hosted proxy/gateway. Prefer the `Kenari: Set Proxy Base URL` command. Machine scope; quota and model list requests always use the official endpoint. |

### Build

```bash
npm install
npm run compile
npm test           # runs the test scripts
npm run build      # packages extension.vsix
```
