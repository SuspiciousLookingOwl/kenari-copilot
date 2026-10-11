import * as vscode from "vscode";
import { LanguageModelChatRequestMessage, LanguageModelChatTool } from "vscode";
import { countMessageTokens, countToolTokens } from "./provideToken";
import { l10n, l10nFormat } from "./localize";
import { logger } from "./logger";
import type { StreamUsage } from "./commonApi";
import {
	formatResetDuration,
	formatRp,
	formatRpFromMicro,
	getKenariQuotaCached,
	getQuotaSnapshot,
	primaryWindow,
	windowLabel,
	windowShortLabel,
	type KenariQuotaResult,
} from "./kenariQuota";

// Cumulative token counters across the session (reset on VS Code restart)
let cumulativeInputTokens = 0;
let cumulativeOutputTokens = 0;
let cumulativeCacheHitTokens = 0;
let cumulativeCacheMissTokens = 0;

// Quota polling state (usage shown in the status bar tooltip)
let usageSecrets: vscode.SecretStorage | undefined;
let usageStatusBarItem: vscode.StatusBarItem | undefined;
let usagePollTimer: NodeJS.Timeout | undefined;
let usageRefreshInFlight = false;

/**
 * Whether the plan quota section is enabled in the status bar tooltip.
 */
function isUsageTooltipEnabled(): boolean {
	return vscode.workspace.getConfiguration("kenari").get<boolean>("showUsageInTooltip", true);
}

/**
 * Whether the extension-provided Advanced Token indicator (the status bar
 * item) is enabled. When disabled, no extension status bar element is shown;
 * the native Copilot token indicator stays visible on its own.
 */
function isThirdPartyTokenIndicatorEnabled(): boolean {
	return vscode.workspace.getConfiguration("kenari").get<boolean>("enableThirdPartyTokenIndicator", true);
}

/**
 * Quota refresh interval in milliseconds (clamped to 1-60 minutes).
 */
function getUsageRefreshIntervalMs(): number {
	const minutes = vscode.workspace.getConfiguration("kenari").get<number>("usageRefreshInterval", 5);
	return Math.min(Math.max(minutes, 1), 60) * 60 * 1000;
}

/**
 * Refresh the cached account quota (fire-and-forget). No-ops without an API
 * key or while a refresh is already in flight. On success the status bar text
 * and tooltip are re-rendered so the next glance/hover shows fresh data.
 */
async function refreshKenariQuota(): Promise<void> {
	if (usageRefreshInFlight || !usageSecrets) {
		return;
	}
	usageRefreshInFlight = true;
	try {
		const apiKey = await usageSecrets.get("kenari.apiKey");
		if (!apiKey) {
			logger.debug("quota.poll.skip", { reason: "no-api-key" });
			return;
		}
		const quota = await getKenariQuotaCached(apiKey);
		if (quota && usageStatusBarItem) {
			updateStatusBarQuotaText(usageStatusBarItem);
			updateCumulativeTooltip(usageStatusBarItem);
		}
	} finally {
		usageRefreshInFlight = false;
	}
}

function stopUsagePolling(): void {
	if (usagePollTimer) {
		clearInterval(usagePollTimer);
		usagePollTimer = undefined;
		logger.debug("quota.poll.stop", {});
	}
}

function startUsagePolling(): void {
	stopUsagePolling();
	// Polling runs while an API key exists and the Advanced Token indicator
	// is enabled (the status bar main text shows the quota);
	// showUsageInTooltip only gates the tooltip section.
	void refreshKenariQuota();
	const intervalMs = getUsageRefreshIntervalMs();
	usagePollTimer = setInterval(() => {
		void refreshKenariQuota();
	}, intervalMs);
	logger.debug("quota.poll.start", { intervalMs });
}

/**
 * Apply `kenari.enableThirdPartyTokenIndicator` to the status bar item:
 * show and poll when enabled, hide and pause polling when disabled. Called
 * on startup and whenever the setting changes at runtime.
 */
function applyThirdPartyTokenIndicatorSetting(statusBarItem: vscode.StatusBarItem): void {
	if (isThirdPartyTokenIndicatorEnabled()) {
		statusBarItem.show();
		startUsagePolling();
		updateStatusBarQuotaText(statusBarItem);
		updateCumulativeTooltip(statusBarItem);
	} else {
		stopUsagePolling();
		statusBarItem.hide();
	}
}

