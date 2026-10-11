/**
 * Kenari account quota fetcher.
 *
 * Reads plan quota and balance from two account endpoints:
 *
 *   - `GET /v1/account/quota`: active plan, rolling quota windows, coupon.
 *     A window with no ceiling is omitted, so the object may be empty.
 *   - `GET /v1/account/balance`: available balance in micro-Rupiah.
 *
 * Both need an unrestricted key of your own account; shared and restricted
 * keys are refused with 403, and an invalid key gets 401. Reads are free but
 * share a 60 requests/minute limit, so results are cached for 5 minutes and
 * stale data is kept on failure.
 */

import { logger } from "./logger";
import { KENARI_BASE_URL } from "./modelCatalog";
import { createProxyAwareFetch } from "./utils";

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

// Outcome of the most recent quota fetch
export type UsageFetchStatus = "ok" | "unauthorized" | "forbidden" | "error";

// One quota window (five_hour / week / month)
export interface QuotaWindow {
	usedFrac: number;
	budgetRp: number;
	usedRp: number;
	remainingRp: number;
	resetsAt?: string;
}

// Active coupon reported alongside the plan
export interface KenariCoupon {
	name: string;
	usedRp: number;
	remainingRp?: number;
	expiresAt?: string;
}

// Kenari account snapshot (plan quota + optional balance)
export interface KenariQuotaResult {
	planName?: string;
	windows: Record<string, QuotaWindow>;
	coupon?: KenariCoupon;
	alertPct?: number;
	balanceMicroIdr?: number;
}

// Module-level cache
let cachedQuota: KenariQuotaResult | null = null;
let cacheTimestamp = 0;
let lastFetchStatus: UsageFetchStatus = "error";

/** HTTP error carrying the response status for diagnostics. */
interface StatusError extends Error {
	status?: number;
}

/**
 * GET a Kenari account endpoint with the given API key.
 * Throws a StatusError on non-OK responses.
 */
async function getJson(apiKey: string, endpoint: string): Promise<Record<string, unknown>> {
	const url = `${KENARI_BASE_URL.replace(/\/+$/, "")}/${endpoint}`;
	const doFetch = createProxyAwareFetch(FETCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await doFetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
		}
		throw err;
	}
	if (!response.ok) {
		const error = new Error(`Kenari account error: [${response.status}] ${response.statusText}`) as StatusError;
		error.status = response.status;
		throw error;
	}
	return (await response.json()) as Record<string, unknown>;
}

/**
 * Parse a single quota window leniently.
 * Accepts snake_case and camelCase field name variants.
 */
function parseWindow(raw: unknown): QuotaWindow | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const pickNumber = (...keys: string[]): number | undefined => {
		for (const key of keys) {
			const value = obj[key];
			const num = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
			if (Number.isFinite(num)) {
				return num;
			}
		}
		return undefined;
	};

	const usedFrac = pickNumber("used_frac", "usedFrac");
	if (usedFrac === undefined) {
		return undefined;
	}

	let resetsAt: string | undefined;
	const resetsAtRaw = obj.resets_at ?? obj.resetsAt;
	if (typeof resetsAtRaw === "string") {
		const ts = Date.parse(resetsAtRaw);
		if (!Number.isNaN(ts)) {
			resetsAt = new Date(ts).toISOString();
		}
	}

	return {
		usedFrac: Math.min(Math.max(usedFrac, 0), 1),
		budgetRp: pickNumber("budget_rp", "budgetRp") ?? 0,
		usedRp: pickNumber("used_rp", "usedRp") ?? 0,
		remainingRp: pickNumber("remaining_rp", "remainingRp") ?? 0,
		resetsAt,
	};
}

/**
 * Fetch the account quota and balance.
 * The quota response defines the snapshot; a failing balance request only
 * leaves the balance unset.
 */
async function fetchQuota(apiKey: string): Promise<KenariQuotaResult> {
	const [quotaBody, balance] = await Promise.all([
		getJson(apiKey, "account/quota"),
		getJson(apiKey, "account/balance").catch(() => undefined),
	]);

	const result: KenariQuotaResult = { windows: {} };

	const plan = quotaBody.plan;
	if (typeof plan === "object" && plan !== null) {
		const planObj = plan as Record<string, unknown>;
		if (typeof planObj.name === "string") {
			result.planName = planObj.name;
		}
		const windows = planObj.windows;
		if (typeof windows === "object" && windows !== null) {
			for (const [key, rawWindow] of Object.entries(windows as Record<string, unknown>)) {
				const window = parseWindow(rawWindow);
				if (window) {
					result.windows[key] = window;
				}
			}
		}
	}

	const coupon = quotaBody.coupon;
	if (typeof coupon === "object" && coupon !== null) {
		const couponObj = coupon as Record<string, unknown>;
		const name = typeof couponObj.name === "string" ? couponObj.name : undefined;
		if (name) {
			const usedRp = Number.parseFloat(String(couponObj.used_rp ?? "0"));
			const remainingRaw = couponObj.remaining_rp;
			const remainingRp = typeof remainingRaw === "number" ? remainingRaw : undefined;
			result.coupon = {
				name,
				usedRp: Number.isFinite(usedRp) ? usedRp : 0,
				remainingRp,
				expiresAt: typeof couponObj.expires_at === "string" ? couponObj.expires_at : undefined,
			};
		}
	}

	const alertPct = Number.parseFloat(String(quotaBody.alert_pct ?? ""));
	if (Number.isFinite(alertPct)) {
		result.alertPct = alertPct;
	}

	if (balance) {
		const raw = balance.available_micro_idr ?? balance.availableMicroIdr;
		const micro = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
		if (Number.isFinite(micro)) {
			result.balanceMicroIdr = micro;
		}
	}

	return result;
}

