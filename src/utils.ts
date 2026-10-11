import * as path from "path";
import * as vscode from "vscode";
import type { RetryConfig } from "./types";
import type { StoredImage } from "./vision/types";
import { OpenAIFunctionToolDef } from "./openai/openaiTypes";
import type { ResponsesFunctionToolDef } from "./openai/responsesTypes";
import { CancellationToken } from "vscode";
import { l10n } from "./localize";

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 1000;
const RETRY_BACKOFF_FACTOR = 2;
const RETRY_MAX_INTERVAL_MS = 60000;

// HTTP status codes that should trigger a retry
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

// Network error patterns to retry
const networkErrorPatterns = [
	"fetch failed",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"ECONNREFUSED",
	"timeout",
	"TIMEOUT",
	"network error",
	"NetworkError",
];

// Kenari 429 codes that clear on their own, so another attempt is worth it.
const RETRYABLE_429_CODES = new Set([
	"rate_limit_exceeded",
	"free_quota_rpm",
	"upstream_error",
	"passthrough_busy",
	"rate_limit_error",
]);

// Codes that stay until something changes.
// The docs say not to retry free_quota_daily, plan_limit_reached or any 402.
const NON_RETRYABLE_CODES = new Set([
	"free_quota_daily",
	"plan_limit_reached",
	"insufficient_balance",
	"payg_limit_reached",
	"key_spend_cap_reached",
	"subscribers_only",
	"subscription_required",
	"bad_request",
	"context_length_exceeded",
	"model_not_found",
	"request_blocked",
	"content_policy_violation",
]);

/**
 * Create a fetch implementation that bypasses VS Code's patched global fetch.
 *
 * VS Code rewires the extension host's global fetch to honor the local
 * `http.proxy` setting; in Remote-SSH sessions with a local proxy that makes
 * every request fail. VS Code's own networking uses the bundled undici, so
 * prefer it when available and fall back to the global fetch otherwise.
 */
export function createProxyAwareFetch(timeoutMs?: number): typeof fetch {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const undici = require(path.join(vscode.env.appRoot, "node_modules", "undici"));
		const agent = timeoutMs ? new undici.Agent({ bodyTimeout: timeoutMs }) : undefined;
		return (url: RequestInfo | URL, init?: RequestInit) => undici.fetch(url, { ...init, dispatcher: agent });
	} catch {
		return fetch;
	}
}

/**
 * An API failure carrying the fields a retry decision needs: the HTTP status
 * and Kenari's `code` (or `error.type`), never the message text.
 */
export class ApiError extends Error {
	readonly status?: number;
	readonly code?: string;
	/** Milliseconds to wait, from a `Retry-After` header. */
	readonly retryAfterMs?: number;

	constructor(message: string, options: { status?: number; code?: string; retryAfterMs?: number } = {}) {
		super(message);
		this.name = "ApiError";
		this.status = options.status;
		this.code = options.code;
		this.retryAfterMs = options.retryAfterMs;
	}
}

/** Read the error code from an OpenAI `code` or Anthropic `error.type` envelope. */
function parseErrorCode(bodyText: string): string | undefined {
	try {
		const error = (JSON.parse(bodyText) as Record<string, unknown>).error;
		if (error && typeof error === "object") {
			const envelope = error as Record<string, unknown>;
			if (typeof envelope.code === "string") {
				return envelope.code;
			}
			if (typeof envelope.type === "string") {
				return envelope.type;
			}
		}
	} catch {
		// Some rejections are plain text (401, 413, 429 on a shared key, 5xx).
	}
	return undefined;
}

/** Parse a `Retry-After` header (seconds or HTTP date) into milliseconds. */
function parseRetryAfterMs(header: string | null): number | undefined {
	if (!header) {
		return undefined;
	}
	const seconds = Number.parseFloat(header.trim());
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.round(seconds * 1000);
	}
	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Build the error for a non-OK response, keeping the code and `Retry-After`. */