export function initStatusBar(context: vscode.ExtensionContext, secrets: vscode.SecretStorage): vscode.StatusBarItem {
	// Reset cumulative counters on VS Code startup
	resetCumulativeCounters();

	const tokenCountStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	tokenCountStatusBarItem.name = l10n("Kenari Quota");
	tokenCountStatusBarItem.text = "$(symbol-numeric) Kenari --";
	tokenCountStatusBarItem.tooltip = l10n("Kenari plan quota and token usage");
	// Clicking the status bar refreshes the quota immediately
	tokenCountStatusBarItem.command = "kenari.checkUsage";
	context.subscriptions.push(tokenCountStatusBarItem);

	// Quota polling for the status bar text and tooltip section
	usageSecrets = secrets;
	usageStatusBarItem = tokenCountStatusBarItem;
	applyThirdPartyTokenIndicatorSetting(tokenCountStatusBarItem);
	context.subscriptions.push({ dispose: stopUsagePolling });
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("kenari.enableThirdPartyTokenIndicator")) {
				applyThirdPartyTokenIndicatorSetting(tokenCountStatusBarItem);
			}
			if (
				e.affectsConfiguration("kenari.showUsageInTooltip") ||
				e.affectsConfiguration("kenari.usageRefreshInterval")
			) {
				if (isThirdPartyTokenIndicatorEnabled()) {
					startUsagePolling();
					updateStatusBarQuotaText(tokenCountStatusBarItem);
					updateCumulativeTooltip(tokenCountStatusBarItem);
				}
			}
		})
	);

	return tokenCountStatusBarItem;
}

/**
 * Format number to thousands (K, M, B) format.
 */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000_000) {
		return (value / 1_000_000_000).toFixed(1) + "B";
	} else if (value >= 1_000_000) {
		return (value / 1_000_000).toFixed(1) + "M";
	} else if (value >= 1_000) {
		return (value / 1_000).toFixed(1) + "K";
	}
	return value.toLocaleString();
}

/**
 * Update the status bar main text with the plan quota of the tightest rolling
 * window, e.g. "$(symbol-numeric) Kenari wk 16%", or "$(symbol-numeric) Kenari --"
 * while no quota data is available.
 */
function updateStatusBarQuotaText(statusBarItem: vscode.StatusBarItem): void {
	const primary = primaryWindow(getQuotaSnapshot());
	statusBarItem.text = primary
		? `$(symbol-numeric) Kenari ${windowShortLabel(primary.key)} ${Math.round(primary.window.usedFrac * 100)}%`
		: "$(symbol-numeric) Kenari --";
}

/**
 * Update the status bar with token usage information.
 * Resets cumulative counters when a new conversation starts
 * (no assistant messages in the history). The status bar main text shows
 * the plan quota (see updateStatusBarQuotaText); token counts live in
 * the tooltip.
 * @returns The estimated input token count (for fallback usage).
 */
export async function updateContextStatusBar(
	messages: readonly LanguageModelChatRequestMessage[],
	tools: readonly LanguageModelChatTool[] | undefined,
	statusBarItem: vscode.StatusBarItem,
	modelConfig: { includeReasoningInRequest: boolean }
): Promise<number> {
	try {
		// Detect new conversation: no assistant messages → reset cumulative counters
		const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
		const hasAssistantMessages = messages.some((m) => (m.role as unknown as number) === ASSISTANT);
		if (!hasAssistantMessages) {
			resetCumulativeCounters();
		}

		let totalTokens = 0;

		for (const message of messages) {
			totalTokens += await countMessageTokens(message, modelConfig);
		}

		if (tools && tools.length > 0) {
			totalTokens += await countToolTokens(tools);
		}

		updateStatusBarQuotaText(statusBarItem);
		// Always show cumulative tooltip (not per-request) to avoid flickering
		updateCumulativeTooltip(statusBarItem);
		return totalTokens;
	} catch {
		updateStatusBarQuotaText(statusBarItem);
		return 0;
	}
}

/**
 * Re-render the status bar after the API reports usage data
 * (status bar main text = plan quota, tooltip = cumulative token counts).
 */
export function updateStatusBarWithApiPrompt(statusBarItem: vscode.StatusBarItem): void {
	updateStatusBarQuotaText(statusBarItem);
	updateCumulativeTooltip(statusBarItem);
}

/**
 * Reset all cumulative token counters (called on VS Code startup and new conversation).
 */
function resetCumulativeCounters(): void {
	cumulativeInputTokens = 0;
	cumulativeOutputTokens = 0;
	cumulativeCacheHitTokens = 0;
	cumulativeCacheMissTokens = 0;
}

