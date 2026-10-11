import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart,
	PrepareLanguageModelChatModelOptions,
	ProvideLanguageModelChatResponseOptions,
	Progress,
} from "vscode";

import * as path from "path";

import type { ApiMode, ModelPreset, KenariModelItem } from "./types";

import {
	ApiError,
	createApiError,
	createRetryConfig,
	executeWithRetry,
	convertToolsToOpenAI,
	getInferenceBaseUrlOverride,
	validateBaseUrl,
} from "./utils";
import { KENARI_BASE_URL } from "./modelCatalog";

import { prepareLanguageModelChatInformation } from "./provideModel";
import { getModelConfig, resolveVisionProxyModelId } from "./catalogModels";
import { l10nFormat } from "./localize";
import { countMessageTokens, textTokenLength } from "./provideToken";
import {
	updateContextStatusBar,
	recordUsage,
	updateCumulativeTooltip,
	updateStatusBarWithApiPrompt,
} from "./statusBar";
import { OpenaiApi } from "./openai/openaiApi";
import { ResponsesApi } from "./openai/responsesApi";
import type { ResponsesRequestBody } from "./openai/responsesTypes";
import { AnthropicApi, buildAnthropicThinkingConfig } from "./anthropic/anthropicApi";
import type { AnthropicRequestBody } from "./anthropic/anthropicTypes";
import { CommonApi, type StreamUsage } from "./commonApi";
import { callVisionModel, callVisionModelMulti } from "./vision/imageProxy";
import { ASK_IMAGE_TOOL_DEF, ASK_WITH_MULTI_IMAGE_TOOL_NAME, ASK_WITH_MULTI_IMAGE_TOOL_DEF } from "./vision/types";
import type { StoredImage } from "./vision/types";
import { createVisionToolHistoryPart } from "./vision/historyPart";
import type { VisionToolHistoryEntry } from "./vision/historyCodec";
import { logger } from "./logger";
import { l10n } from "./localize";

/**
 * Native Copilot Token Indicator
 *
 * Reports token usage to the Copilot Chat's built-in token indicator by emitting
 * a LanguageModelDataPart with MIME type 'usage'. Copilot Chat intercepts this
 * part and displays it in the native UI element, just like GitHub Copilot's own
 * models do.
 *
 * This is always active. The separate Advanced Token indicator can be
 * controlled via the "kenari.enableThirdPartyTokenIndicator" setting.
 */
function reportNativeUsage(usage: StreamUsage, progress: Progress<LanguageModelResponsePart>): void {
	progress.report(
		new vscode.LanguageModelDataPart(
			new TextEncoder().encode(
				JSON.stringify({
					prompt_tokens: usage.promptTokens,
					completion_tokens: usage.completionTokens,
					total_tokens: usage.promptTokens + usage.completionTokens,
					prompt_tokens_details: {
						cached_tokens: usage.cacheHitTokens ?? 0,
					},
				})
			),
			"usage"
		)
	);
}

function getRequestedReasoningEffort(options: ProvideLanguageModelChatResponseOptions): string | undefined {
	const modelConfigurationEffort = options.modelConfiguration?.reasoningEffort;
	if (typeof modelConfigurationEffort === "string") {
		return modelConfigurationEffort;
	}

	const modelOptions = (options as unknown as { modelOptions?: Record<string, unknown> }).modelOptions;
	const modelOptionsThinking = modelOptions?.thinking as { type?: unknown } | undefined;
	if (modelOptionsThinking?.type === false) {
		return "disabled";
	}

	const modelOptionsEffort = modelOptions?.reasoning_effort ?? modelOptions?.reasoningEffort;
	return typeof modelOptionsEffort === "string" ? modelOptionsEffort : undefined;
}

/**
 * Pick out the settings that decide model behaviour from a request body, so
 * the log shows the effective values without the message array. Handles every
 * apiMode: Anthropic keeps reasoning under `thinking` / `output_config`.
 */
function summarizeWireRequest(body: Record<string, unknown>): Record<string, unknown> {
	return {
		model: body.model ?? null,
		maxTokens: body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens ?? null,
		temperature: body.temperature ?? null,
		topP: body.top_p ?? null,
		reasoningEffort: body.reasoning_effort ?? null,
		reasoning: body.reasoning ?? null,
		thinking: body.thinking ?? null,
		outputConfig: body.output_config ?? null,
		tools: Array.isArray(body.tools) ? body.tools.length : 0,
		messages: Array.isArray(body.messages)
			? body.messages.length
			: Array.isArray(body.input)
				? body.input.length
				: 0,
	};
}

/**
 * VS Code Chat provider backed by the Kenari API.
 */
export class KenariChatModelProvider implements LanguageModelChatProvider {
	/** Track last request completion time for delay calculation. */
	private _lastRequestTime: number | null = null;

	/**
	 * Create a provider using the given secret storage for the API key.
	 */
	constructor(
		private readonly secrets: vscode.SecretStorage,
		private readonly statusBarItem: vscode.StatusBarItem
	) {}

