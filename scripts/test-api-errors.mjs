/**
 * Focused checks for Kenari's error handling and retry policy (utils.ts).
 *
 * Kenari branches on the HTTP status and the `code` (or `error.type` on
 * Messages), never on the message text. Retrying must follow the documented
 * rules: retry transient throttling and server failures, never retry a quota,
 * balance or content-policy problem, and honour `Retry-After` when present.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

const vscodeShim = {
	env: { language: "en" },
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
	extensions: { getExtension: () => undefined },
};

Module._load = function (request, parent, isMain) {
	if (request === "vscode") {
		return vscodeShim;
	}
	return originalLoad.call(this, request, parent, isMain);
};

/** Build the response shape createApiError reads. */
function response(status, statusText, headers = {}) {
	return {
		status,
		statusText,
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
	};
}

/** Retry config matching the extension defaults, but with a short interval. */
function retryConfig(overrides = {}) {
	return {
		enabled: true,
		maxAttempts: 3,
		intervalMs: 1,
		backoffFactor: 2,
		maxIntervalMs: 50,
		statusCodes: [429, 500, 502, 503, 504],
		...overrides,
	};
}

/** Count how many times a failing call runs, and how long the retrying took. */
async function attemptsOf(fn, config) {
	let calls = 0;
	const started = Date.now();
	let error;
	try {
		const { executeWithRetry } = require("../out/utils.js");
		await executeWithRetry(async () => {
			calls++;
			throw fn();
		}, config);
	} catch (e) {
		error = e;
	}
	return { calls, elapsed: Date.now() - started, error };
}