export function createApiError(
	response: { status: number; statusText: string; headers: { get(name: string): string | null } },
	bodyText: string,
	label: string,
	url?: string
): ApiError {
	const detail = bodyText ? `\n${bodyText}` : "";
	const location = url ? `\nURL: ${url}` : "";
	return new ApiError(`${label}: [${response.status}] ${response.statusText}${detail}${location}`, {
		status: response.status,
		code: parseErrorCode(bodyText),
		retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
	});
}

/**
 * Build the error for a mid-stream error frame. The HTTP status is already 200
 * by then, so there is no status and no `Retry-After`, only the error object.
 */
export function createStreamError(frame: unknown): ApiError {
	const obj = (frame ?? {}) as Record<string, unknown>;
	const message = typeof obj.message === "string" ? obj.message : "The stream failed before the answer was complete.";
	const code = typeof obj.code === "string" ? obj.code : typeof obj.type === "string" ? obj.type : undefined;
	return new ApiError(code ? `${message} (${code})` : message, { code });
}

/**
 * Map VS Code message role to OpenAI message role string.
 */
export function mapRole(message: vscode.LanguageModelChatRequestMessage): "user" | "assistant" | "system" {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

function resolveToolMode(options?: vscode.ProvideLanguageModelChatResponseOptions): string | undefined {
	const officialToolMode = (options as unknown as { toolMode?: unknown })?.toolMode;
	const toolModeEnum = (
		vscode as typeof vscode & {
			LanguageModelChatToolMode?: { Auto?: unknown; Required?: unknown };
		}
	).LanguageModelChatToolMode;

	if (officialToolMode === toolModeEnum?.Required || officialToolMode === "required") {
		return "required";
	}
	if (officialToolMode === toolModeEnum?.Auto || officialToolMode === "auto") {
		return "auto";
	}

	const legacyToolMode = (options?.modelOptions as Record<string, unknown> | undefined)?.toolMode;
	return typeof legacyToolMode === "string" ? legacyToolMode : undefined;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 */
export function convertToolsToOpenAI(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: string;
} {
	if (!options?.tools || options.tools.length === 0) {
		return {};
	}

	const tools: OpenAIFunctionToolDef[] = options.tools.map((tool) => {
		const def: OpenAIFunctionToolDef = {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
			},
		};
		// Use the tool's inputSchema as parameters if available
		if (tool.inputSchema) {
			def.function.parameters = tool.inputSchema;
		} else {
			def.function.parameters = { type: "object", properties: {} };
		}
		return def;
	});

	// Determine tool_choice mode
	const toolMode = resolveToolMode(options);

	let toolChoice: string | undefined;
	if (toolMode === "required") {
		toolChoice = "required";
	} else if (toolMode === "none") {
		toolChoice = "none";
	} else if (toolMode === "auto") {
		toolChoice = "auto";
	}

	return { tools, tool_choice: toolChoice };
}

/** Convert an OpenAI Chat function definition to the flat Responses format. */
export function convertOpenAIToolToResponses(tool: OpenAIFunctionToolDef): ResponsesFunctionToolDef {
	return {
		type: "function",
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters ?? { type: "object", properties: {} },
		// VS Code tool schemas are not guaranteed to satisfy OpenAI strict-mode
		// requirements (all properties required, additionalProperties=false).
		strict: false,
	};
}

/** Convert VS Code tool definitions to the flat OpenAI Responses format. */
export function convertToolsToResponses(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: ResponsesFunctionToolDef[];
	tool_choice?: string;
} {
	const chatTools = convertToolsToOpenAI(options);
	return {
		tools: chatTools.tools?.map(convertOpenAIToolToResponses),
		tool_choice: chatTools.tool_choice,
	};
}

/**
 * Create retry configuration from VS Code settings.
 */
export function createRetryConfig(): RetryConfig {
	const config = vscode.workspace.getConfiguration("kenari.retry");
	const enabled = config.get<boolean>("enabled", true);
	const maxAttempts = config.get<number>("max_attempts", RETRY_MAX_ATTEMPTS);
	const intervalMs = config.get<number>("interval_ms", RETRY_INTERVAL_MS);
	const additionalStatusCodes = config.get<number[]>("status_codes", []);

	return {
		enabled,
		maxAttempts,
		intervalMs,
		backoffFactor: RETRY_BACKOFF_FACTOR,
		maxIntervalMs: RETRY_MAX_INTERVAL_MS,
		statusCodes: [...RETRYABLE_STATUS_CODES, ...additionalStatusCodes],
	};
}

/**
 * Read the user-configured inference base URL override (proxy).
 *
 * When set (via the `kenari.setInferenceBaseUrl` command or the
 * `kenari.inferenceBaseUrl` setting), all inference requests - chat
 * requests and Git commit message generation - are sent to this address
 * instead of the official endpoint. Usage and model list requests keep
 * using the official endpoint.
 *
 * @returns The trimmed override URL, or an empty string when not configured.
 */
export function getInferenceBaseUrlOverride(): string {
	return vscode.workspace.getConfiguration().get<string>("kenari.inferenceBaseUrl", "").trim();
}

/**
 * Validate a base URL for HTTP safety.
 *
 * Used both by the input box of the `kenari.setInferenceBaseUrl` command
 * and by the request paths before dispatching (provider and Git commit
 * generation). Rejects non-HTTP(S) URLs; for plain `http:` only localhost and
 * private network addresses are allowed, remote endpoints must use HTTPS.
 *
 * @returns A localized error message when the URL is unacceptable, or
 * `undefined` when it is valid.
 */
export function validateBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return l10n("Invalid base URL configuration.");
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return l10n("Invalid base URL configuration.");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return l10n("Invalid base URL configuration.");
	}

	if (url.protocol === "http:") {
		const host = url.hostname.toLowerCase();
		const isLocal =
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "::1" ||
			host === "[::1]" ||
			host.startsWith("192.168.") ||
			host.startsWith("10.") ||
			host === "0.0.0.0" ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(host);
		if (!isLocal) {
			return l10n(
				"Plain HTTP is only allowed for localhost or private network addresses. Use HTTPS for remote endpoints."
			);
		}
	}

	return undefined;
}

