/**
 * Fallback search providers (Brave, Google CSE).
 * Used when Places API doesn't return a website.
 * 
 * @module lib/fallbackSearch
 */

import {
    BRAVE_SEARCH_ENDPOINT,
    GOOGLE_CSE_ENDPOINT,
    FALLBACK_SEARCH_TIMEOUT_MS,
    FALLBACK_SEARCH_MAX_RESULTS,
    FALLBACK_SEARCH_CACHE_TTL_SEC
} from './constants.js';
import { fetchWithTimeoutSimple, safeJson } from './http.js';
import { normalizeKey } from './normalize.js';
import { kvGetJson, kvPutJson } from './kvCache.js';

/**
 * Clean and validate a search result URL.
 * @param {string} urlStr - URL to clean
 * @returns {string|null}
 */
export function cleanSearchResultUrl(urlStr) {
    const raw = String(urlStr || "").trim();
    if (!raw) return null;
    try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        u.hash = "";
        return u.toString();
    } catch {
        try {
            const u = new URL("https://" + raw);
            if (u.protocol !== "http:" && u.protocol !== "https:") return null;
            u.hash = "";
            return u.toString();
        } catch {
            return null;
        }
    }
}

/**
 * Dedupe URL list.
 * @param {string[]} urls - URLs to dedupe
 * @returns {string[]}
 */
export function dedupeUrls(urls) {
    const out = [];
    const seen = new Set();
    for (const u of Array.isArray(urls) ? urls : []) {
        const cleaned = cleanSearchResultUrl(u);
        if (!cleaned) continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cleaned);
    }
    return out;
}

/**
 * Get Brave API key from env.
 * @param {Object} env - Environment bindings
 * @returns {string}
 */
export function getBraveApiKey(env) {
    return env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY || env.BRAVE_KEY || "";
}

/**
 * Get Google CSE API key from env.
 * @param {Object} env - Environment bindings
 * @returns {string}
 */
export function getGoogleCseKey(env) {
    return env.GOOGLE_CSE_API_KEY || env.GOOGLE_CSE_KEY || "";
}

/**
 * Get Google CSE CX (engine ID) from env.
 * @param {Object} env - Environment bindings
 * @returns {string}
 */
export function getGoogleCseCx(env) {
    return env.GOOGLE_CSE_CX || env.GOOGLE_CSE_ID || env.GOOGLE_CSE_ENGINE_ID || "";
}

/**
 * Search Brave for URLs.
 * @param {Object} env - Environment bindings
 * @param {string} q - Search query
 * @param {number} count - Result count
 * @returns {Promise<Object>}
 */
export async function braveSearchUrlsDetailed(env, q, count) {
    const key = getBraveApiKey(env);
    if (!key) return { provider: null, urls: [] };

    const u = new URL(BRAVE_SEARCH_ENDPOINT);
    u.searchParams.set("q", q);
    u.searchParams.set("count", String(Math.min(20, Math.max(1, count || FALLBACK_SEARCH_MAX_RESULTS))));

    const res = await fetchWithTimeoutSimple(
        u.toString(),
        {
            headers: {
                "Accept": "application/json",
                "X-Subscription-Token": key
            }
        },
        FALLBACK_SEARCH_TIMEOUT_MS
    );

    if (!res?.ok) return { provider: "brave", urls: [] };

    const data = await safeJson(res);
    const results = data?.web?.results;
    const urls = [];
    if (Array.isArray(results)) {
        for (const r of results) {
            const link = r?.url || r?.link || r?.profile?.url;
            if (typeof link === "string") urls.push(link);
        }
    }
    return { provider: "brave", urls: dedupeUrls(urls) };
}

/**
 * Search Google CSE for URLs.
 * @param {Object} env - Environment bindings
 * @param {string} q - Search query
 * @param {number} count - Result count
 * @returns {Promise<Object>}
 */
export async function googleCseUrlsDetailed(env, q, count) {
    const key = getGoogleCseKey(env);
    const cx = getGoogleCseCx(env);
    if (!key || !cx) return { provider: null, urls: [] };

    const u = new URL(GOOGLE_CSE_ENDPOINT);
    u.searchParams.set("key", key);
    u.searchParams.set("cx", cx);
    u.searchParams.set("q", q);
    u.searchParams.set("num", String(Math.min(10, Math.max(1, count || FALLBACK_SEARCH_MAX_RESULTS))));

    const res = await fetchWithTimeoutSimple(
        u.toString(),
        { headers: { "Accept": "application/json" } },
        FALLBACK_SEARCH_TIMEOUT_MS
    );

    if (!res?.ok) return { provider: "google_cse", urls: [] };

    const data = await safeJson(res);
    const items = data?.items;
    const urls = [];
    if (Array.isArray(items)) {
        for (const it of items) {
            if (typeof it?.link === "string") urls.push(it.link);
        }
    }
    return { provider: "google_cse", urls: dedupeUrls(urls) };
}

/**
 * Get preferred fallback provider.
 * @param {Object} env - Environment bindings
 * @returns {string}
 */
export function preferredFallbackProvider(env) {
    const p = String(env.SEARCH_FALLBACK_PROVIDER || "").toLowerCase().trim();
    if (p === "google" || p === "cse" || p === "google_cse") return "google";
    if (p === "brave") return "brave";
    return "brave";
}

/**
 * Fallback search with caching.
 * @param {Object} env - Environment bindings
 * @param {Object} ctx - Request context
 * @param {string} q - Search query
 * @param {Object} options - Search options
 * @returns {Promise<Object>}
 */
export async function fallbackSearchUrls(env, ctx, q, {
    count = FALLBACK_SEARCH_MAX_RESULTS,
    cacheKeyPrefix = "sf",
    cacheTtlSec = FALLBACK_SEARCH_CACHE_TTL_SEC
} = {}) {
    const cacheKey = `${cacheKeyPrefix}:${normalizeKey(q)}`;

    if (env.CACHE_KV) {
        const cached = await kvGetJson(env.CACHE_KV, cacheKey);
        if (cached?.urls && Array.isArray(cached.urls) && cached.urls.length) {
            return { provider: cached.provider || null, urls: cached.urls, cache: "hit" };
        }
    }

    const prefer = preferredFallbackProvider(env);
    let out = { provider: null, urls: [] };

    if (prefer === "google") {
        out = await googleCseUrlsDetailed(env, q, count);
        if (!out.urls.length) out = await braveSearchUrlsDetailed(env, q, count);
    } else {
        out = await braveSearchUrlsDetailed(env, q, count);
        if (!out.urls.length) out = await googleCseUrlsDetailed(env, q, count);
    }

    if (env.CACHE_KV && out.urls.length) {
        ctx.waitUntil(kvPutJson(env.CACHE_KV, cacheKey, { provider: out.provider, urls: out.urls }, cacheTtlSec));
    }

    return { ...out, cache: "miss" };
}
