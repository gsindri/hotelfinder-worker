/**
 * Rate limiting utilities.
 * 
 * @module lib/rateLimit
 */

import { COMPARE_RATE_LIMIT, COMPARE_WINDOW_SEC, CTX_RATE_LIMIT, CTX_WINDOW_SEC } from './constants.js';
import { jsonResponse } from './http.js';

/**
 * Get client IP from request headers.
 * @param {Request} request - Incoming request
 * @returns {string}
 */
export function getClientIp(request) {
    return (
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "unknown"
    );
}

/**
 * Rate limit for /compare route.
 * Returns a Response if blocked, or null if allowed.
 * @param {Request} request - Incoming request
 * @param {Object} env - Environment bindings
 * @param {Object} corsHeaders - CORS headers to include
 * @returns {Promise<Response|null>}
 */
export async function rateLimitCompare(request, env, corsHeaders) {
    if (!env.CACHE_KV) {
        return jsonResponse({ error: "Missing CACHE_KV binding" }, 500, corsHeaders);
    }

    const ip = getClientIp(request);
    const now = Date.now();
    const hourBucket = Math.floor(now / 3600000); // changes once per hour
    const key = `rl:compare:${hourBucket}:${ip}`;

    const currentRaw = await env.CACHE_KV.get(key);
    const current = currentRaw ? parseInt(currentRaw, 10) : 0;

    if (current >= COMPARE_RATE_LIMIT) {
        const secondsIntoHour = Math.floor((now % 3600000) / 1000);
        const retryAfter = COMPARE_WINDOW_SEC - secondsIntoHour;

        return new Response(JSON.stringify({ error: "Rate limit exceeded", error_code: "RATE_LIMIT" }), {
            status: 429,
            headers: {
                "Content-Type": "application/json",
                "Retry-After": String(retryAfter),
                ...corsHeaders,
            },
        });
    }

    // Minimum defense (not perfectly atomic, but enough to stop casual abuse)
    await env.CACHE_KV.put(key, String(current + 1), {
        expirationTtl: COMPARE_WINDOW_SEC + 60,
    });

    return null;
}

/**
 * Rate limit for /prefetchCtx route.
 * Returns a Response if blocked, or null if allowed.
 * @param {Request} request - Incoming request
 * @param {Object} env - Environment bindings
 * @param {Object} corsHeaders - CORS headers to include
 * @returns {Promise<Response|null>}
 */
export async function rateLimitPrefetch(request, env, corsHeaders) {
    if (!env.CACHE_KV) {
        return jsonResponse({ error: "Missing CACHE_KV binding" }, 500, corsHeaders);
    }

    const ip = getClientIp(request);
    const now = Date.now();
    const hourBucket = Math.floor(now / 3600000);
    const key = `rl:prefetch:${hourBucket}:${ip}`;

    const currentRaw = await env.CACHE_KV.get(key);
    const current = currentRaw ? parseInt(currentRaw, 10) : 0;

    if (current >= CTX_RATE_LIMIT) {
        const secondsIntoHour = Math.floor((now % 3600000) / 1000);
        const retryAfter = CTX_WINDOW_SEC - secondsIntoHour;

        return new Response(JSON.stringify({ error: "Rate limit exceeded", error_code: "RATE_LIMIT" }), {
            status: 429,
            headers: {
                "Content-Type": "application/json",
                "Retry-After": String(retryAfter),
                ...corsHeaders,
            },
        });
    }

    await env.CACHE_KV.put(key, String(current + 1), {
        expirationTtl: CTX_WINDOW_SEC + 60,
    });

    return null;
}
