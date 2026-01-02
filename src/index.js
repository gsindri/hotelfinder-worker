// @ts-nocheck
/**
 * Hotel Direct Contact Worker - Router
 *
 * Routes:
 *  - /compare     : SearchApi hotel comparison (handled by routes/compare.js)
 *  - /prefetchCtx : Search context prefetch (handled by routes/prefetchCtx.js)
 *  - /__version   : Build info (handled by routes/version.js)
 *  - /?query=...  : Contact lookup (handled by routes/contact.js)
 *
 * REQUIRED ENV / BINDINGS:
 *  - env.GOOGLE_API_KEY (for contact lookup)
 *  - env.SEARCHAPI_KEY (for /compare and /prefetchCtx)
 *  - env.CACHE_KV (KV Namespace binding)
 *
 * OPTIONAL ENV:
 *  - env.CHROME_EXTENSION_ID or env.COMPARE_ALLOWED_ORIGINS (for /compare CORS allowlist)
 *  - env.COMPARE_ALLOW_LOCALHOST=1 (to allow localhost origins)
 */

import { buildCompareCors, buildPublicCors } from './lib/cors.js';
import { jsonResponse } from './lib/http.js';

import { handleVersion } from './routes/version.js';
import { handlePrefetchCtx } from './routes/prefetchCtx.js';
import { handleCompare } from './routes/compare.js';
import { handleContact } from './routes/contact.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const isCompare = url.pathname === '/compare';
    const isPrefetch = url.pathname === '/prefetchCtx';
    const isVersion = url.pathname === '/__version';

    // ----- Locked routes (extension-only CORS) -----
    if (isCompare || isPrefetch) {
      const compareCors = buildCompareCors(request, env);
      const corsHeaders = compareCors.corsHeaders;

      // OPTIONS preflight
      if (request.method === 'OPTIONS') {
        if (!compareCors.configured || !compareCors.allowed) {
          return new Response(null, { status: 403, headers: corsHeaders });
        }
        return new Response(null, {
          status: 204,
          headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' },
        });
      }

      // Dispatch to handlers
      if (isPrefetch) {
        return handlePrefetchCtx({ request, env, ctx, url, corsHeaders });
      }

      return handleCompare({ request, env, ctx, url, corsHeaders, compareCors });
    }

    // ----- Public routes (open CORS) -----
    const corsHeaders = buildPublicCors();

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' },
      });
    }

    // /__version
    if (isVersion) {
      return handleVersion({ corsHeaders });
    }

    // Contact lookup (default route)
    return handleContact({ request, env, ctx, url, corsHeaders });
  },
};
