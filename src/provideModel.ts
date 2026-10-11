import * as vscode from "vscode";
import { CancellationToken, LanguageModelChatInformation, PrepareLanguageModelChatModelOptions } from "vscode";

import { logger } from "./logger";
import { clearModelCatalogCache, ensureModelCatalogLoaded, isChatModel } from "./modelCatalog";
import { buildModelInfo } from "./catalogModels";
import { delay } from "./utils";

let isUpdatingModels = false;
let lastModelUpdate = 0;
let cachedDiscoveredInfos: LanguageModelChatInformation[] | null = null;

/**
 * Build the model list from the Kenari catalog.
 * Only models that serve the chat endpoints are included. Returns null when
 * no catalog data is available (the caller keeps the previous list).
 */
async function runCatalogPass(): Promise<LanguageModelChatInformation[] | null> {
	const models = await ensureModelCatalogLoaded();
	const chatModels = models.filter(isChatModel);
	if (chatModels.length === 0) {
		logger.info("models.discovery", {
			action: "fallback",
			reason: "catalog_empty_or_failed",
		});
		return null;
	}

	const infos = chatModels.map((model) => buildModelInfo(model.id));
	logger.info("models.discovery", {
		action: "catalog_loaded",
		catalogCount: models.length,
		availableCount: infos.length,
		ids: infos.map((i) => i.id).join(", "),
	});
	return infos;
}

async function waitForPendingUpdate(token: CancellationToken): Promise<void> {
	while (isUpdatingModels && !token.isCancellationRequested) {
		await delay(200, token);
	}
}

/**
 * Reset discovery state and the catalog cache (used by the forced model
 * list update command).
 */
export function resetAutoDiscoveryState(): void {
	isUpdatingModels = false;
	lastModelUpdate = 0;
	cachedDiscoveredInfos = null;
	clearModelCatalogCache();
	logger.info("models.discovery", {
		action: "reset",
	});
}

export async function prepareLanguageModelChatInformation(
	_options: PrepareLanguageModelChatModelOptions,
	_token: CancellationToken
): Promise<LanguageModelChatInformation[]> {
	if (_token.isCancellationRequested) {
		return cachedDiscoveredInfos ?? [];
	}

	const config = vscode.workspace.getConfiguration();
	const updateInterval = config.get<number>("kenari.modelListRefreshInterval", 60 * 1000);
	const now = Date.now();

	// ── Catalog Pass ──
	if (isUpdatingModels) {
		await waitForPendingUpdate(_token);
	} else if (now - lastModelUpdate >= updateInterval) {
		isUpdatingModels = true;
		try {
			if (!_token.isCancellationRequested) {
				const discovered = await runCatalogPass();
				if (discovered) {
					cachedDiscoveredInfos = discovered;
					lastModelUpdate = Date.now();
				}
			}
		} catch (error) {
			logger.error("models.discovery", {
				action: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			isUpdatingModels = false;
		}
	}

	return cachedDiscoveredInfos ? [...cachedDiscoveredInfos] : [];
}