/**
 * Execute an async function with retry logic.
 */
export async function executeWithRetry<T>(fn: () => Promise<T>, retryConfig: RetryConfig): Promise<T> {
	if (!retryConfig.enabled) {
		return fn();
	}

	let lastError: Error | undefined;
	let delay = retryConfig.intervalMs;

	for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));

			if (attempt === retryConfig.maxAttempts) {
				break;
			}

			// Check if error is retryable
			const isRetryable = isRetryableError(lastError, retryConfig.statusCodes);
			if (!isRetryable) {
				break;
			}

			// Wait before retrying. A `Retry-After` from Kenari wins; otherwise use
			// exponential backoff with jitter, as the docs recommend.
			const waitMs =
				lastError instanceof ApiError && lastError.retryAfterMs !== undefined
					? lastError.retryAfterMs
					: Math.round(delay * (0.75 + Math.random() * 0.5));
			await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

			// Exponential backoff
			delay = Math.min(delay * retryConfig.backoffFactor, retryConfig.maxIntervalMs);
		}
	}

	throw lastError;
}

/**
 * Decide whether an error is worth another attempt.
 *
 * Kenari branches on the HTTP status and the `code` (or `error.type` on
 * Messages), never on the message text. A quota, balance or content-policy
 * problem stays until something changes, so retrying it only burns time;
 * transient throttling and server failures clear on their own.
 */
