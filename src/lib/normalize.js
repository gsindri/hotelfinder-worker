/**
 * Normalization utilities.
 * Currency, language, date, and key normalization helpers.
 * 
 * @module lib/normalize
 */

import { SYMBOL_TO_ISO, SUPPORTED_TRAVEL_HL } from './constants.js';

/**
 * Check if string is ISO date format (YYYY-MM-DD).
 * @param {string} s - String to check
 * @returns {boolean}
 */
export function isIsoDate(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Normalize currency symbol/code to ISO 3-letter code.
 * @param {string} raw - Currency symbol or code
 * @returns {string|null}
 */
export function normalizeCurrencyParam(raw) {
    if (!raw) return null;
    const s = raw.trim().toUpperCase();

    // Valid ISO 3-letter code?
    if (/^[A-Z]{3}$/.test(s)) return s;

    // Try symbol mapping
    const mapped = SYMBOL_TO_ISO[raw.trim()];
    if (mapped) return mapped;

    return null;
}

/**
 * Calculate nights between two ISO dates.
 * @param {string} checkIn - Check-in date (YYYY-MM-DD)
 * @param {string} checkOut - Check-out date (YYYY-MM-DD)
 * @returns {number|null}
 */
export function nightsBetweenIso(checkIn, checkOut) {
    const a = Date.parse(`${checkIn}T00:00:00Z`);
    const b = Date.parse(`${checkOut}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const diff = Math.round((b - a) / (1000 * 60 * 60 * 24));
    return diff;
}

/**
 * Normalize host language code.
 * @param {string} hl - Language code
 * @returns {string}
 */
export function normalizeHl(hl) {
    const raw = String(hl || "").trim();
    if (!raw) return "";

    const s = raw.replace(/_/g, "-");

    // Plain 2-letter / 3-letter language
    if (/^[a-z]{2,3}$/i.test(s)) return s.toLowerCase();

    // language-REGION: en-US, pt-BR
    let m = s.match(/^([a-z]{2,3})-([a-z]{2})$/i);
    if (m) return `${m[1].toLowerCase()}-${m[2].toUpperCase()}`;

    // language-Script: sr-Latn
    m = s.match(/^([a-z]{2,3})-([a-z]{4})$/i);
    if (m) {
        const script = `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}`;
        return `${m[1].toLowerCase()}-${script}`;
    }

    // language-###: es-419
    m = s.match(/^([a-z]{2,3})-(\d{3})$/i);
    if (m) return `${m[1].toLowerCase()}-${m[2]}`;

    return s;
}

/**
 * Normalize hl for Google Travel API.
 * @param {string} rawHl - Raw language code
 * @returns {{ hlNormalized: string, hlSent: string|undefined, hlKey: string }}
 */
export function normalizeTravelHl(rawHl) {
    let n = normalizeHl(rawHl);

    // People often pass "en"; SearchApi's travel list uses en-US / en-GB.
    if (n === "en") n = "en-US";

    // If supported, we can send it. Otherwise, omit hl and let SearchApi default.
    const hlSent = SUPPORTED_TRAVEL_HL.has(n) ? n : undefined;

    // Key should be stable even if we omit (for caching/debugging)
    const hlKey = hlSent || (n ? `raw:${n}` : "default");

    return { hlNormalized: n, hlSent, hlKey };
}

/**
 * Normalize string for cache key usage.
 * @param {string} s - String to normalize
 * @returns {string}
 */
export function normalizeKey(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 120);
}

/**
 * Parse money string to number.
 * @param {string|number|null} val - Money value
 * @returns {number|null}
 */
export function parseMoneyToNumber(val) {
    if (val == null) return null;
    if (typeof val === "number" && Number.isFinite(val)) return val;

    const s = String(val);
    const cleaned = s.replace(/[^\d.,-]/g, "").trim();
    if (!cleaned) return null;

    let normalized = cleaned;
    if (cleaned.includes(".") && cleaned.includes(",")) normalized = cleaned.replace(/,/g, "");
    else if (!cleaned.includes(".") && cleaned.includes(",")) normalized = cleaned.replace(/,/g, "");

    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
}

/**
 * Get hostname without www prefix.
 * @param {string} s - URL string
 * @returns {string}
 */
export function getHostNoWww(s) {
    try {
        return new URL(s).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return "";
    }
}
