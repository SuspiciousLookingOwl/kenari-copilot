/**
 * Unified model resolution layer for the Kenari catalog.
 *
 * Each model is resolved in two steps: the `/v1/models` entry (with defaults
 * for missing fields), then `MODEL_OVERRIDES[modelId]` on top.
 */

import type { LanguageModelChatInformation } from "vscode";
import type { ApiMode, KenariModelItem } from "./types";
import { l10n } from "./localize";
import { MODEL_OVERRIDES, type ModelMetaOverride } from "./modelOverrides";
import { getCatalogModel, KENARI_BASE_URL, type CatalogModel } from "./modelCatalog";

const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const MIN_INPUT_BUDGET = 1024;

/**
 * Derive the input budget from the context window and the output limit.
 *
 * Follows VS Code's own convention (`contextWindow - maxOutputTokens`), the
 * same arithmetic the built-in providers use. VS Code shows "Context Size" as
 * `maxInputTokens + maxOutputTokens`, so this keeps the picker showing the real
 * window instead of the sum of both limits.
 */
function deriveMaxInputTokens(contextWindow: number, maxOutputTokens: number): number {
	return Math.max(MIN_INPUT_BUDGET, contextWindow - maxOutputTokens);
}

const MAX_REQUESTED_OUTPUT_TOKENS = 32768;

/**
 * Resolved model metadata. Every field that the catalog can supply has a
 * conservative default, so the object is always complete.
 */
export interface ModelMeta {
	displayName: string;
	vision: boolean;
	reasoning: boolean;
	/** Whether the model can be told explicitly to skip reasoning. */
	supportsDisablingReasoning: boolean;
	thinkingMode: "switchable" | "always" | "adaptive";
	supportedReasoningEfforts: string[];
	defaultReasoningEffort: string;
	/** Full context window (input + output), as declared by the catalog. */
	contextWindow: number;
	/**
	 * Input budget handed to VS Code: the context window minus the output
	 * limit (see {@link deriveMaxInputTokens}).
	 */
	maxInputTokens: number;
	/** Longest output the model can produce in one response. */
	maxOutputTokens: number;
	apiMode: ApiMode;
	supportsTemperature: boolean;
	toolCalling: boolean;
	baseUrl: string;
	/** True for `:free` models, which cost nothing to call. */
	free: boolean;
	cost: { cache_read: number; input: number; output: number };
}

/**
 * Pick the request protocol for a model.
 *
 * Kenari serves every chat model through all protocols it lists; OpenAI Chat
 * Completions is the most compatible default. Only when a model does not list
 * it do the Responses or Anthropic formats get used.
 */
function deduceApiMode(entry: CatalogModel | undefined): ApiMode {
	const protocols = Array.isArray(entry?.protocols) ? entry.protocols : [];
	if (protocols.length === 0) {
		return "openai";
	}
	if (protocols.includes("openai-chat")) {
		return "openai";
	}
	if (protocols.includes("openai-responses")) {
		return "openai-responses";
	}
	if (protocols.includes("anthropic-messages")) {
		return "anthropic";
	}
	return "openai";
}

/**
 * Pick the default reasoning effort for a model.
 *
 * Prefers "medium" (the natural middle level), otherwise the middle of the
 * declared list. Models without levels default to plain "enabled".
 */
function chooseDefaultEffort(efforts: string[]): string {
	if (efforts.length === 0) {
		return "enabled";
	}
	if (efforts.includes("medium")) {
		return "medium";
	}
	return efforts[Math.min(efforts.length - 1, Math.floor(efforts.length / 2))];
}

/**
 * Resolve model metadata from the catalog with conservative defaults.
 */