function isRetryableError(error: Error, retryableStatusCodes: number[]): boolean {
	if (error instanceof ApiError) {
		// 402 is a payment problem: top up or change the limit, then resend.
		if (error.status === 402) {
			return false;
		}
		if (error.code !== undefined && NON_RETRYABLE_CODES.has(error.code)) {
			return false;
		}
		if (error.status === 429) {
			// 429 covers both transient throttling and exhausted daily quotas.
			// A plain-text 429 carries no code, so treat it as transient.
			return error.code === undefined || RETRYABLE_429_CODES.has(error.code);
		}
		return error.status !== undefined && retryableStatusCodes.includes(error.status);
	}

	// Network-level failures carry no status.
	const message = error.message.toLowerCase();
	for (const pattern of networkErrorPatterns) {
		if (message.includes(pattern.toLowerCase())) {
			return true;
		}
	}

	return false;
}

/**
 * Check if a mime type is an image type.
 */
export function isImageMimeType(mimeType: unknown): boolean {
	return typeof mimeType === "string" && mimeType.startsWith("image/");
}

/**
 * VS Code MIME type for MCP tool result resource links.
 * The data is a JSON string: { "uri": string, "underlyingMimeType"?: string }.
 * @see https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/mcp/common/mcpTypes.ts
 */
export const RESOURCE_LINK_MIME = "application/vnd.code.resource-link";

/**
 * Check if a mime type is an MCP resource-link data part.
 */
export function isResourceLinkMimeType(mimeType: string): boolean {
	return mimeType === RESOURCE_LINK_MIME;
}

/**
 * Parsed contents of an MCP resource-link data part.
 */
export interface ParsedResourceLink {
	uri: string;
	underlyingMimeType?: string;
}

/**
 * Parse the JSON payload of an MCP resource-link data part.
 * Returns null when the payload is not a valid resource link.
 */
export function parseResourceLinkData(data: Uint8Array): ParsedResourceLink | null {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
		if (parsed && typeof parsed === "object" && typeof (parsed as { uri?: unknown }).uri === "string") {
			const uri = (parsed as { uri: string }).uri;
			const underlying = (parsed as { underlyingMimeType?: unknown }).underlyingMimeType;
			return {
				uri,
				...(typeof underlying === "string" ? { underlyingMimeType: underlying } : {}),
			};
		}
	} catch {
		// ignore malformed payloads
	}
	return null;
}

const RESOURCE_LINK_EXT_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

/**
 * Guess an image MIME type from a resource URI path extension.
 */
export function guessImageMimeTypeFromUri(uri: string): string | undefined {
	try {
		const pathname = vscode.Uri.parse(uri).path.toLowerCase();
		const ext = pathname.slice(pathname.lastIndexOf("."));
		return RESOURCE_LINK_EXT_MIME[ext];
	} catch {
		return undefined;
	}
}

/**
 * Resolve an MCP resource-link data part to actual image bytes when possible.
 * VS Code registers a file system provider for `vscode-chat-response-resource://`
 * URIs, so images can be read back while the chat session is alive.
 * Returns null when the link is not an image or cannot be read.
 */
export async function resolveResourceLinkToImage(
	data: Uint8Array
): Promise<{ data: Uint8Array; mimeType: string } | null> {
	const link = parseResourceLinkData(data);
	if (!link) {
		return null;
	}

	const mimeType = link.underlyingMimeType || guessImageMimeTypeFromUri(link.uri);
	if (!mimeType || !isImageMimeType(mimeType)) {
		return null;
	}

	try {
		const uri = vscode.Uri.parse(link.uri);
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (!bytes || bytes.length === 0) {
			return null;
		}
		return { data: bytes, mimeType };
	} catch {
		// Resource may be gone (session disposed) or scheme not readable.
		return null;
	}
}

/**
 * Regex pattern to match data URI encoded images in text.
 * Matches: data:image/{format};base64,{base64_data}
 */
const DATA_URI_IMAGE_RE = /data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)/g;

/**
 * Detect base64-encoded data URI images in text, decode and store them.
 * Used during the image storage pass in convertMessages.
 * @returns The number of data URI images found and stored.
 */
