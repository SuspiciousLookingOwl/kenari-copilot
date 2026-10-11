import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

const vscodeShim = {
	version: "1.0.0",
	workspace: {
		getConfiguration: () => ({ get: (_key, fallback) => fallback }),
	},
	window: {
		createOutputChannel: () => ({
			debug() {},
			info() {},
			warn() {},
			error() {},
			dispose() {},
		}),
	},
	extensions: {
		getExtension: () => undefined,
	},
};

Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return vscodeShim;
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const { setModelCatalogForTesting } = require("../out/modelCatalog.js");
	const { resolveModelMeta, buildModelInfo } = require("../out/catalogModels.js");
	const { OpenaiApi } = require("../out/openai/openaiApi.js");
	const { buildAnthropicThinkingConfig } = require("../out/anthropic/anthropicApi.js");

	setModelCatalogForTesting([
		{
			id: "gpt-x",
			protocols: ["openai-chat", "openai-responses", "anthropic-messages"],
			reasoning: true,
			reasoning_options: ["none", "low", "medium", "high", "xhigh"],
			reasoning_toggle: false,
			modalities: { input: ["text", "image"], output: ["text"] },
			context_length: 1000000,
			max_output_tokens: 128000,
			tool_call: true,
			pricing: { free: false },
		},
		{
			id: "glm-x",
			protocols: ["openai-chat"],
			reasoning: true,
			reasoning_options: ["low", "high", "max"],
			reasoning_toggle: false,
		},
		{
			id: "toggle-x",
			protocols: ["openai-chat"],
			reasoning: true,
			reasoning_toggle: true,
		},
		{
			id: "always-x",
			protocols: ["openai-chat"],
			reasoning: true,
		},
		{
			id: "plain-x",
			protocols: ["openai-chat"],
			reasoning: false,
		},
		{ id: "resp-only", protocols: ["openai-responses"] },
		{ id: "anth-only", protocols: ["anthropic-messages"] },
		{ id: "no-protocols" },
		{ id: "free-x:free", protocols: ["openai-chat"], pricing: { free: true } },
	]);

	// ── Protocol selection: prefer openai-chat, then responses, then anthropic ──
	assert.equal(resolveModelMeta("gpt-x").apiMode, "openai");
	assert.equal(resolveModelMeta("resp-only").apiMode, "openai-responses");
	assert.equal(resolveModelMeta("anth-only").apiMode, "anthropic");
	assert.equal(resolveModelMeta("no-protocols").apiMode, "openai");
	assert.equal(resolveModelMeta("unknown-model").apiMode, "openai");

	// ── Reasoning metadata mapping ──
	const gpt = resolveModelMeta("gpt-x");
	assert.equal(gpt.reasoning, true);
	assert.equal(gpt.thinkingMode, "switchable");
	assert.deepEqual(gpt.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
	assert.equal(gpt.supportsDisablingReasoning, true); // "none" is declared
	assert.equal(gpt.defaultReasoningEffort, "medium");
	assert.equal(gpt.vision, true);
	assert.equal(gpt.contextWindow, 1000000);
	assert.equal(gpt.maxOutputTokens, 128000);
	// VS Code convention: the input budget is the window minus the output limit,
	// so the picker's "Context Size" (input + output) shows the true window.
	assert.equal(gpt.maxInputTokens, 872000);
	assert.equal(gpt.toolCalling, true);

	const gptInfo = buildModelInfo("gpt-x");
	assert.equal(gptInfo.maxInputTokens, 872000);
	assert.equal(gptInfo.maxOutputTokens, 128000);
	// What the Language Models manager renders as "Context Size".
	assert.equal(gptInfo.maxInputTokens + gptInfo.maxOutputTokens, 1000000);
	const gptEnum = gptInfo.configurationSchema.properties.reasoningEffort.enum;
	assert.deepEqual(gptEnum, ["disabled", "low", "medium", "high", "xhigh"]);
	assert.equal(gptInfo.configurationSchema.properties.reasoningEffort.default, "medium");

	// An effort list without "none" or a toggle cannot disable thinking.
	const glm = resolveModelMeta("glm-x");
	assert.equal(glm.thinkingMode, "switchable");
	assert.equal(glm.supportsDisablingReasoning, false);
	assert.deepEqual(glm.supportedReasoningEfforts, ["low", "high", "max"]);
	assert.equal(glm.defaultReasoningEffort, "high");
	const glmEnum = buildModelInfo("glm-x").configurationSchema.properties.reasoningEffort.enum;
	assert.deepEqual(glmEnum, ["low", "high", "max"]);

	// Toggle-only models expose disabled/enabled.
	const toggle = resolveModelMeta("toggle-x");
	assert.equal(toggle.thinkingMode, "switchable");
	assert.equal(toggle.supportsDisablingReasoning, true);
	assert.equal(toggle.defaultReasoningEffort, "enabled");
	assert.deepEqual(buildModelInfo("toggle-x").configurationSchema.properties.reasoningEffort.enum, [
		"disabled",
		"enabled",
	]);

	// Reasoning without levels or toggle always thinks.
	const always = resolveModelMeta("always-x");
	assert.equal(always.thinkingMode, "always");
	assert.deepEqual(buildModelInfo("always-x").configurationSchema.properties.reasoningEffort.enum, ["enabled"]);

	// Non-reasoning models get no reasoning selector at all.
	assert.equal(resolveModelMeta("plain-x").reasoning, false);
	assert.equal(buildModelInfo("plain-x").configurationSchema, undefined);

	// Free models are marked in the picker detail.
	assert.equal(resolveModelMeta("free-x:free").free, true);
	assert.equal(buildModelInfo("free-x:free").detail, "Kenari \u00b7 Free");
	assert.equal(buildModelInfo("plain-x").detail, "Kenari");

	// ── Input budget derivation ──
	// Undeclared limits fall back to the conservative defaults (128K / 4K), and
	// the input budget is still window minus output.
	const plain = resolveModelMeta("plain-x");
	assert.equal(plain.contextWindow, 128000);
	assert.equal(plain.maxOutputTokens, 4096);
	assert.equal(plain.maxInputTokens, 123904);
	assert.equal(plain.maxInputTokens + plain.maxOutputTokens, 128000);

	// ── Chat Completions reasoning controls ──
	// Exercised through the real request-body builder, which is where the
	// reasoning fields are applied.
	const openaiApi = new OpenaiApi("test-model");
	const body = (um) => openaiApi.prepareRequestBody({}, um, undefined);
	let rb = body({ enable_thinking: true, reasoning_effort: "high" });
	assert.equal(rb.reasoning_effort, "high");
	assert.equal(rb.reasoning, undefined);
	assert.equal(rb.thinking, undefined);

	rb = body({ enable_thinking: true });
	assert.deepEqual(rb.reasoning, { enabled: true });
	assert.equal(rb.reasoning_effort, undefined);

	rb = body({ enable_thinking: false });
	assert.deepEqual(rb.reasoning, { enabled: false });
	assert.equal(rb.reasoning_effort, undefined);

	// Cannot disable → send nothing.
	rb = body({ enable_thinking: false, supportsDisablingReasoning: false });
	assert.deepEqual(rb, {});

	// No explicit choice → send nothing (model default).
	rb = body({});
	assert.deepEqual(rb, {});

	// A per-model thinking budget maps to `reasoning.max_tokens` (the only
	// budget the Chat Completions format accepts) when no level is chosen.
	rb = body({ enable_thinking: true, thinking_budget: 4096 });
	assert.deepEqual(rb.reasoning, { enabled: true, max_tokens: 4096 });
	assert.equal(rb.reasoning_effort, undefined);

	// A named effort still wins over the budget.
	rb = body({ enable_thinking: true, reasoning_effort: "high", thinking_budget: 4096 });
	assert.equal(rb.reasoning_effort, "high");
	assert.equal(rb.reasoning, undefined);

	// ── Anthropic Messages reasoning controls ──
	assert.deepEqual(buildAnthropicThinkingConfig({ enable_thinking: false }), {
		thinking: { type: "disabled" },
	});
	assert.deepEqual(
		buildAnthropicThinkingConfig({
			enable_thinking: true,
			reasoning_effort: "high",
		}),
		{
			output_config: { effort: "high" },
		}
	);
	assert.deepEqual(buildAnthropicThinkingConfig({ enable_thinking: true }), {
		thinking: { type: "enabled", budget_tokens: 8192 },
	});
	assert.deepEqual(buildAnthropicThinkingConfig({}), {});
	assert.deepEqual(buildAnthropicThinkingConfig(undefined), {});

	// ── Thinking budget must stay below `max_tokens` ──
	// A budget at or above max_tokens is rejected, so it is clamped to one
	// token less than the request's `max_tokens`.
	assert.deepEqual(buildAnthropicThinkingConfig({ enable_thinking: true }, 4096), {
		thinking: { type: "enabled", budget_tokens: 4095 },
	});
	// An explicit budget is clamped the same way.
	assert.deepEqual(buildAnthropicThinkingConfig({ enable_thinking: true, thinking_budget: 100000 }, 20000), {
		thinking: { type: "enabled", budget_tokens: 19999 },
	});
	// Room to spare: the default budget is left alone.
	assert.deepEqual(buildAnthropicThinkingConfig({ enable_thinking: true }, 100000), {
		thinking: { type: "enabled", budget_tokens: 8192 },
	});
	// At or below the 1,024 floor the model gets no thinking at all, so the
	// block is omitted rather than sent with an invalid budget.
	assert.deepEqual(buildAnthropicThinkingConfig({ enable_thinking: true }, 1024), {});
	assert.deepEqual(buildAnthropicThinkingConfig({ enable_thinking: true }, 500), {});
	// The off switch and named efforts are unaffected by the clamp.
	assert.deepEqual(buildAnthropicThinkingConfig({ enable_thinking: false }, 1024), {
		thinking: { type: "disabled" },
	});
	assert.deepEqual(buildAnthropicThinkingConfig({ enable_thinking: true, reasoning_effort: "high" }, 1024), {
		output_config: { effort: "high" },
	});

	// ── Input budget floor (replaces the shared fixtures) ──
	// An output limit that meets or exceeds the window is clamped by the floor
	// so VS Code never receives a zero-token input budget.
	setModelCatalogForTesting([
		{
			id: "over-output-x",
			protocols: ["openai-chat"],
			context_length: 128000,
			max_output_tokens: 200000,
		},
	]);
	const overOutput = resolveModelMeta("over-output-x");
	assert.equal(overOutput.contextWindow, 128000);
	assert.equal(overOutput.maxInputTokens, 1024);

	console.log("api mode + reasoning mapping: ok");
} finally {
	Module._load = originalLoad;
}
