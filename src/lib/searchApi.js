/**
 * SearchApi wrapper for Google Hotels calls.
 * 
 * @module lib/searchApi
 */

import { SEARCHAPI_ENDPOINT, SEARCHAPI_TIMEOUT_MS } from './constants.js';
import { fetchWithTimeout, safeJson } from './http.js';

/**
 * Extract error text from SearchApi response.
 * @param {Object|string} data - Response data
 * @returns {string}
 */
export function searchApiErrorText(data) {
    if (!data) return "";
    if (typeof data === "string") return data;
    if (typeof data?.error === "string") return data.error;
    if (typeof data?.message === "string") return data.message;
    try { return JSON.stringify(data); } catch { return String(data); }
}

/**
 * Check if error is HL parameter related.
 * @param {Object} data - Response data
 * @returns {boolean}
 */
export function isHlParamError(data) {
    const msg = searchApiErrorText(data).toLowerCase();
    return msg.includes("hl") && (msg.includes("unsupported") || msg.includes("invalid") || msg.includes("parameter"));
}

/**
 * Call SearchApi with automatic HL fallback.
 * @param {Object} env - Environment bindings
 * @param {Object} params - API parameters
 * @returns {Promise<Object>}
 */
export async function searchApiCall(env, params) {
    const doCall = async (p) => {
        const u = new URL(SEARCHAPI_ENDPOINT);
        for (const [k, v] of Object.entries(p)) {
            if (v === undefined || v === null || v === "") continue;
            u.searchParams.set(k, String(v));
        }

        const res = await fetchWithTimeout(
            u.toString(),
            {
                headers: {
                    "Authorization": `Bearer ${env.SEARCHAPI_KEY}`,
                    "Accept": "application/json",
                },
            },
            SEARCHAPI_TIMEOUT_MS
        );

        if (!res) {
            return { res: null, data: null, requestUrl: u.toString(), fetchError: "timeout_or_network_error" };
        }

        const data = await safeJson(res);
        return { res, data, requestUrl: u.toString(), fetchError: null };
    };

    // 1) Normal attempt
    let out = await doCall(params);

    // 2) If SearchApi rejects hl, retry once without hl
    if (out?.res?.status === 400 && params?.hl && isHlParamError(out.data)) {
        const p2 = { ...params };
        delete p2.hl;
        const retry = await doCall(p2);
        return { ...retry, hlFallback: true, firstError: out.data, firstFetchError: out.fetchError || null };
    }

    return { ...out, hlFallback: false };
}
