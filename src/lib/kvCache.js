/**
 * KV cache utilities.
 * 
 * @module lib/kvCache
 */

/**
 * Get JSON from KV.
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} key - Cache key
 * @returns {Promise<Object|null>}
 */
export async function kvGetJson(kv, key) {
    const raw = await kv.get(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Put JSON to KV with TTL.
 * @param {KVNamespace} kv - KV namespace binding
 * @param {string} key - Cache key
 * @param {Object} obj - Object to store
 * @param {number} ttlSec - TTL in seconds
 */
export async function kvPutJson(kv, key, obj, ttlSec) {
    await kv.put(key, JSON.stringify(obj), { expirationTtl: ttlSec });
}
