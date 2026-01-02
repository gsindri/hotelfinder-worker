/**
 * HTTP utility functions for Worker.
 * Centralized response builders and fetch helpers.
 * 
 * @module lib/http
 */

/**
 * Create a JSON response with the given status and CORS headers.
 * @param {Object} obj - Response body
 * @param {number} status - HTTP status code
 * @param {Object} corsHeaders - CORS headers to include
 * @returns {Response}
 */
export function jsonResponse(obj, status, corsHeaders) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders },
    });
}

/**
 * Fetch with timeout. Returns null on abort/error.
 * @param {string} url - URL to fetch
 * @param {RequestInit} init - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response|null>}
 */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch {
        return null;
    } finally {
        clearTimeout(id);
    }
}

/**
 * Simpler fetch with timeout (for contact crawling).
 * Returns null on abort/error.
 * @param {string} url - URL to fetch
 * @param {RequestInit} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Response|null>}
 */
export async function fetchWithTimeoutSimple(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        return res;
    } catch (e) {
        clearTimeout(timeoutId);
        return null;
    }
}

/**
 * Safely parse JSON from a response.
 * @param {Response} res - Response to parse
 * @returns {Promise<Object|null>}
 */
export async function safeJson(res) {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * Check if response is HTML content.
 * @param {Response} res - Response to check
 * @returns {boolean}
 */
export function isHtmlResponse(res) {
    const ctype = res.headers.get("content-type") || "";
    return ctype.includes("text/html") || ctype.includes("application/xhtml+xml");
}

/**
 * Check if domain is in a blocklist.
 * @param {string} domainOrHost - Domain to check
 * @param {string[]} list - List of blocked domains
 * @returns {boolean}
 */
export function domainMatchesList(domainOrHost, list) {
    const d = String(domainOrHost || "").toLowerCase().replace(/^www\./, "");
    if (!d) return false;
    return list.some((junk) => d === junk || d.endsWith("." + junk));
}
