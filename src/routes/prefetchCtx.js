/**
 * /prefetchCtx route handler.
 * Search context prefetch for improved hotel matching.
 * 
 * @module routes/prefetchCtx
 */

import { CTX_TTL_SEC } from '../lib/constants.js';
import { jsonResponse } from '../lib/http.js';
import { kvGetJson, kvPutJson } from '../lib/kvCache.js';
import { buildCompareCors } from '../lib/cors.js';
import { rateLimitPrefetch } from '../lib/rateLimit.js';
import { isIsoDate, normalizeCurrencyParam, normalizeTravelHl } from '../lib/normalize.js';
import { searchApiCall } from '../lib/searchApi.js';
import { computeCtxId } from '../lib/offers.js';

/**
 * Handle /prefetchCtx request.
 * @param {Object} ctx - Request context
 * @returns {Promise<Response>}
 */
export async function handlePrefetchCtx({ request, env, ctx, url }) {
    // Build CORS headers (extension-only)
    const prefetchCors = buildCompareCors(request, env);
    const corsHeaders = prefetchCors.corsHeaders;

    // Handle OPTIONS preflight
    if (request.method === "OPTIONS") {
        if (!prefetchCors?.configured || !prefetchCors?.allowed) {
            return new Response(null, { status: 403, headers: corsHeaders });
        }
        return new Response(null, {
            status: 204,
            headers: { ...corsHeaders, "Access-Control-Max-Age": "86400" },
        });
    }

    // CORS check
    if (!prefetchCors?.configured) {
        return jsonResponse({ error: "Prefetch CORS not configured" }, 500, corsHeaders);
    }
    if (!prefetchCors?.allowed) {
        return jsonResponse({ error: "Origin not allowed" }, 403, corsHeaders);
    }

    // Env checks
    if (!env.SEARCHAPI_KEY) {
        return jsonResponse({ error: "Missing SEARCHAPI_KEY binding" }, 500, corsHeaders);
    }
    if (!env.CACHE_KV) {
        return jsonResponse({ error: "Missing CACHE_KV binding" }, 500, corsHeaders);
    }

    // Parse params
    const q = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
    const checkIn = url.searchParams.get("checkIn") || "";
    const checkOut = url.searchParams.get("checkOut") || "";
    const adultsRaw = parseInt(url.searchParams.get("adults") || "2", 10);
    const adults = Math.max(1, Math.min(10, adultsRaw || 2));
    const currencyRaw = url.searchParams.get("currency") || "";
    const currency = normalizeCurrencyParam(currencyRaw) || "USD";
    const gl = (url.searchParams.get("gl") || "us").toLowerCase();
    const hlRaw = url.searchParams.get("hl") || "";
    const { hlKey, hlSent } = normalizeTravelHl(hlRaw);

    // Validate required params
    const missing = [];
    if (!q) missing.push("q");
    if (!checkIn) missing.push("checkIn");
    if (!checkOut) missing.push("checkOut");
    if (missing.length) {
        return jsonResponse({ error: "Missing required params", error_code: "INVALID_PARAMS", missing }, 400, corsHeaders);
    }

    if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
        return jsonResponse({ error: "Dates must be YYYY-MM-DD", error_code: "INVALID_PARAMS", checkIn, checkOut }, 400, corsHeaders);
    }

    // Compute ctxId
    const ctxId = computeCtxId(gl, hlKey, q, checkIn, checkOut, adults, currency);
    const ctxKey = `ctx:${ctxId}`;

    // KV-hit-first: check if already cached (0 credits)
    const refresh = url.searchParams.get("refresh") === "1";
    if (!refresh) {
        const cached = await kvGetJson(env.CACHE_KV, ctxKey);
        if (cached && Array.isArray(cached.properties)) {
            return jsonResponse({
                ok: true,
                ctxId,
                count: cached.properties.length,
                cache: "hit",
            }, 200, corsHeaders);
        }
    }

    // Rate limit check (only on cache miss)
    const rateLimited = await rateLimitPrefetch(request, env, corsHeaders);
    if (rateLimited) return rateLimited;

    // Call SearchApi google_hotels
    const searchCall = await searchApiCall(env, {
        engine: "google_hotels",
        q,
        check_in_date: checkIn,
        check_out_date: checkOut,
        adults,
        currency,
        hl: hlSent,
        gl,
    });

    const { res, data } = searchCall;

    if (!res || !res.ok || data?.error) {
        return jsonResponse({
            error: "SearchApi google_hotels failed",
            error_code: "SEARCH_FAILED",
            status: res?.status ?? 0,
            details: data?.error || data || null,
            fetchError: searchCall.fetchError || null,
        }, 502, corsHeaders);
    }

    // Extract minimal property data
    const rawProperties = data?.properties || [];
    const minimalProperties = rawProperties.map(p => ({
        name: p?.name || null,
        city: p?.city || null,
        country: p?.country || null,
        property_token: p?.property_token || null,
        link: p?.link || null,
    })).filter(p => p.property_token);

    // Store in KV
    const ctxData = {
        properties: minimalProperties,
        createdAt: new Date().toISOString(),
        query: { q, checkIn, checkOut, adults, currency, gl, hl: hlSent || null },
    };
    ctx.waitUntil(kvPutJson(env.CACHE_KV, ctxKey, ctxData, CTX_TTL_SEC));

    return jsonResponse({
        ok: true,
        ctxId,
        count: minimalProperties.length,
        cache: "miss",
    }, 200, corsHeaders);
}
