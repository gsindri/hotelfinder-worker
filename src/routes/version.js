/**
 * Version route handler.
 * Returns build info.
 * 
 * @module routes/version
 */

import { BUILD_TAG } from '../lib/constants.js';
import { jsonResponse } from '../lib/http.js';

/**
 * Handle /__version request.
 * @param {Object} ctx - Request context
 * @returns {Response}
 */
export function handleVersion({ corsHeaders }) {
    return jsonResponse({
        build: BUILD_TAG,
        ok: true,
    }, 200, corsHeaders);
}
