/**
 * Kenari model catalog.
 *
 * Fetches the public `GET https://kenari.id/v1/models` list and caches it in
 * memory for a short TTL. No API key is needed; the response carries per-model
 * limits, protocols, reasoning options, modalities, tool support and pricing.
 *
 * On failure the last good list persisted in globalState is used, so the
 * picker survives a restart without connectivity.
 */

import * as vscode from "vscode";
import { logger } from "./logger";
import { createProxyAwareFetch } from "./utils";

/** OpenAI-compatible API base URL (chat completions, responses). */
export const KENARI_BASE_URL = "https://kenari.id/v1/";
const MODELS_URL = `${KENARI_BASE_URL}models`;
const FETCH_TIMEOUT_MS = 10000;
const DEFAULT_TTL_MS = 60 * 1000;
const MIN_TTL_MS = 30000;
/** Retry a failed load no sooner than this, to avoid hammering the endpoint. */
const MIN_RETRY_MS = 60000;

/** globalState key holding the last successful catalog snapshot. */
const SNAPSHOT_KEY = "kenari.modelCatalog.snapshot.v1";

/** One model entry as returned by the Kenari /v1/models endpoint. */
export interface CatalogModel {
	id: string;
	object?: string;
	name?: string;
	owned_by?: string;
	endpoints?: string[];
	protocols?: string[];
	context_length?: number;
	max_output_tokens?: number;
	modalities?: {
		input?: string[];
		output?: string[];
	};
	reasoning?: boolean;
	reasoning_options?: string[];
	reasoning_toggle?: boolean;
	tool_call?: boolean;
	sunset_at?: number | null;
	pricing?: {
		free?: boolean;
		input?: number | null;
		output?: number | null;
		cache_read?: number | null;
	};
	[key: string]: unknown;
}

/** A parsed snapshot stored in globalState. */
interface CatalogSnapshot {
	fetchedAt: number;
	models: CatalogModel[];
}

// ── Module-level cache ──

let cachedModels: CatalogModel[] | null = null;
let cacheTimestamp = 0;
let inFlightFetch: Promise<CatalogModel[]> | null = null;
/** True when the last load failed; a failed load is retried sooner than the TTL. */
let lastLoadFailed = false;

/** Persistence backend (extension globalState), set during activation. */
let _storage: vscode.Memento | undefined;

/**
 * Restore the persisted catalog snapshot. Must be called during activation so
 * the model list is available before VS Code asks for it.
 */
export function initModelCatalog(storage: vscode.Memento): void {
	_storage = storage;
}

/**
 * Cache TTL in milliseconds from `kenari.modelListRefreshInterval`
 * (default 60000, minimum 30000).
 */
function getCacheTtlMs(): number {
	const configured = vscode.workspace
		.getConfiguration("kenari")
		.get<number>("modelListRefreshInterval", DEFAULT_TTL_MS);
	return Math.max(configured, MIN_TTL_MS);
}

/**
 * Load the snapshot persisted by a previous session, when present.
 */
function loadSnapshot(): CatalogModel[] | null {
	try {
		const snapshot = _storage?.get<CatalogSnapshot>(SNAPSHOT_KEY);
		if (!snapshot || !Array.isArray(snapshot.models) || snapshot.models.length === 0) {
			return null;
		}
		return snapshot.models;
	} catch {
		return null;
	}
}

/** Persist the model list so a later cold start can fall back to it. */
function saveSnapshot(models: CatalogModel[]): void {
	if (!_storage) {
		return;
	}
	void _storage.update(SNAPSHOT_KEY, {
		fetchedAt: Date.now(),
		models,
	} satisfies CatalogSnapshot);
}

/**
 * Fetch the model list from the Kenari API.
 * The endpoint is public; no API key is required.
 */
async function fetchCatalog(): Promise<CatalogModel[]> {
	const response = await createProxyAwareFetch(FETCH_TIMEOUT_MS)(MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Model list error: [${response.status}] ${response.statusText}`);
	}
	const body = (await response.json()) as { data?: unknown };
	if (!Array.isArray(body.data)) {
		throw new Error("Model list error: response has no data array");
	}
	return body.data.filter(
		(item): item is CatalogModel =>
			typeof item === "object" && item !== null && typeof (item as CatalogModel).id === "string"
	);
}

/**
 * Ensure the catalog is loaded, refreshing it when the cache is stale.
 * Concurrent callers share a single in-flight fetch. On failure the stale
 * cache, the persisted snapshot, or an empty list is returned in that order.
 */
export async function ensureModelCatalogLoaded(): Promise<CatalogModel[]> {
	const now = Date.now();
	// A successful load is cached for the TTL; a failed one is retried only
	// after MIN_RETRY_MS so an unreachable endpoint is not hit on every call.
	const ttl = lastLoadFailed ? Math.min(getCacheTtlMs(), MIN_RETRY_MS) : getCacheTtlMs();
	if (now - cacheTimestamp < ttl) {
		return cachedModels ?? [];
	}
	if (inFlightFetch) {
		return inFlightFetch;
	}

	inFlightFetch = (async () => {
		try {
			const models = await fetchCatalog();
			cachedModels = models;
			cacheTimestamp = Date.now();
			lastLoadFailed = false;
			saveSnapshot(models);
			logger.info("models.catalog.loaded", { count: models.length });
			return models;
		} catch (error) {
			lastLoadFailed = true;
			cacheTimestamp = Date.now();
			logger.warn("models.catalog.fetchFailed", {
				error: error instanceof Error ? error.message : String(error),
				hasStaleCache: cachedModels !== null,
			});
			// Keep the last good in-memory list when available.
			if (cachedModels !== null) {
				return cachedModels;
			}
			// Fall back to the snapshot from a previous session.
			const snapshot = loadSnapshot();
			if (snapshot) {
				cachedModels = snapshot;
				logger.info("models.catalog.snapshotUsed", { count: snapshot.length });
				return snapshot;
			}
			return [];
		} finally {
			inFlightFetch = null;
		}
	})();

	return inFlightFetch;
}

/**
 * Look up a single model entry in the loaded catalog (synchronous; returns
 * undefined until the catalog has been loaded at least once).
 */
export function getCatalogModel(modelId: string): CatalogModel | undefined {
	return cachedModels?.find((model) => model.id === modelId);
}

/**
 * Whether a model serves the chat completion endpoints this provider can call.
 */
export function isChatModel(model: CatalogModel): boolean {
	if (!Array.isArray(model.endpoints) || model.endpoints.length === 0) {
		return true; // no endpoint data, assume chat
	}
	return model.endpoints.includes("chat");
}

/**
 * Invalidate the in-memory cache so the next call refetches the list
 * (used by the forced model list update command).
 */
export function clearModelCatalogCache(): void {
	cachedModels = null;
	cacheTimestamp = 0;
	lastLoadFailed = false;
}

/**
 * Inject a fixed catalog for tests, bypassing the network. Not used at runtime.
 */
export function setModelCatalogForTesting(models: CatalogModel[]): void {
	cachedModels = models;
	cacheTimestamp = Date.now();
	lastLoadFailed = false;
}