function resolveFromCatalog(modelId: string): ModelMeta {
	const entry = getCatalogModel(modelId);
	const reasoning = entry?.reasoning === true;
	// "none" is a valid but hidden effort level: it maps to the "disabled"
	// picker option instead of being listed separately.
	const supportedReasoningEfforts = (entry?.reasoning_options ?? []).filter(
		(level): level is string => typeof level === "string" && level !== "none" && level !== "disabled"
	);
	const toggle = entry?.reasoning_toggle === true;

	let thinkingMode: ModelMeta["thinkingMode"];
	if (supportedReasoningEfforts.length > 0 || toggle) {
		thinkingMode = "switchable";
	} else {
		thinkingMode = "always";
	}
	// The model can skip reasoning when it exposes an explicit off switch:
	// a per-request toggle, or a "none" effort level.
	const supportsDisablingReasoning =
		thinkingMode === "switchable" && (toggle || (entry?.reasoning_options ?? []).includes("none"));

	const inputModalities = entry?.modalities?.input ?? [];
	const pricing = entry?.pricing;
	const contextWindow = entry?.context_length ?? DEFAULT_CONTEXT_LENGTH;
	const maxOutputTokens = Math.min(entry?.max_output_tokens ?? DEFAULT_MAX_TOKENS, MAX_REQUESTED_OUTPUT_TOKENS);

	return {
		displayName: entry?.name ?? modelId,
		vision: inputModalities.includes("image"),
		reasoning,
		supportsDisablingReasoning,
		thinkingMode,
		supportedReasoningEfforts,
		defaultReasoningEffort: reasoning ? chooseDefaultEffort(supportedReasoningEfforts) : "enabled",
		contextWindow,
		maxInputTokens: deriveMaxInputTokens(contextWindow, maxOutputTokens),
		maxOutputTokens,
		apiMode: deduceApiMode(entry),
		supportsTemperature: true,
		toolCalling: entry?.tool_call ?? true,
		baseUrl: KENARI_BASE_URL,
		free: pricing?.free === true || modelId.endsWith(":free"),
		cost: {
			cache_read: pricing?.cache_read ?? 0,
			input: pricing?.input ?? 0,
			output: pricing?.output ?? 0,
		},
	};
}

/**
 * Apply per-model overrides. Override wins per field when present.
 */
function applyOverride(meta: ModelMeta, override?: ModelMetaOverride): ModelMeta {
	if (!override) return meta;
	const contextWindow = override.contextWindow ?? meta.contextWindow;
	const maxOutputTokens = Math.min(override.maxOutputTokens ?? meta.maxOutputTokens, MAX_REQUESTED_OUTPUT_TOKENS);
	return {
		displayName: override.displayName ?? meta.displayName,
		vision: override.vision ?? meta.vision,
		reasoning: meta.reasoning,
		supportsDisablingReasoning: override.supportsDisablingReasoning ?? meta.supportsDisablingReasoning,
		thinkingMode: override.thinkingMode ?? meta.thinkingMode,
		supportedReasoningEfforts: override.supportedReasoningEfforts ?? meta.supportedReasoningEfforts,
		defaultReasoningEffort: override.defaultReasoningEffort ?? meta.defaultReasoningEffort,
		contextWindow,
		// Re-derived so an override of either limit keeps the pair consistent.
		maxInputTokens: deriveMaxInputTokens(contextWindow, maxOutputTokens),
		maxOutputTokens,
		apiMode: override.apiMode ?? meta.apiMode,
		supportsTemperature: override.supportsTemperature ?? meta.supportsTemperature,
		toolCalling: override.toolCalling ?? meta.toolCalling,
		baseUrl: override.baseUrl ?? meta.baseUrl,
		free: meta.free,
		cost: override.cost ?? meta.cost,
	};
}

/**
 * Resolve the final metadata for a model through the merge chain.
 */
export function resolveModelMeta(modelId: string): ModelMeta {
	return applyOverride(resolveFromCatalog(modelId), MODEL_OVERRIDES[modelId]);
}

/**
 * Build the reasoning effort enum (values/labels/descriptions/default) for a model.
 */
function buildReasoningEnum(meta: ModelMeta): {
	enumValues: string[];
	enumItemLabels: string[];
	enumDescriptions: string[];
	defaultEffort: string;
} {
	const hasEfforts = meta.supportedReasoningEfforts.length > 0;
	// The "disabled" option is offered only when the model actually accepts an
	// explicit off switch (a per-request toggle or a "none" effort level).
	const canShowDisabled = meta.reasoning && meta.supportsDisablingReasoning && meta.thinkingMode === "switchable";
	let enumValues: string[];
	if (hasEfforts) {
		enumValues = canShowDisabled
			? ["disabled", ...meta.supportedReasoningEfforts]
			: [...meta.supportedReasoningEfforts];
	} else if (meta.thinkingMode === "switchable") {
		enumValues = ["disabled", "enabled"];
	} else {
		enumValues = ["enabled"];
	}

	// Fall back to the last enum value when the requested default is not selectable.
	const defaultEffort = enumValues.includes(meta.defaultReasoningEffort)
		? meta.defaultReasoningEffort
		: enumValues[enumValues.length - 1];

	const getLabel = (e: string): string => {
		switch (e) {
			case "disabled":
				return l10n("Disabled");
			case "adaptive":
				return l10n("Adaptive");
			case "enabled":
				return l10n("Thinking");
			case "minimal":
				return l10n("Minimal");
			case "low":
				return l10n("Low");
			case "medium":
				return l10n("Medium");
			case "high":
				return l10n("High");
			case "xhigh":
				return l10n("Extra High");
			case "max":
				return l10n("Maximum");
			default:
				return e.charAt(0).toUpperCase() + e.slice(1);
		}
	};
	const getDesc = (e: string): string => {
		switch (e) {
			case "disabled":
				return l10n("Do not enable thinking");
			case "adaptive":
				return l10n("Automatically decide when to think");
			case "enabled":
				return l10n("Enable thinking");
			case "minimal":
				return l10n("Barely any thinking, fastest response");
			case "low":
				return l10n("Reduce thinking, faster response");
			case "medium":
				return l10n("Balance thinking and speed");
			case "high":
				return l10n("Deeper thinking, slower response");
			case "xhigh":
				return l10n("Very deep thinking, slower response");
			case "max":
				return l10n("Maximum thinking depth, slowest response");
			default:
				return e;
		}
	};

	return {
		enumValues,
		enumItemLabels: enumValues.map(getLabel),
		enumDescriptions: enumValues.map(getDesc),
		defaultEffort,
	};
}