	/**
	 * Create an undici fetch function with custom bodyTimeout to prevent premature
	 * connection termination during long streaming responses.
	 * Falls back to global fetch if undici is unavailable.
	 */
	private _createFetchWithTimeout(requestTimeoutMs: number): typeof fetch {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const undici = require(path.join(vscode.env.appRoot, "node_modules", "undici"));
			const agent = new undici.Agent({ bodyTimeout: requestTimeoutMs });
			return (url: RequestInfo | URL, init?: RequestInit) => {
				return undici.fetch(url, { ...init, dispatcher: agent });
			};
		} catch {
			return fetch;
		}
	}

	/**
	 * Get the list of available language models contributed by this provider.
	 */
	async provideLanguageModelChatInformation(
		options: PrepareLanguageModelChatModelOptions,
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		return prepareLanguageModelChatInformation(options, _token);
	}

	/**
	 * Returns the number of tokens for a given text using the model specific tokenizer logic.
	 */
	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage
	): Promise<number> {
		return countMessageTokens(text, { includeReasoningInRequest: true });
	}

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 */
	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken
	): Promise<void> {
		let usageReportedDuringStream = false;
		const collectedOutputText: string[] = [];
		const trackingProgress: Progress<LanguageModelResponsePart> = {
			report: (part) => {
				try {
					if (part instanceof vscode.LanguageModelTextPart) {
						collectedOutputText.push(part.value);
					}
					progress.report(part);
				} catch (e) {
					console.error("[Kenari] Progress.report failed", {
						modelId: model.id,
						error: e instanceof Error ? { name: e.name, message: e.message } : String(e),
					});
				}
			},
		};
		const requestStartTime = Date.now();

		// Timeout controller (declared outside try so accessible in catch/finally)
		let abortController = new AbortController();
		let requestTimeoutMs = 600000;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let dispatchFetch: typeof fetch;

		try {
			// Resolve model config from the unified catalog layer.
			const config = vscode.workspace.getConfiguration();
			// Shallow copy to avoid mutating the shared resolved config.
			let um: KenariModelItem | undefined = { ...getModelConfig(model.id) };

			// Apply reasoning effort from model configuration to determine thinking mode
			// - "disabled" → turn off thinking (unless model has thinkingMode="always")
			// - "enabled" → turn on thinking with default effort
			// - "high"/"max" → turn on thinking with specified effort
			if (um) {
				const effort = getRequestedReasoningEffort(options);
				if (effort) {
					if (effort === "disabled") {
						if (um.thinkingMode !== "always") {
							um.enable_thinking = false;
							um.include_reasoning_in_request = false;
							um.reasoning_effort = undefined;
						}
					} else {
						um.enable_thinking = true;
						um.include_reasoning_in_request = true;
						if (effort !== "enabled") {
							um.reasoning_effort = effort;
						}
					}
				}
			}

			// Inject temperature & top_p from model preset or custom settings
			if (um) {
				if (um.supportsTemperature !== false) {
					const tempPreset = config.get<string>("kenari.modelPreset", "custom");
					if (tempPreset !== "custom") {
						const presets = config.get<ModelPreset[]>("kenari.modelPresets", []);
						const matchedPreset = presets.find((p) => p.id === tempPreset);
						if (matchedPreset) {
							um.temperature = matchedPreset.temperature;
						}
					} else {
						const userTemperature = config.get<number | null>("kenari.temperature", null);
						if (userTemperature !== null) {
							um.temperature = userTemperature;
						}
						const userTopP = config.get<number | null>("kenari.top_p", null);
						if (userTopP !== null) {
							um.top_p = userTopP;
						} else {
							// Keep top_p undefined so the model uses its default
							um.top_p = undefined;
						}
					}
				} else {
					// Model does not support temperature; ensure it's not sent
					um.temperature = undefined;
					um.top_p = undefined;
				}
			}

			// Determine API mode from model config (default: openai)
			const apiMode = um?.apiMode || "openai";
			// User-configured proxy base URL wins over the official URL.
			const baseUrlOverride = getInferenceBaseUrlOverride();
			const baseUrl = baseUrlOverride || um?.baseUrl || KENARI_BASE_URL;

			// Which reasoning control will be sent, and what the user picked.
			const requestedEffort = getRequestedReasoningEffort(options);
			const reasoningPlan =
				um?.enable_thinking === false
					? "off"
					: um?.enable_thinking === true
						? (um.reasoning_effort ?? "on")
						: "model-default";

			const requestSettings = {
				requestedModelId: model.id,
				wireModelId: um?.id ?? model.id,
				apiMode,
				baseUrl,
				requestedEffort: requestedEffort ?? null,
				appliedReasoning: reasoningPlan,
				temperature: um?.temperature ?? null,
				topP: um?.top_p ?? null,
				topK: um?.top_k ?? null,
				modelPreset: config.get<string>("kenari.modelPreset", "custom"),
				maxOutputTokens: um?.max_completion_tokens ?? null,
				contextWindow: um?.context_length ?? null,
				messageCount: messages.length,
				toolCount: options.tools?.length ?? 0,
			};

			// Logged so the Output panel shows which model is called with which
			// settings. `requestedEffort` is what VS Code sent; `appliedReasoning`
			// is what we acted on.
			logger.info("request.settings", {
				...requestSettings,
				summary:
					`model=${requestSettings.wireModelId} mode=${apiMode} reasoning=${reasoningPlan}` +
					(requestedEffort ? ` (requested ${requestedEffort})` : "") +
					` temp=${requestSettings.temperature ?? "-"} top_p=${requestSettings.topP ?? "-"}` +
					` maxOut=${requestSettings.maxOutputTokens ?? "-"} ctx=${requestSettings.contextWindow ?? "-"}` +
					` msgs=${requestSettings.messageCount} tools=${requestSettings.toolCount}`,
			});

			// Prepare model configuration
			const modelConfig = {
				includeReasoningInRequest: um?.include_reasoning_in_request ?? true,
				vision: um?.vision ?? false,
			};

			// Read Advanced Token indicator setting
			const enableThirdPartyIndicator = config.get<boolean>("kenari.enableThirdPartyTokenIndicator", true);

			// The adapter used for this request, kept so the truncation flag set
			// during streaming can be read once the round finishes.
			let activeAdapter: CommonApi<any, any> | undefined;

			// Truncation of the main answer, captured before any vision round
			// reuses the adapter and resets the flag.
			let mainResponseTruncated: boolean | undefined;

			// Calculate client-side token estimate for fallback (also updates Advanced Token indicator if enabled)
			const estimatedInputTokens = await updateContextStatusBar(
				messages,
				options.tools,
				this.statusBarItem,
				modelConfig
			);

			// Apply delay between consecutive requests
			const modelDelay = um?.delay;
			const globalDelay = config.get<number>("kenari.delay", 0);
			const delayMs = modelDelay !== undefined ? modelDelay : globalDelay;

			if (delayMs > 0 && this._lastRequestTime !== null) {
				const elapsed = Date.now() - this._lastRequestTime;
				if (elapsed < delayMs) {
					const remainingDelay = delayMs - elapsed;
					logger.debug("request.delay", { delayMs, elapsed, remainingDelay });
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(() => {
							clearTimeout(timeout);
							resolve();
						}, remainingDelay);
					});
				}
			}

			// Get API key
			const modelApiKey = await this.ensureApiKey();
			if (!modelApiKey) {
				logger.warn("apiKey.missing", {});
				throw new Error(l10n("Kenari API key not found"));
			}

			// Send chat request - validate base URL (reject plain HTTP for remote addresses)
			const BASE_URL = baseUrl;
			const baseUrlError = validateBaseUrl(BASE_URL);
			if (baseUrlError) {
				throw new Error(baseUrlError);
			}

			// Get retry config
			const retryConfig = createRetryConfig();

			// Create request timeout abort controller (default: 10 minutes)
			requestTimeoutMs = config.get<number>("kenari.requestTimeout", 600000);
			abortController = new AbortController();
			timeoutId = setTimeout(() => abortController.abort(), requestTimeoutMs);
			// Connect VS Code cancellation token to abort the fetch immediately when user stops
			if (token.onCancellationRequested) {
				token.onCancellationRequested(() => {
					if (!abortController.signal.aborted) {
						abortController.abort();
					}
				});
			}
			// Create undici fetch with custom bodyTimeout (extends TCP idle timeout during streaming)
			dispatchFetch = this._createFetchWithTimeout(requestTimeoutMs);

			// Prepare headers with custom headers if specified.
			const requestHeaders = CommonApi.prepareHeaders(modelApiKey, apiMode, um?.headers);
			logger.debug("request.headers", {
				headers: logger.sanitizeHeaders(requestHeaders as Record<string, string>),
			});
			logger.debug("request.messages.origin", { messages });

			if (apiMode === "anthropic") {
				// Anthropic API mode
				const anthropicApi = new AnthropicApi(model.id);
				activeAdapter = anthropicApi;
				anthropicApi.onUsage = (usage) => {
					usageReportedDuringStream = true;
					// Always report to native Copilot indicator (use original progress, not trackingProgress wrapper)
					reportNativeUsage(usage, progress);
					// Conditionally update Advanced Token indicator
					if (enableThirdPartyIndicator) {
						recordUsage(usage);
						updateCumulativeTooltip(this.statusBarItem);
						updateStatusBarWithApiPrompt(this.statusBarItem);
					}
				};
				const anthropicMessages = await anthropicApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: AnthropicRequestBody = {
					model: um?.id ?? model.id,
					messages: anthropicMessages,
					stream: true,
				};
				requestBody = anthropicApi.prepareRequestBody(requestBody, um, options);

				// Build Anthropic messages endpoint URL
				const normalizedBaseUrl = BASE_URL.replace(/\/+$/, "");
				const url = normalizedBaseUrl.endsWith("/v1")
					? `${normalizedBaseUrl}/messages`
					: `${normalizedBaseUrl}/v1/messages`;
				logger.info("request.send", {
					summary: `anthropic POST ${url}`,
					url,
					wire: summarizeWireRequest(requestBody as unknown as Record<string, unknown>),
				});
				const response = await executeWithRetry(async () => {
					const res = await dispatchFetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
						signal: abortController.signal,
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Kenari] Anthropic Messages API error response", errorText);
						throw createApiError(res, errorText, "Anthropic Messages API error", url);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Anthropic API");
				}
				await anthropicApi.processStreamingResponse(response.body, trackingProgress, token);

				// --- Second round: handle ask_image tool call interception ---
				// Clear the first-round timeout before starting the second round
				clearTimeout(timeoutId);
				await this._handleInterceptedToolCall({
					api: anthropicApi,
					apiMode: "anthropic",
					model: model,
					um: um,
					messages: messages,
					modelApiKey: modelApiKey,
					baseUrl: BASE_URL,
					dispatchFetch: dispatchFetch,
					requestHeaders: requestHeaders,
					retryConfig: retryConfig,
					abortController: abortController,
					trackingProgress: trackingProgress,
					token: token,
					options: options,
				});
			} else if (apiMode === "openai-responses") {
				// OpenAI Responses API mode
				const responsesApi = new ResponsesApi(model.id);
				activeAdapter = responsesApi;
				responsesApi.onUsage = (usage) => {
					usageReportedDuringStream = true;
					reportNativeUsage(usage, progress);
					if (enableThirdPartyIndicator) {
						recordUsage(usage);
						updateCumulativeTooltip(this.statusBarItem);
						updateStatusBarWithApiPrompt(this.statusBarItem);
					}
				};
				const responsesInput = await responsesApi.convertMessages(messages, modelConfig);

				let requestBody: ResponsesRequestBody = {
					model: um?.id ?? model.id,
					input: responsesInput,
					stream: true,
					store: false,
				};
				requestBody = responsesApi.prepareRequestBody(requestBody, um, options);

				const url = `${BASE_URL.replace(/\/+$/, "")}/responses`;
				logger.info("request.send", {
					summary: `responses POST ${url}`,
					url,
					wire: summarizeWireRequest(requestBody as unknown as Record<string, unknown>),
				});
				const response = await executeWithRetry(async () => {
					const res = await dispatchFetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
						signal: abortController.signal,
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Kenari] Responses API error response", errorText);
						throw createApiError(res, errorText, "Responses API error", url);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from Responses API");
				}
				await responsesApi.processStreamingResponse(response.body, trackingProgress, token);

				clearTimeout(timeoutId);
				await this._handleInterceptedToolCall({
					api: responsesApi,
					apiMode: "openai-responses",
					model: model,
					um: um,
					messages: messages,
					modelApiKey: modelApiKey,
					baseUrl: BASE_URL,
					dispatchFetch: dispatchFetch,
					requestHeaders: requestHeaders,
					retryConfig: retryConfig,
					abortController: abortController,
					trackingProgress: trackingProgress,
					token: token,
					options: options,
				});
			} else {
				// OpenAI Chat Completions API mode
				const openaiApi = new OpenaiApi(model.id);
				activeAdapter = openaiApi;
				openaiApi.onUsage = (usage) => {
					usageReportedDuringStream = true;
					// Always report to native Copilot indicator (use original progress, not trackingProgress wrapper)
					reportNativeUsage(usage, progress);
					// Conditionally update Advanced Token indicator
					if (enableThirdPartyIndicator) {
						recordUsage(usage);
						updateCumulativeTooltip(this.statusBarItem);
						updateStatusBarWithApiPrompt(this.statusBarItem);
					}
				};
				const openaiMessages = await openaiApi.convertMessages(messages, modelConfig);

				// requestBody
				let requestBody: Record<string, unknown> = {
					model: um?.id ?? model.id,
					messages: openaiMessages,
					stream: true,
					stream_options: { include_usage: true },
				};

				requestBody = openaiApi.prepareRequestBody(requestBody, um, options);

				// Send chat request with retry
				const url = `${BASE_URL.replace(/\/+$/, "")}/chat/completions`;
				logger.info("request.send", {
					summary: `chat-completions POST ${url}`,
					url,
					wire: summarizeWireRequest(requestBody),
				});
				const response = await executeWithRetry(async () => {
					const res = await dispatchFetch(url, {
						method: "POST",
						headers: requestHeaders,
						body: JSON.stringify(requestBody),
						signal: abortController.signal,
					});

					if (!res.ok) {
						const errorText = await res.text();
						console.error("[Kenari] API error response", errorText);
						throw createApiError(res, errorText, "API error", url);
					}

					return res;
				}, retryConfig);

				if (!response.body) {
					throw new Error("No response body from API");
				}

				await openaiApi.processStreamingResponse(response.body, trackingProgress, token);

				// Record truncation from the main answer before the vision round
				// runs; that round reuses this adapter and resets the flag.
				mainResponseTruncated = openaiApi._responseTruncated;

				// --- Second round: handle ask_image tool call interception ---
				// Clear the first-round timeout before starting the second round
				clearTimeout(timeoutId);
				await this._handleInterceptedToolCall({
					api: openaiApi,
					apiMode: "openai",
					model: model,
					um: um,
					messages: messages,
					modelApiKey: modelApiKey,
					baseUrl: BASE_URL,
					dispatchFetch: dispatchFetch,
					requestHeaders: requestHeaders,
					retryConfig: retryConfig,
					abortController: abortController,
					trackingProgress: trackingProgress,
					token: token,
					options: options,
				});
			}

			// Report truncation only when the answer the user sees was cut off.
			if (mainResponseTruncated ?? activeAdapter?._responseTruncated) {
				logger.warn("request.truncated", { modelId: model.id, apiMode });
				progress.report(
					new vscode.LanguageModelTextPart(
						l10n(
							"\n\n_[The response was cut off: it reached the model's output token limit. Ask for something shorter, or lower the reasoning effort.]_"
						)
					)
				);
			}

			// Fallback: if API did not return usage data, use client-side calculation for native indicator
			if (!usageReportedDuringStream) {
				const outputText = collectedOutputText.join("");
				const estimatedOutputTokens = outputText ? await textTokenLength(outputText) : 0;
				const fallbackUsage: StreamUsage = {
					promptTokens: estimatedInputTokens,
					completionTokens: estimatedOutputTokens,
				};
				reportNativeUsage(fallbackUsage, progress);
				if (enableThirdPartyIndicator) {
					recordUsage(fallbackUsage);
					updateCumulativeTooltip(this.statusBarItem);
				}
			}
		} catch (err) {
			// Determine if the request was aborted/terminated (friendly message instead of raw error)
			const errMessage = err instanceof Error ? err.message : String(err);
			// Distinguish user cancellation from timeout: the AbortController is aborted
			// by BOTH the timeout timer AND the user cancellation listener; check the
			// VS Code cancellation token to tell them apart.
			const isUserCancelled = token.isCancellationRequested;
			const isTimeout = abortController.signal.aborted && !isUserCancelled;
			const isForceTerminated =
				!isTimeout &&
				!isUserCancelled &&
				(errMessage.includes("terminated") ||
					errMessage.includes("aborted") ||
					(err instanceof Error && err.name === "AbortError"));

			// If user cancelled, just re-throw the original error without wrapping
			if (isUserCancelled) {
				throw err;
			}

			if (isTimeout || isForceTerminated) {
				logger.error("request.timeout", {
					modelId: model.id,
					timeoutMs: requestTimeoutMs,
					durationMs: Date.now() - requestStartTime,
					reason: isForceTerminated ? "connection_terminated" : "timeout",
				});
				if (isForceTerminated) {
					throw new Error(
						l10n(
							"The connection was closed by the server. The generation took too long. Please try again or request shorter content."
						)
					);
				}
				throw new Error(
					l10n(
						"Request timed out. The generation took too long. You can increase the timeout in settings (kenari.requestTimeout)."
					)
				);
			}

			// Kenari refuses content under its own policy (`request_blocked`) or lets a
			// provider do it (`content_policy_violation`). Neither clears on a retry,
			// so report them in plain language instead of the raw envelope.
			if (
				err instanceof ApiError &&
				(err.code === "request_blocked" || err.code === "content_policy_violation")
			) {
				logger.error("request.error", {
					modelId: model.id,
					error: err.code,
					errorMessage: errMessage,
				});
				throw new Error(
					l10n(
						"Kenari blocked this request under its content policy. Change the content of the request and try again."
					)
				);
			}

			console.error("[Kenari] Chat request failed", {
				modelId: model.id,
				messageCount: messages.length,
				error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
			});
			logger.error("request.error", {
				modelId: model.id,
				messageCount: messages.length,
				errorName: err instanceof Error ? err.name : String(err),
				errorMessage: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			clearTimeout(timeoutId);
			const durationMs = Date.now() - requestStartTime;
			logger.info("request.end", { modelId: model.id, durationMs });
			this._lastRequestTime = Date.now();
		}
	}

	/**
	 * Handle an ask_image tool call interception by calling the vision model
	 * with the model's specific query and making a second round API request
	 * with the tool call + result. Unlike the old describe_image approach,
	 * the model asks specific questions (query) about the image.
	 */
	private async _handleInterceptedToolCall(params: {
		api: CommonApi<any, any>;
		apiMode: ApiMode;
		model: LanguageModelChatInformation;
		um: KenariModelItem | undefined;
		messages: readonly LanguageModelChatRequestMessage[];
		modelApiKey: string;
		baseUrl: string;
		dispatchFetch: typeof fetch;
		requestHeaders: Record<string, string>;
		retryConfig: ReturnType<typeof createRetryConfig>;
		abortController: AbortController;
		trackingProgress: Progress<LanguageModelResponsePart>;
		token: CancellationToken;
		options: ProvideLanguageModelChatResponseOptions;
	}): Promise<void> {
		const api = params.api;
		const storedMessages = (api as any)._originalApiMessages as any[] | undefined;
		const hasLocalImages = ((api as any)._localImages as any[])?.length > 0;

		// Nothing to proxy - no stored images
		if (!hasLocalImages) {
			logger.debug("vision.no-stored-images", {
				hasStoredMessages: !!storedMessages,
			});
			return;
		}
		if (!storedMessages || storedMessages.length === 0) {
			logger.warn("vision.no-second-round-messages", {});
			return;
		}

		const config = vscode.workspace.getConfiguration();
		const visionModelId = await resolveVisionProxyModelId(
			config.get<string>("kenari.visionProxyModel", "qwen3-7-plus")
		);
		const maxRounds = config.get<number>("kenari.visionMaxRounds", 5);

		// Accumulate messages across rounds
		let currentMessages: any[] = [...storedMessages];

		for (let round = 1; round <= maxRounds; round++) {
			const intercepted = api.interceptedToolCall;
			if (!intercepted) {
				break;
			}
			// Clear so processStreamingResponse in the next round can set a new one
			api.interceptedToolCall = null;

			logger.info("vision.intercepted", {
				round,
				toolName: intercepted.name,
				imageIndex: intercepted.args.imageIndex,
				imageIndices: intercepted.args.imageIndices,
				query: intercepted.args.query,
				apiMode: params.apiMode,
			});

			const visionPrompt = intercepted.args.query;

			// Block 1: show the model's question in a thinking block
			const questionThinkId = `vision_q_${Date.now()}_${round}`;
			params.trackingProgress.report(
				new vscode.LanguageModelThinkingPart(
					l10nFormat('Querying vision model: "{0}"', visionPrompt ?? ""),
					questionThinkId
				) as unknown as LanguageModelResponsePart
			);
			// Close block 1
			params.trackingProgress.report(
				new vscode.LanguageModelThinkingPart("", questionThinkId) as unknown as LanguageModelResponsePart
			);

			// Block 2: vision model's thinking/reasoning (real-time streaming)
			const thinkBlockId = `vision_think_${Date.now()}_${round}`;
			// Block 3: vision model's final output (real-time streaming)
			const textBlockId = `vision_text_${Date.now()}_${round}`;

			const visionProgress = {
				onThinking: (text: string) => {
					params.trackingProgress.report(
						new vscode.LanguageModelThinkingPart(text, thinkBlockId) as unknown as LanguageModelResponsePart
					);
				},
				onText: (text: string) => {
					params.trackingProgress.report(
						new vscode.LanguageModelThinkingPart(text, textBlockId) as unknown as LanguageModelResponsePart
					);
				},
			};

			// Call vision model - single image or multi-image depending on tool used.
			let description: string;
			try {
				if (intercepted.name === ASK_WITH_MULTI_IMAGE_TOOL_NAME) {
					// Multi-image: collect all referenced images
					const indices = intercepted.args.imageIndices ?? [];
					const images: StoredImage[] = [];
					for (const idx of indices) {
						const img = api.getStoredImage(idx);
						if (img) images.push(img);
					}
					if (images.length < 2) {
						logger.warn("vision.not-enough-images", { indices });
						description = "[Not enough images for comparison]";
					} else {
						description = await callVisionModelMulti(
							images,
							visionModelId,
							visionPrompt,
							params.token,
							visionProgress
						);
					}
				} else {
					// Single image
					const storedImage = api.getStoredImage(intercepted.args.imageIndex ?? 0);
					if (!storedImage) {
						logger.warn("vision.image-not-found", {
							imageIndex: intercepted.args.imageIndex,
						});
						description = "[Image not found]";
					} else {
						description = await callVisionModel(
							storedImage.data,
							storedImage.mimeType,
							visionModelId,
							visionPrompt,
							params.token,
							visionProgress
						);
					}
				}
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				logger.error("vision.call-failed", { error: errMsg, visionModelId });
				description = "[Image query unavailable]";
			}

			// Close block 2 (vision thinking)
			params.trackingProgress.report(
				new vscode.LanguageModelThinkingPart("", thinkBlockId) as unknown as LanguageModelResponsePart
			);
			// Close block 3 (vision output)
			params.trackingProgress.report(
				new vscode.LanguageModelThinkingPart("", textBlockId) as unknown as LanguageModelResponsePart
			);

			// Persist the completed internal tool exchange in the response
			// stream. VS Code can carry this DataPart into the next request;
			// the API converters then rebuild the standard tool messages.
			const previousReasoning =
				params.apiMode === "openai"
					? ((api as any)._capturedReasoningContent as string | undefined)
					: undefined;
			const historyEntry: VisionToolHistoryEntry = {
				id: intercepted.id,
				name: intercepted.name as VisionToolHistoryEntry["name"],
				args: intercepted.args,
				result: description,
				...(previousReasoning !== undefined ? { reasoningContent: previousReasoning } : {}),
			};
			params.trackingProgress.report(
				createVisionToolHistoryPart(historyEntry) as unknown as LanguageModelResponsePart
			);

			if (params.token.isCancellationRequested) {
				logger.info("vision.skipped-round", {
					round,
					reason: "user_cancelled",
				});
				break;
			}

			// Build round messages
			// Create a fresh abort controller for this round
			const roundAbortController = new AbortController();
			const roundTimeoutMs = vscode.workspace.getConfiguration().get<number>("kenari.requestTimeout", 600000);
			const roundTimeoutId = setTimeout(() => {
				if (!roundAbortController.signal.aborted) {
					roundAbortController.abort();
				}
			}, roundTimeoutMs);
			// Forward user cancellation to the new controller
			if (params.token.onCancellationRequested) {
				params.token.onCancellationRequested(() => {
					if (!roundAbortController.signal.aborted) {
						roundAbortController.abort();
					}
				});
			}

			try {
				if (params.apiMode === "anthropic") {
					// Anthropic format: tool_use + tool_result
					currentMessages.push({
						role: "assistant" as const,
						content: [
							{
								type: "tool_use" as const,
								id: intercepted.id,
								name: intercepted.name,
								input: intercepted.args,
							},
						],
					});
					currentMessages.push({
						role: "user" as const,
						content: [
							{
								type: "tool_result" as const,
								tool_use_id: intercepted.id,
								content: description,
							},
						],
					});

					const body: Record<string, unknown> = {
						model: params.um?.id ?? params.model.id,
						messages: currentMessages,
						stream: true,
					};
					if (params.um?.max_completion_tokens !== undefined) {
						body.max_tokens = params.um.max_completion_tokens;
					} else if (params.um?.max_tokens !== undefined) {
						body.max_tokens = params.um.max_tokens;
					}
					if (params.um?.temperature !== undefined && params.um.temperature !== null) {
						if (params.um.supportsTemperature !== false) {
							body.temperature = params.um.temperature;
						}
					}
					const systemContent = (params.api as any)._systemContent as string | undefined;
					if (systemContent) {
						body.system = systemContent;
					}
					// The thinking budget must stay below `max_tokens`, so the helper
					// gets the value set just above (or the API default).
					Object.assign(
						body,
						buildAnthropicThinkingConfig(
							params.um,
							(typeof body.max_tokens === "number" ? body.max_tokens : undefined) ?? 65536
						)
					);

					// Inject tools (VS Code + ask_image + ask_with_multi_image)
					const anthropicToolList: Array<{
						name: string;
						description?: string;
						input_schema?: object;
					}> = [];
					const toolConfig = convertToolsToOpenAI(params.options);
					if (toolConfig.tools) {
						for (const tool of toolConfig.tools) {
							anthropicToolList.push({
								name: tool.function.name,
								description: tool.function.description,
								input_schema: tool.function.parameters,
							});
						}
					}
					if (hasLocalImages) {
						const singleDef = ASK_IMAGE_TOOL_DEF as unknown as {
							function: {
								name: string;
								description: string;
								parameters: object;
							};
						};
						anthropicToolList.push({
							name: singleDef.function.name,
							description: singleDef.function.description,
							input_schema: singleDef.function.parameters,
						});
						if (((api as any)._localImages as any[])?.length >= 2) {
							const multiDef = ASK_WITH_MULTI_IMAGE_TOOL_DEF as unknown as {
								function: {
									name: string;
									description: string;
									parameters: object;
								};
							};
							anthropicToolList.push({
								name: multiDef.function.name,
								description: multiDef.function.description,
								input_schema: multiDef.function.parameters,
							});
						}
					}
					if (anthropicToolList.length > 0) {
						body.tools = anthropicToolList;
					}
					// Allow the model to freely call ask_image again in this round
					if (hasLocalImages) {
						body.tool_choice = { type: "auto" };
					}

					const normalizedUrl = params.baseUrl.replace(/\/+$/, "");
					const url = normalizedUrl.endsWith("/v1")
						? `${normalizedUrl}/messages`
						: `${normalizedUrl}/v1/messages`;
					logger.info("request.send", {
						summary: `anthropic POST ${url} (vision round ${round})`,
						url,
						round,
						vision: true,
						wire: summarizeWireRequest(body),
					});

					const response = await executeWithRetry(async () => {
						const res = await params.dispatchFetch(url, {
							method: "POST",
							headers: params.requestHeaders,
							body: JSON.stringify(body),
							signal: roundAbortController.signal,
						});
						if (!res.ok) {
							const errorText = await res.text();
							throw createApiError(res, errorText, "Anthropic Messages API error");
						}
						return res;
					}, params.retryConfig);

					if (response.body) {
						await api.processStreamingResponse(response.body, params.trackingProgress, params.token);
					}
				} else if (params.apiMode === "openai-responses") {
					// Responses format: preserve encrypted reasoning items, then append
					// the intercepted function call and its local vision result.
					const responsesApi = api as ResponsesApi;
					currentMessages.push(...responsesApi.takeCapturedReasoningItems());
					currentMessages.push({
						type: "function_call" as const,
						call_id: intercepted.id,
						name: intercepted.name,
						arguments: JSON.stringify(intercepted.args),
					});
					currentMessages.push({
						type: "function_call_output" as const,
						call_id: intercepted.id,
						output: description,
					});

					let body: ResponsesRequestBody = {
						model: params.um?.id ?? params.model.id,
						input: currentMessages,
						stream: true,
						store: false,
					};
					body = responsesApi.prepareRequestBody(body, params.um, params.options);

					const url = `${params.baseUrl.replace(/\/+$/, "")}/responses`;
					logger.info("request.send", {
						summary: `responses POST ${url} (vision round ${round})`,
						url,
						round,
						vision: true,
						wire: summarizeWireRequest(body as unknown as Record<string, unknown>),
					});
					const response = await executeWithRetry(async () => {
						const res = await params.dispatchFetch(url, {
							method: "POST",
							headers: params.requestHeaders,
							body: JSON.stringify(body),
							signal: roundAbortController.signal,
						});
						if (!res.ok) {
							const errorText = await res.text();
							throw createApiError(res, errorText, "Responses API error");
						}
						return res;
					}, params.retryConfig);

					if (response.body) {
						await responsesApi.processStreamingResponse(
							response.body,
							params.trackingProgress,
							params.token
						);
					}
				} else {
					// OpenAI format: append assistant tool_call + tool result
					// Use the reasoning_content captured from the previous round's streaming response.
					// DeepSeek thinking mode requires the original reasoning_content to be echoed back
					// verbatim on every assistant message that follows a tool call - hardcoded strings
					// or empty values cause the model to break (infinite tool loops or 400 errors).
					const prevReasoning = previousReasoning ?? "";
					(api as any)._capturedReasoningContent = "";
					currentMessages.push({
						role: "assistant" as const,
						reasoning_content: prevReasoning,
						tool_calls: [
							{
								id: intercepted.id,
								type: "function" as const,
								function: {
									name: intercepted.name,
									arguments: JSON.stringify(intercepted.args),
								},
							},
						],
					});
					currentMessages.push({
						role: "tool" as const,
						tool_call_id: intercepted.id,
						content: description,
					});

					const body: Record<string, unknown> = {
						model: params.um?.id ?? params.model.id,
						messages: currentMessages,
						stream: true,
						stream_options: { include_usage: true },
					};
					if (params.um?.temperature !== undefined && params.um.temperature !== null) {
						if (params.um.supportsTemperature !== false) {
							body.temperature = params.um.temperature;
						}
					}
					if (params.um?.top_p !== undefined && params.um.top_p !== null) {
						body.top_p = params.um.top_p;
					}
					if (params.um?.max_completion_tokens !== undefined) {
						body.max_completion_tokens = params.um.max_completion_tokens;
					}
					// Reasoning controls, the same rules OpenaiApi.prepareRequestBody
					// applies to the main round: named efforts via `reasoning_effort`,
					// plain on/off via the `reasoning` object. Nothing is sent when the
					// user made no explicit choice.
					if (params.um?.enable_thinking === false) {
						if (params.um.supportsDisablingReasoning !== false) {
							body.reasoning = { enabled: false };
						}
					} else if (params.um?.enable_thinking === true) {
						const effort = params.um.reasoning_effort;
						if (effort && effort !== "enabled" && effort !== "adaptive") {
							body.reasoning_effort = effort;
						} else {
							body.reasoning = { enabled: true };
						}
					}

					// Inject tools (VS Code + ask_image + ask_with_multi_image)
					const openaiToolList: any[] = [];
					const toolConfig = convertToolsToOpenAI(params.options);
					if (toolConfig.tools) {
						openaiToolList.push(...toolConfig.tools);
					}
					if (hasLocalImages) {
						openaiToolList.push(ASK_IMAGE_TOOL_DEF);
						if (((api as any)._localImages as any[])?.length >= 2) {
							openaiToolList.push(ASK_WITH_MULTI_IMAGE_TOOL_DEF);
						}
					}
					if (openaiToolList.length > 0) {
						body.tools = openaiToolList;
					}
					// Allow the model to freely call ask_image again in this round
					if (hasLocalImages) {
						body.tool_choice = "auto";
					}

					const url = `${params.baseUrl.replace(/\/+$/, "")}/chat/completions`;
					logger.info("request.send", {
						summary: `chat-completions POST ${url} (vision round ${round})`,
						url,
						round,
						vision: true,
						wire: summarizeWireRequest(body),
					});
					const response = await executeWithRetry(async () => {
						const res = await params.dispatchFetch(url, {
							method: "POST",
							headers: params.requestHeaders,
							body: JSON.stringify(body),
							signal: roundAbortController.signal,
						});
						if (!res.ok) {
							const errorText = await res.text();
							throw createApiError(res, errorText, "API error");
						}
						return res;
					}, params.retryConfig);

					if (response.body) {
						await api.processStreamingResponse(response.body, params.trackingProgress, params.token);
					}
				}
			} finally {
				clearTimeout(roundTimeoutId);
			}
		}
	}

	/**
	 * Ensure an API key exists in SecretStorage, optionally prompting the user when not silent.
	 */
	private async ensureApiKey(): Promise<string | undefined> {
		let apiKey = await this.secrets.get("kenari.apiKey");

		if (!apiKey) {
			const entered = await vscode.window.showInputBox({
				title: l10n("Kenari Provider API Key"),
				prompt: l10n("Enter your Kenari API key (starts with kn-)"),
				ignoreFocusOut: true,
				password: true,
			});
			if (entered && entered.trim()) {
				apiKey = entered.trim();
				await this.secrets.store("kenari.apiKey", apiKey);
			}
		}

		return apiKey;
	}
}
