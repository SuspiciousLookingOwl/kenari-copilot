/**
 * Per-model override table.
 *
 * The Kenari catalog (`GET /v1/models`) is the single source of truth for
 * model metadata. These overrides only carry fields the catalog cannot
 * express (or gets wrong) - for example a forced request protocol, a
 * different default reasoning effort, or extra request-body parameters.
 *
 * Merge semantics: for each field, the override value wins when present;
 * otherwise the value resolved from the catalog is used.
 */

import type { ApiMode } from "./types";

/**
 * Override for a single model. Every field is optional - only the fields
 * written here take effect; everything else falls through to the catalog.
 */
export interface ModelMetaOverride {
	displayName?: string;
	vision?: boolean;
	thinkingMode?: "switchable" | "always" | "adaptive";
	supportedReasoningEfforts?: string[];
	defaultReasoningEffort?: string;
	/** Full context window (input + output) in tokens. */
	contextWindow?: number;
	/** Longest output the model can produce in one response. */
	maxOutputTokens?: number;
	apiMode?: ApiMode;
	supportsTemperature?: boolean;
	toolCalling?: boolean;
	/** Override whether the model accepts an explicit off value for reasoning. */
	supportsDisablingReasoning?: boolean;
	baseUrl?: string;
	/** Fields the catalog cannot express: request-body extras. */
	extra?: Record<string, unknown>;
	/** Thinking budget in tokens, used by the Anthropic adapter when thinking is enabled. */
	thinkingBudget?: { min?: number; max?: number };
	/** Whether to include reasoning_content in assistant messages sent to the API. */
	includeReasoningInRequest?: boolean;
	cost?: { cache_read: number; input: number; output: number };
}

/**
 * Per-model overrides, keyed by model ID.
 *
 * Empty by default: the Kenari catalog already declares protocols, reasoning
 * options, vision support and limits for every model. Add entries here only
 * when a model needs behaviour the catalog cannot describe.
 */
export const MODEL_OVERRIDES: Record<string, ModelMetaOverride> = {};