/**
 * Resolve the vision proxy model ID used by the ask_image tool.
 * The configured value is a Kenari model ID and is returned unchanged.
 */
export function resolveVisionProxyModelId(configuredId: string): string {
	return configuredId.trim();
}

/**
 * Build a LanguageModelChatInformation entry (model picker) for a model.
 */
export function buildModelInfo(modelId: string): LanguageModelChatInformation {
	const meta = resolveModelMeta(modelId);
	const detail = meta.free ? "Kenari \u00b7 Free" : "Kenari";

	// Only models that actually reason get the reasoning effort selector.
	let configurationSchema: LanguageModelChatInformation["configurationSchema"];
	if (meta.reasoning) {
		const { enumValues, enumItemLabels, enumDescriptions, defaultEffort } = buildReasoningEnum(meta);
		configurationSchema = {
			properties: {
				reasoningEffort: {
					type: "string",
					title: l10n("Reasoning Effort"),
					enum: enumValues,
					enumItemLabels: enumItemLabels,
					enumDescriptions: enumDescriptions,
					default: defaultEffort,
					group: "navigation",
				},
			},
		};
	}

	const info: LanguageModelChatInformation = {
		id: modelId,
		name: meta.displayName,
		detail,
		tooltip: "Kenari",
		family: "Kenari",
		version: "1.0.0",
		maxInputTokens: meta.maxInputTokens,
		maxOutputTokens: meta.maxOutputTokens,
		isUserSelectable: true,
		capabilities: {
			toolCalling: meta.toolCalling,
			// Always declare imageInput=true so VS Code passes image data through.
			// Non-vision models handle images via the ask_image tool proxy internally.
			imageInput: true,
		},
		...(configurationSchema ? { configurationSchema } : {}),
	};

	return info;
}

/**
 * Build the KenariModelItem request config for a model.
 */
export function getModelConfig(modelId: string): KenariModelItem {
	const meta = resolveModelMeta(modelId);
	const entry = getCatalogModel(modelId);
	const override = MODEL_OVERRIDES[modelId];

	const config: KenariModelItem = {
		id: modelId,
		owned_by: entry?.owned_by ?? "kenari",
		displayName: meta.displayName,
		baseUrl: meta.baseUrl,
		vision: meta.vision,
		supportsTemperature: meta.supportsTemperature,
		context_length: meta.contextWindow,
		max_completion_tokens: Math.min(meta.maxOutputTokens, MAX_REQUESTED_OUTPUT_TOKENS),
		apiMode: meta.apiMode,
		supportsReasoning: meta.reasoning,
		supportsDisablingReasoning: meta.supportsDisablingReasoning,
		include_reasoning_in_request: override?.includeReasoningInRequest ?? true,
		thinkingMode: meta.thinkingMode,
		cost: meta.cost,
	};

	// Only send an explicit effort when it is a real effort value
	// ("enabled"/"adaptive" are handled via the on/off flags instead).
	if (meta.reasoning && meta.defaultReasoningEffort !== "enabled" && meta.defaultReasoningEffort !== "adaptive") {
		config.reasoning_effort = meta.defaultReasoningEffort;
	}
	if (override?.thinkingBudget?.max !== undefined) {
		config.thinking_budget = override.thinkingBudget.max;
	}
	if (override?.extra) {
		config.extra = { ...override.extra };
	}

	return config;
}