/**
 * Get the Kenari account quota, refreshing the cache when it is stale.
 *
 * @param apiKey - The API key (optional; skips fetching when absent).
 * @param force - When true, always re-fetch even if the cache is fresh
 *                (used by explicit user refresh).
 * @returns The quota snapshot, or the stale cache / null on failure (silent degradation).
 */
export async function getKenariQuotaCached(
	apiKey: string | undefined,
	force?: boolean
): Promise<KenariQuotaResult | null> {
	const now = Date.now();

	if (!force && cachedQuota !== null && now - cacheTimestamp < CACHE_TTL_MS) {
		return cachedQuota;
	}

	if (!apiKey) {
		return cachedQuota;
	}

	try {
		const quota = await fetchQuota(apiKey);
		cachedQuota = quota;
		cacheTimestamp = now;
		lastFetchStatus = "ok";
		logger.info("quota.fetch.ok", {
			plan: quota.planName,
			windows: Object.keys(quota.windows).join(", "),
			balance: quota.balanceMicroIdr,
		});
		return quota;
	} catch (err) {
		const status = err instanceof Error ? (err as StatusError).status : undefined;
		lastFetchStatus = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "error";
		const detail: { status: UsageFetchStatus; error: string; cause?: string } = {
			status: lastFetchStatus,
			error: err instanceof Error ? err.message : String(err),
		};
		// Surface the underlying network error (e.g. ECONNREFUSED from a
		// mis-routed proxy) - a bare "fetch failed" hides the real cause.
		const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
		if (cause !== undefined) {
			detail.cause = cause instanceof Error ? cause.message : String(cause);
		}
		logger.warn("quota.fetch.failed", detail);
		return cachedQuota;
	}
}

/**
 * Synchronous snapshot of the cached quota (for status bar tooltip rendering).
 */
export function getQuotaSnapshot(): KenariQuotaResult | null {
	return cachedQuota;
}

/**
 * Status of the most recent quota fetch attempt.
 */
export function getUsageFetchStatus(): UsageFetchStatus {
	return lastFetchStatus;
}

/**
 * Clear the cached quota (for testing / re-init).
 */
export function clearQuotaCache(): void {
	cachedQuota = null;
	cacheTimestamp = 0;
	lastFetchStatus = "error";
}

/** Display label for a quota window key. */
export function windowLabel(key: string): string {
	switch (key) {
		case "five_hour":
			return "5H";
		case "week":
			return "Week";
		case "month":
			return "Month";
		default:
			return key;
	}
}

/** Compact display label for a quota window key. */
export function windowShortLabel(key: string): string {
	switch (key) {
		case "five_hour":
			return "5h";
		case "week":
			return "wk";
		case "month":
			return "mo";
		default:
			return key;
	}
}

/**
 * The window shown in the status bar main text: the tightest rolling window
 * with a ceiling (week before month before five_hour), or undefined when the
 * account has no quota windows.
 */
export function primaryWindow(quota: KenariQuotaResult | null): { key: string; window: QuotaWindow } | undefined {
	if (!quota) {
		return undefined;
	}
	for (const key of ["week", "month", "five_hour"]) {
		const window = quota.windows[key];
		if (window) {
			return { key, window };
		}
	}
	const first = Object.entries(quota.windows)[0];
	return first ? { key: first[0], window: first[1] } : undefined;
}

/**
 * Format an ISO reset time as a compact countdown, e.g. "2H13M", "45M".
 */
export function formatResetDuration(iso: string): string {
	const diffMs = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(diffMs)) {
		return "";
	}
	const totalMinutes = Math.max(0, Math.ceil(diffMs / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}D${remHours}H`;
	}
	if (hours > 0) {
		return `${hours}H${minutes}M`;
	}
	return `${Math.max(minutes, 1)}M`;
}

/**
 * Format a whole-Rupiah amount, e.g. "Rp 12,400".
 */
export function formatRp(rupiah: number): string {
	return `Rp ${Math.round(rupiah).toLocaleString("en-US")}`;
}

/**
 * Format a micro-Rupiah amount as whole Rupiah, e.g. "Rp 12,400".
 */
export function formatRpFromMicro(microIdr: number): string {
	return formatRp(microIdr / 1_000_000);
}

/**
 * Build a one-line summary of the quota, e.g.
 * "Indie · Week 16% · Month 4% · Balance Rp 12,400".
 */
export function formatUsageSummary(quota: KenariQuotaResult): string {
	const parts: string[] = [];
	if (quota.planName) {
		parts.push(quota.planName);
	}
	for (const [key, window] of Object.entries(quota.windows)) {
		parts.push(`${windowLabel(key)} ${Math.round(window.usedFrac * 100)}%`);
	}
	if (quota.coupon) {
		const remaining = quota.coupon.remainingRp !== undefined ? ` (${formatRp(quota.coupon.remainingRp)} left)` : "";
		parts.push(`Coupon ${quota.coupon.name}${remaining}`);
	}
	if (quota.balanceMicroIdr !== undefined) {
		parts.push(`Balance ${formatRpFromMicro(quota.balanceMicroIdr)}`);
	}
	return parts.length > 0 ? parts.join(" \u00b7 ") : "No plan quota on this account.";
}