/**
 * Record streaming usage data into cumulative counters.
 */
export function recordUsage(usage: StreamUsage): void {
	cumulativeInputTokens += usage.promptTokens;
	cumulativeOutputTokens += usage.completionTokens;
	if (usage.cacheHitTokens !== undefined) {
		cumulativeCacheHitTokens += usage.cacheHitTokens;
	}
	if (usage.cacheMissTokens !== undefined) {
		cumulativeCacheMissTokens += usage.cacheMissTokens;
	}
}

/**
 * Append the Kenari plan quota section to the tooltip lines.
 * One line per quota window ("Week——16% (resets in 2H13M)"), plus the plan
 * name, the active coupon and the account balance when available.
 * Shows nothing when disabled or no data is cached.
 */
function appendQuotaTooltipLines(lines: string[]): void {
	if (!isUsageTooltipEnabled()) {
		return;
	}
	const quota = getQuotaSnapshot();
	if (!quota) {
		return;
	}
	const hasPlan = quota.planName !== undefined || Object.keys(quota.windows).length > 0;
	if (!hasPlan && quota.coupon === undefined && quota.balanceMicroIdr === undefined) {
		return;
	}

	if (quota.planName) {
		lines.push(l10nFormat("Plan: {0}", quota.planName));
	}
	for (const [key, window] of Object.entries(quota.windows)) {
		const percent = Math.round(window.usedFrac * 100);
		const reset = window.resetsAt ? formatResetDuration(window.resetsAt) : "";
		lines.push(
			reset
				? `${windowLabel(key)}——${percent}% ${l10nFormat("(resets in {0})", reset)}`
				: `${windowLabel(key)}——${percent}%`
		);
	}
	if (quota.coupon) {
		lines.push(
			quota.coupon.remainingRp !== undefined
				? l10nFormat("Coupon: {0} ({1} left)", quota.coupon.name, formatRp(quota.coupon.remainingRp))
				: l10nFormat("Coupon: {0}", quota.coupon.name)
		);
	}
	if (quota.balanceMicroIdr !== undefined) {
		lines.push(l10nFormat("Balance: {0}", formatRpFromMicro(quota.balanceMicroIdr)));
	}
}

/**
 * Update the status bar tooltip with cumulative input/output token counts,
 * cache info (if available) and the Kenari plan quota (if enabled and data is
 * cached).
 */
export function updateCumulativeTooltip(statusBarItem: vscode.StatusBarItem): void {
	const arrowUp = "\u2191";
	const arrowDown = "\u2193";
	const lines: string[] = [];

	// Line 1: cumulative input + cache info
	let inputLine = `${arrowUp} ${formatTokenCount(cumulativeInputTokens)}`;
	if (cumulativeCacheHitTokens > 0 || cumulativeCacheMissTokens > 0) {
		const totalCache = cumulativeCacheHitTokens + cumulativeCacheMissTokens;
		const cachePercent = totalCache > 0 ? Math.round((cumulativeCacheHitTokens / totalCache) * 100) : 0;
		const cacheFormatted = formatTokenCount(cumulativeCacheHitTokens);
		inputLine += ` ${l10nFormat("({0} cached, {1}%)", cacheFormatted, cachePercent)}`;
	}
	lines.push(inputLine);

	// Line 2: cumulative output
	lines.push(`${arrowDown} ${formatTokenCount(cumulativeOutputTokens)}`);

	// Section 3: Kenari plan quota (optional)
	appendQuotaTooltipLines(lines);

	statusBarItem.tooltip = lines.join("\n");
}

/**
 * Force an immediate quota refresh (used by the checkUsage command) and
 * re-render the status bar text and tooltip once fresh data arrives.
 */
export async function refreshQuotaNow(): Promise<KenariQuotaResult | null> {
	if (!usageSecrets || !usageStatusBarItem) {
		return null;
	}
	const apiKey = await usageSecrets.get("kenari.apiKey");
	if (!apiKey) {
		return null;
	}
	// Bypass the in-flight guard for an explicit user request: reuse the
	// module-level fetch but wait for its result directly.
	usageRefreshInFlight = true;
	try {
		const quota = await getKenariQuotaCached(apiKey, true);
		updateStatusBarQuotaText(usageStatusBarItem);
		updateCumulativeTooltip(usageStatusBarItem);
		return quota;
	} finally {
		usageRefreshInFlight = false;
	}
}
