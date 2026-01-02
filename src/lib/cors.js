/**
 * CORS handling for locked routes.
 * Extension-only access for /compare and /prefetchCtx.
 * 
 * @module lib/cors
 */

/**
 * Normalize an origin string.
 * @param {string} origin - Origin to normalize
 * @returns {string}
 */
export function normalizeOrigin(origin) {
    return String(origin || "")
        .trim()
        .replace(/\/+$/g, ""); // strip trailing slashes
}

/**
 * Parse comma-separated origin list.
 * @param {string} raw - CSV origins string
 * @returns {string[]}
 */
export function parseAllowedOriginsCsv(raw) {
    return String(raw || "")
        .split(",")
        .map((s) => normalizeOrigin(s))
        .filter(Boolean);
}

/**
 * Get allowed origins from environment.
 * @param {Object} env - Environment bindings
 * @returns {Set<string>}
 */
export function getCompareAllowedOrigins(env) {
    const allowed = new Set();

    // Comma-separated list of origins
    for (const o of parseAllowedOriginsCsv(env.COMPARE_ALLOWED_ORIGINS || env.ALLOWED_COMPARE_ORIGINS || "")) {
        allowed.add(o);
    }

    // Convenience: set your Chrome extension ID and we build the origin
    const extId = String(env.CHROME_EXTENSION_ID || env.EXTENSION_ID || "").trim();
    if (extId) allowed.add(`chrome-extension://${extId}`);

    // Optional: allow local dev if you want (set COMPARE_ALLOW_LOCALHOST=1)
    if (String(env.COMPARE_ALLOW_LOCALHOST || "").trim() === "1") {
        allowed.add("http://localhost:3000");
        allowed.add("http://localhost:5173");
        allowed.add("http://127.0.0.1:3000");
        allowed.add("http://127.0.0.1:5173");
    }

    return allowed;
}

/**
 * Build CORS headers for /compare route.
 * Returns { configured, allowed, origin, corsHeaders }.
 * @param {Request} request - Incoming request
 * @param {Object} env - Environment bindings
 * @returns {Object}
 */
export function buildCompareCors(request, env) {
    const origin = normalizeOrigin(request.headers.get("Origin") || "");
    const allowedOrigins = getCompareAllowedOrigins(env);
    const configured = allowedOrigins.size > 0;

    /** @type {Record<string, string>} */
    const base = {
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Expose-Headers": "Retry-After",
        "Vary": "Origin",
    };

    // If Origin is missing (curl/server-to-server), allow. CORS is a browser concern.
    if (configured && !origin) {
        return {
            configured: true,
            allowed: true,
            origin: null,
            corsHeaders: base,
        };
    }

    if (configured && origin && allowedOrigins.has(origin)) {
        return {
            configured: true,
            allowed: true,
            origin,
            corsHeaders: {
                ...base,
                "Access-Control-Allow-Origin": origin,
            },
        };
    }

    // Not allowed (or not configured) -> omit Allow-Origin
    return {
        configured,
        allowed: false,
        origin: origin || null,
        corsHeaders: base,
    };
}

/**
 * Build public CORS headers (for contact lookup route).
 * @returns {Object}
 */
export function buildPublicCors() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };
}
