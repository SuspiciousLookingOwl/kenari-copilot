/**
 * Regression checks for Anthropic signed thinking blocks (issue #137 follow-up).
 *
 * Claude 5.x rejects replayed thinking blocks that omit `signature`
 * (`messages.N.content.M.thinking.signature: Field required`). The VS Code
 * `LanguageModelThinkingPart` round-trip carries only text, so signatures are
 * persisted in a dedicated DataPart and replayed verbatim; unsigned thinking
 * text must never be sent back.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

class DataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}
class TextPart {
	constructor(value) {
		this.value = value;
	}
}
class ThinkingPart {
	constructor(value, id, metadata) {
		this.value = value;
		this.id = id;
		this.metadata = metadata;
	}
}
class ToolCallPart {}
class ToolResultPart {}

const vscodeShim = {
	LanguageModelDataPart: DataPart,
	LanguageModelTextPart: TextPart,
	LanguageModelThinkingPart: ThinkingPart,
	LanguageModelToolCallPart: ToolCallPart,
	LanguageModelToolResultPart: ToolResultPart,
	LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
	workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
	window: {
		createOutputChannel: () => ({
			debug() {},
			info() {},
			warn() {},
			error() {},
			dispose() {},
		}),
	},
};

Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return vscodeShim;
	}
	return originalLoad.call(this, request, parent, isMain);
};

try {
	const {
		serializeThinkingSignature,
		deserializeThinkingSignature,
		createThinkingSignaturePart,
		parseThinkingSignaturePart,
		ANTHROPIC_THINKING_SIGNATURE_MIME,
	} = require("../out/anthropic/thinkingSignature.js");
	const { AnthropicApi } = require("../out/anthropic/anthropicApi.js");
	const { logger } = require("../out/logger.js");
	logger.init();

	const entry = { thinking: "Let me work through this step by step.", signature: "sig-abc123" };

	// Codec round-trip and validation.
	assert.deepEqual(deserializeThinkingSignature(serializeThinkingSignature(entry)), entry);
	assert.equal(deserializeThinkingSignature(new TextEncoder().encode("not-json")), null);
	assert.equal(
		deserializeThinkingSignature(
			new TextEncoder().encode(JSON.stringify({ version: 1, thinking: "x", signature: "" }))
		),
		null
	);

	// DataPart wrapper round-trip.
	const part = createThinkingSignaturePart(entry);
	assert.equal(part.mimeType, ANTHROPIC_THINKING_SIGNATURE_MIME);
	assert.deepEqual(parseThinkingSignaturePart(part), entry);
	assert.equal(
		parseThinkingSignaturePart(new DataPart(new TextEncoder().encode("{}"), "application/octet-stream")),
		null
	);

	// A signed thinking block is replayed first, with its signature attached.
	const assistantWithSignature = {
		role: 2,
		content: [new TextPart("The answer is 4."), part],
	};
	const converted = await new AnthropicApi("test").convertMessages(
		[
			{ role: 1, content: [new TextPart("What is 2+2?")] },
			assistantWithSignature,
			{ role: 1, content: [new TextPart("Thanks")] },
		],
		{ includeReasoningInRequest: true, vision: false }
	);
	assert.deepEqual(converted[1], {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: entry.thinking, signature: entry.signature },
			{ type: "text", text: "The answer is 4." },
		],
	});

	// Plain thinking text (no signature) must NOT be replayed - Claude 5.x
	// rejects unsigned thinking blocks with `thinking.signature: Field required`.
	const unsigned = await new AnthropicApi("test").convertMessages(
		[{ role: 2, content: [new TextPart("The answer is 4."), new ThinkingPart("Let me think...")] }],
		{ includeReasoningInRequest: true, vision: false }
	);
	assert.deepEqual(unsigned[0], {
		role: "assistant",
		content: [{ type: "text", text: "The answer is 4." }],
	});

	// includeReasoningInRequest=false drops even signed blocks.
	const disabled = await new AnthropicApi("test").convertMessages([assistantWithSignature], {
		includeReasoningInRequest: false,
		vision: false,
	});
	assert.deepEqual(disabled[0], {
		role: "assistant",
		content: [{ type: "text", text: "The answer is 4." }],
	});

	// ── Usage and truncation, driven through the real streaming parser ──
	// On Messages, `input_tokens` excludes the cached tokens, so the whole
	// prompt is input + cache_read + cache_creation.
	function sseStream(frames) {
		const body = frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
		return new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		});
	}

	const api = new AnthropicApi("test");
	const usages = [];
	api.onUsage = (u) => usages.push(u);
	await api.processStreamingResponse(
		sseStream([
			{
				type: "message_start",
				message: {
					id: "m1",
					role: "assistant",
					model: "claude-sonnet-5",
					content: [],
					usage: {
						input_tokens: 100,
						output_tokens: 0,
						cache_read_input_tokens: 900,
						cache_creation_input_tokens: 50,
					},
				},
			},
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 100, output_tokens: 20 },
			},
			{ type: "message_stop" },
		]),
		{ report() {} },
		{ isCancellationRequested: false }
	);
	assert.equal(usages.length, 1);
	assert.equal(usages[0].promptTokens, 1050, "whole prompt = input + cache_read + cache_creation");
	assert.equal(usages[0].completionTokens, 20);
	assert.equal(usages[0].cacheHitTokens, 900);
	assert.equal(api._responseTruncated, false, "end_turn is not a cut-off");

	// A message cut off by the token limit sets the truncation flag.
	const truncated = new AnthropicApi("test");
	await truncated.processStreamingResponse(
		sseStream([
			{
				type: "message_start",
				message: {
					id: "m2",
					role: "assistant",
					model: "claude-sonnet-5",
					content: [],
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "max_tokens" },
				usage: { input_tokens: 10, output_tokens: 4096 },
			},
			{ type: "message_stop" },
		]),
		{ report() {} },
		{ isCancellationRequested: false }
	);
	assert.equal(truncated._responseTruncated, true, "stop_reason max_tokens is a cut-off");

	// Usage still reported when the provider omits input_tokens entirely.
	const noInput = new AnthropicApi("test");
	const noInputUsages = [];
	noInput.onUsage = (u) => noInputUsages.push(u);
	await noInput.processStreamingResponse(
		sseStream([
			{
				type: "message_start",
				message: {
					id: "m3",
					role: "assistant",
					model: "claude-sonnet-5",
					content: [],
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			},
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		]),
		{ report() {} },
		{ isCancellationRequested: false }
	);
	assert.equal(noInputUsages.length, 1, "zero output tokens must not suppress usage");
	assert.equal(noInputUsages[0].completionTokens, 5);

	// Stop sequences: VS Code's `modelOptions.stop` becomes `stop_sequences`.
	const stopped = new AnthropicApi("test").prepareRequestBody(
		{ model: "claude-sonnet-5", messages: [], stream: true },
		undefined,
		{ modelOptions: { stop: "END" } }
	);
	assert.deepEqual(stopped.stop_sequences, ["END"]);
	const stoppedArray = new AnthropicApi("test").prepareRequestBody(
		{ model: "claude-sonnet-5", messages: [], stream: true },
		undefined,
		{ modelOptions: { stop: ["A", "B"] } }
	);
	assert.deepEqual(stoppedArray.stop_sequences, ["A", "B"]);

	console.log("anthropic thinking signature: ok");
} finally {
	Module._load = originalLoad;
}