export function storeDataUriImages(text: string, imagesToStore: StoredImage[]): number {
	let count = 0;
	DATA_URI_IMAGE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = DATA_URI_IMAGE_RE.exec(text)) !== null) {
		const fullMatch = match[0];
		// Defensive: strip whitespace/line breaks that some sources embed.
		const base64Data = match[1].replace(/\s+/g, "");
		count++;

		let mimeType = "image/png";
		if (fullMatch.startsWith("data:image/jpeg")) mimeType = "image/jpeg";
		else if (fullMatch.startsWith("data:image/gif")) mimeType = "image/gif";
		else if (fullMatch.startsWith("data:image/webp")) mimeType = "image/webp";
		else if (fullMatch.startsWith("data:image/bmp")) mimeType = "image/bmp";

		// Decode with Buffer: unlike atob it does not throw on payloads
		// that are not strictly encoded (stray "=" padding, line breaks),
		// which previously failed the whole storage pass (#68).
		const buffer = Buffer.from(base64Data, "base64");
		const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		imagesToStore.push({ data: bytes, mimeType });
	}
	return count;
}

/**
 * Replace base64-encoded data URI images in text with image index references.
 * Does NOT store images (they should already be stored by the storage pass).
 * @param text The text to scan.
 * @param startIndex The starting imageIndex to assign.
 * @returns { text: string; count: number } The modified text and number of replacements.
 */
export function replaceDataUriImages(text: string, startIndex: number): { text: string; count: number } {
	let result = text;
	let offset = 0;
	let count = 0;
	let idx = startIndex;

	DATA_URI_IMAGE_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = DATA_URI_IMAGE_RE.exec(text)) !== null) {
		const fullMatch = match[0];
		count++;
		const before = result.slice(0, match.index + offset);
		const after = result.slice(match.index + offset + fullMatch.length);
		const replacement = `\n[Image data from tool call (imageIndex=${idx}). I am a text-only model and CANNOT see images directly. I MUST call the ask_image tool to learn about it.\n\nRecommended strategy:\n1. First call ask_image for a brief description to get an overview of the image.\n2. Then call ask_image again with specific questions about details you need (e.g., colors, text content, UI elements, error messages, or any other visible information).\n]`;
		result = before + replacement + after;
		offset += replacement.length - fullMatch.length;
		idx++;
	}

	return { text: result, count };
}

/**
 * Create a data URL from a LanguageModelDataPart.
 */
export function createDataUrl(part: vscode.LanguageModelDataPart): string {
	const base64 = arrayBufferToBase64(part.data);
	return `data:${part.mimeType};base64,${base64}`;
}

function arrayBufferToBase64(buffer: Uint8Array): string {
	let binary = "";
	const bytes = new Uint8Array(buffer);
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

/**
 * Check if a part is a tool result part.
 */
export function isToolResultPart(part: unknown): part is vscode.LanguageModelToolResultPart {
	return part instanceof vscode.LanguageModelToolResultPart;
}

/**
 * Collect text content from a tool result part.
 */
export function collectToolResultText(part: { content?: ReadonlyArray<unknown> }): string {
	if (!part.content) {
		return "";
	}
	const texts: string[] = [];
	for (const item of part.content) {
		if (item instanceof vscode.LanguageModelTextPart) {
			texts.push(item.value);
		}
	}
	return texts.join("\n").trim();
}

/**
 * Safely try to parse a JSON object from a string.
 * Returns { ok: true, value } or { ok: false }.
 */
export function tryParseJSONObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return { ok: true, value: parsed as Record<string, unknown> };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

export function delay(ms: number, token?: CancellationToken): Promise<void> {
	return new Promise((resolve) => {
		if (token?.isCancellationRequested) {
			return resolve();
		}
		const timer = setTimeout(() => {
			disposable?.dispose();
			resolve();
		}, ms);
		const disposable = token?.onCancellationRequested(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}