try {
	const { ApiError, createApiError, createStreamError, executeWithRetry } = require("../out/utils.js");

	// ── Error code extraction ──
	// OpenAI envelope: `code` is the field to branch on.
	let err = createApiError(
		response(429, "Too Many Requests"),
		JSON.stringify({ error: { message: "slow down", type: "rate_limit_exceeded", code: "free_quota_rpm" } }),
		"API error",
		"https://kenari.id/v1/chat/completions"
	);
	assert.ok(err instanceof ApiError);
	assert.equal(err.status, 429);
	assert.equal(err.code, "free_quota_rpm");
	assert.ok(err.message.includes("slow down"), "message text is preserved for people");
	assert.ok(err.message.includes("https://kenari.id/v1/chat/completions"), "URL is kept in the message");

	// Anthropic envelope: no `code`, only `error.type`.
	err = createApiError(
		response(429, "Too Many Requests"),
		JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
		"Anthropic Messages API error"
	);
	assert.equal(err.code, "rate_limit_error");
	assert.equal(err.status, 429);

	// A provider rejection keeps the provider's own status.
	err = createApiError(
		response(400, "Bad Request"),
		JSON.stringify({
			error: { message: "too long", type: "invalid_request_error", code: "context_length_exceeded" },
		}),
		"API error"
	);
	assert.equal(err.code, "context_length_exceeded");
	assert.equal(err.status, 400);

	// Several rejections are plain text, so there is no code to read.
	err = createApiError(response(401, "Unauthorized"), "invalid key", "API error");
	assert.equal(err.code, undefined);
	assert.equal(err.status, 401);
	assert.equal(err.retryAfterMs, undefined);

	// ── Retry-After parsing ──
	err = createApiError(response(429, "Too Many Requests", { "retry-after": "12" }), "{}", "API error");
	assert.equal(err.retryAfterMs, 12000);

	err = createApiError(
		response(429, "Too Many Requests", { "retry-after": new Date(Date.now() + 5000).toUTCString() }),
		"{}",
		"API error"
	);
	assert.ok(err.retryAfterMs > 3000 && err.retryAfterMs <= 5000, `date Retry-After parsed (${err.retryAfterMs}ms)`);

	// ── Stream error frames ──
	const streamError = createStreamError({
		message: "the model's provider interrupted the response before it finished",
		type: "upstream_error",
		code: "stream_interrupted",
	});
	assert.ok(streamError instanceof ApiError);
	assert.equal(streamError.code, "stream_interrupted");
	assert.equal(streamError.status, undefined, "a mid-stream error has no HTTP status");
	assert.ok(streamError.message.includes("stream_interrupted"));

	// ── Retry policy: transient failures are retried ──
	const retryable = [
		{ label: "429 rate_limit_exceeded", body: { code: "rate_limit_exceeded" }, status: 429 },
		{ label: "429 free_quota_rpm", body: { code: "free_quota_rpm" }, status: 429 },
		{ label: "429 upstream_error", body: { code: "upstream_error" }, status: 429 },
		{ label: "429 Anthropic rate_limit_error", body: { type: "rate_limit_error" }, status: 429 },
		{ label: "429 without a code (shared key)", body: undefined, status: 429 },
		{ label: "500 internal_error", body: { code: "internal_error" }, status: 500 },
		{ label: "503 upstream_error", body: { code: "upstream_error" }, status: 503 },
		{ label: "503 all_providers_failed", body: { code: "all_providers_failed" }, status: 503 },
	];
	for (const item of retryable) {
		const result = await attemptsOf(
			() =>
				createApiError(
					response(item.status, "X"),
					item.body ? JSON.stringify({ error: item.body }) : "",
					"API error"
				),
			retryConfig()
		);
		assert.equal(result.calls, 3, `${item.label} should be retried (ran ${result.calls}x)`);
	}

	// ── Retry policy: permanent failures are not retried ──
	const permanent = [
		{ label: "402 insufficient_balance", body: { code: "insufficient_balance" }, status: 402 },
		{ label: "402 payg_limit_reached", body: { code: "payg_limit_reached" }, status: 402 },
		{ label: "402 key_spend_cap_reached", body: { code: "key_spend_cap_reached" }, status: 402 },
		{ label: "429 free_quota_daily", body: { code: "free_quota_daily" }, status: 429 },
		{ label: "429 plan_limit_reached", body: { code: "plan_limit_reached" }, status: 429 },
		{ label: "400 context_length_exceeded", body: { code: "context_length_exceeded" }, status: 400 },
		{ label: "400 request_blocked", body: { code: "request_blocked" }, status: 400 },
		{ label: "400 content_policy_violation", body: { code: "content_policy_violation" }, status: 400 },
		{ label: "403 subscribers_only", body: { code: "subscribers_only" }, status: 403 },
	];
	for (const item of permanent) {
		const result = await attemptsOf(
			() => createApiError(response(item.status, "X"), JSON.stringify({ error: item.body }), "API error"),
			retryConfig()
		);
		assert.equal(result.calls, 1, `${item.label} must not be retried (ran ${result.calls}x)`);
	}

	// A non-ApiError still retries on a network pattern.
	let networkCalls = 0;
	await executeWithRetry(
		async () => {
			networkCalls++;
			throw new Error("fetch failed");
		},
		retryConfig({ maxAttempts: 2 })
	).catch(() => {});
	assert.equal(networkCalls, 2, "network errors keep the existing retry behaviour");

	// A plain error with no retryable signal is not retried.
	let plainCalls = 0;
	await executeWithRetry(async () => {
		plainCalls++;
		throw new Error("something went wrong");
	}, retryConfig()).catch(() => {});
	assert.equal(plainCalls, 1);

	// ── Retry-After wins over the backoff delay ──
	// maxAttempts 2 means a single retry, so exactly one wait of 200ms.
	const honoured = await attemptsOf(
		() =>
			createApiError(
				response(429, "X", { "retry-after": "0.2" }),
				JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
				"API error"
			),
		retryConfig({ maxAttempts: 2, intervalMs: 1 })
	);
	assert.equal(honoured.calls, 2);
	assert.ok(honoured.elapsed >= 190, `Retry-After honoured (waited ${honoured.elapsed}ms, expected ~200ms)`);

	// Without Retry-After, backoff stays small and jittered (0.75x-1.25x).
	const backoff = await attemptsOf(
		() => createApiError(response(500, "X"), JSON.stringify({ error: { code: "internal_error" } }), "API error"),
		retryConfig({ maxAttempts: 2, intervalMs: 100 })
	);
	assert.equal(backoff.calls, 2);
	assert.ok(backoff.elapsed >= 60 && backoff.elapsed < 400, `jittered backoff (waited ${backoff.elapsed}ms)`);

	// Retry can be disabled entirely.
	const disabled = await attemptsOf(
		() => createApiError(response(503, "X"), JSON.stringify({ error: { code: "upstream_error" } }), "API error"),
		retryConfig({ enabled: false })
	);
	assert.equal(disabled.calls, 1);

	console.log("api errors + retry policy: ok");
} finally {
	Module._load = originalLoad;
}
