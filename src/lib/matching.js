/**
 * Hotel name matching utilities.
 * Scoring, brand protection, and property selection.
 * 
 * @module lib/matching
 */

import { STRICT_BRAND_TOKENS, KEY_DISAMBIGUATORS, MIN_SCORE_FOR_DOMAIN_BOOST } from './constants.js';
import { getHostNoWww } from './normalize.js';

// Stop words for name tokenization
const NAME_STOP_WORDS = new Set([
    "hotel", "by", "the", "and", "of", "at", "in", "a", "an", "resort", "inn",
    "apartments", "apartment", "suites", "suite", "hostel", "guesthouse",
]);

/**
 * Tokenize a hotel name for matching.
 * @param {string} s - Name to tokenize
 * @returns {string[]}
 */
export function tokenizeName(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .filter((t) => t.length > 1 && !NAME_STOP_WORDS.has(t));
}

/**
 * Normalize string for includes-based matching.
 * @param {string} s - String to normalize
 * @returns {string}
 */
export function normalizeForIncludes(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Extract brand tokens from a name.
 * @param {string} name - Hotel name
 * @returns {Set<string>}
 */
export function extractStrictBrands(name) {
    const n = normalizeForIncludes(name);
    const out = new Set();
    for (const b of STRICT_BRAND_TOKENS) {
        if (new RegExp(`\\b${b}\\b`, "i").test(n)) out.add(b);
    }
    return out;
}

/**
 * Extract key disambiguator tokens from a name.
 * @param {string} name - Hotel name
 * @returns {string[]}
 */
export function extractKeyTokens(name) {
    const n = normalizeForIncludes(name);
    return KEY_DISAMBIGUATORS.filter(k => n.includes(k));
}

// Allowed extra tokens when matching city suffix (e.g., "London City Centre")
const LOCATION_QUALIFIERS = new Set([
    "city", "centre", "center", "central", "downtown", "old", "town", "historic"
]);

/**
 * Strip trailing location suffix from query if it matches candidate's city/country.
 * Only strips suffixes after comma or dash that match the candidate's location.
 * Prevents false stripping (e.g., "New York" won't match "York").
 * 
 * @param {string} query - Original query hotel name
 * @param {string} candidateCity - Candidate's city from SearchApi
 * @param {string} candidateCountry - Candidate's country from SearchApi
 * @returns {{ stripped: string, wasStripped: boolean, strippedSuffix: string }}
 */
export function stripTrailingLocationSuffix(query, candidateCity, candidateCountry) {
    const original = String(query || "").trim();
    if (!original || (!candidateCity && !candidateCountry)) {
        return { stripped: original, wasStripped: false, strippedSuffix: "" };
    }

    // Find suffix after last comma or dash
    const suffixMatch = original.match(/[,\-–—]\s*([^,\-–—]+)$/i);
    if (!suffixMatch) {
        return { stripped: original, wasStripped: false, strippedSuffix: "" };
    }

    const suffix = suffixMatch[1].trim();
    const suffixTokens = tokenizeName(suffix);
    if (suffixTokens.length === 0) {
        return { stripped: original, wasStripped: false, strippedSuffix: "" };
    }

    // Try matching against city first, then country
    for (const location of [candidateCity, candidateCountry]) {
        if (!location) continue;

        const locationTokens = new Set(tokenizeName(location));
        if (locationTokens.size === 0) continue;

        // Check if ALL suffix tokens are either:
        // 1. Part of the location tokens, OR
        // 2. In the allowed qualifiers list
        let allMatch = true;
        let hasLocationToken = false;

        for (const st of suffixTokens) {
            if (locationTokens.has(st)) {
                hasLocationToken = true;
            } else if (!LOCATION_QUALIFIERS.has(st)) {
                // Found a token that's neither in location nor in qualifiers
                allMatch = false;
                break;
            }
        }

        // Must have at least one actual location token (not just qualifiers)
        // and all tokens must be accounted for
        if (allMatch && hasLocationToken) {
            const stripped = original.slice(0, original.length - suffixMatch[0].length).trim();
            return { stripped, wasStripped: true, strippedSuffix: suffix };
        }
    }

    return { stripped: original, wasStripped: false, strippedSuffix: "" };
}

/**
 * Check if two sets have any overlap.
 * @param {Set} setA - First set
 * @param {Set} setB - Second set
 * @returns {boolean}
 */
export function hasAnyOverlap(setA, setB) {
    for (const v of setA) if (setB.has(v)) return true;
    return false;
}

/**
 * Detailed name match with hard mismatch detection.
 * @param {string} query - Query hotel name
 * @param {string} candidate - Candidate hotel name
 * @returns {Object}
 */
export function scoreNameMatchDetailed(query, candidate) {
    const qNorm = normalizeForIncludes(query);
    const cNorm = normalizeForIncludes(candidate);

    // Strict brand check
    const qBrands = extractStrictBrands(qNorm);
    const cBrands = extractStrictBrands(cNorm);
    let brandMismatch = false;
    if (qBrands.size > 0) {
        brandMismatch = !hasAnyOverlap(qBrands, cBrands);
    }
    if (!brandMismatch && cBrands.size > 0 && qBrands.size > 0) {
        brandMismatch = !hasAnyOverlap(qBrands, cBrands);
    }

    // Key disambiguator check
    const qKeys = extractKeyTokens(qNorm);
    const missingKeys = qKeys.filter(k => !cNorm.includes(k));
    const keyMismatch = missingKeys.length > 0;

    // Base token coverage
    const qTokens = tokenizeName(query);
    const cTokens = new Set(tokenizeName(candidate));
    let hit = 0;
    for (const t of qTokens) if (cTokens.has(t)) hit++;
    const coverage = qTokens.length ? hit / qTokens.length : 0;

    // Bidirectional contains boost: query contains candidate OR candidate contains query
    const qContainsC = qNorm.includes(cNorm) && cNorm.length >= 6 && tokenizeName(candidate).length >= 2;
    const cContainsQ = cNorm.includes(qNorm) && qNorm.length >= 6;
    const containsBoost = (qContainsC || cContainsQ) ? 0.25 : 0;
    const baseScore = coverage + containsBoost;

    const hardMismatch = brandMismatch || keyMismatch;

    return {
        hardMismatch,
        brandMismatch,
        keyMismatch,
        qBrands: [...qBrands],
        cBrands: [...cBrands],
        missingKeys,
        coverage,
        containsBoost,
        baseScore,
    };
}

/**
 * Simple score wrapper (returns 0 on hard mismatch).
 * @param {string} query - Query hotel name
 * @param {string} candidate - Candidate hotel name
 * @returns {number}
 */
export function scoreNameMatch(query, candidate) {
    const detailed = scoreNameMatchDetailed(query, candidate);
    if (detailed.hardMismatch) return 0;
    return detailed.baseScore;
}

/**
 * Check if two domains are equivalent.
 * @param {string} a - First domain
 * @param {string} b - Second domain
 * @returns {boolean}
 */
export function domainsEquivalent(a, b) {
    const da = String(a || "").toLowerCase().replace(/^www\./, "");
    const db = String(b || "").toLowerCase().replace(/^www\./, "");
    if (!da || !db) return false;
    return da === db || da.endsWith("." + db) || db.endsWith("." + da);
}

/**
 * Compute domain boost (gated by name score).
 * @param {boolean} domainMatch - Domain match status
 * @param {number} baseScore - Base name score
 * @returns {number}
 */
export function computeDomainBoost(domainMatch, baseScore) {
    if (!domainMatch) return 0;
    if (baseScore < MIN_SCORE_FOR_DOMAIN_BOOST) return 0;
    return Math.min(0.7, 0.9 * baseScore);
}

/**
 * Compute match confidence.
 * @param {boolean} domainMatch - Domain match status
 * @param {number} baseScore - Base name score
 * @param {boolean} hardMismatch - Hard mismatch flag
 * @returns {number}
 */
export function computeConfidence(domainMatch, baseScore, hardMismatch) {
    if (hardMismatch) return 0;
    let conf = Math.min(0.95, baseScore);
    if (domainMatch && baseScore >= 0.65) conf = Math.min(0.95, conf + 0.15);
    return Math.max(0, Math.min(0.95, conf));
}

/**
 * Pick best property from candidates.
 * @param {Object[]} properties - Candidate properties
 * @param {string} hotelName - Query hotel name
 * @param {string} officialDomain - Official domain for boost
 * @returns {Object|null}
 */
export function pickBestProperty(properties, hotelName, officialDomain) {
    if (!Array.isArray(properties) || properties.length === 0) return null;

    let best = null;
    let bestScore = -1;
    let bestNameScore = 0;
    let bestDomainMatch = false;
    let bestLinkHost = "";
    let bestMatchDetails = null;
    let bestConfidence = 0;
    let allCandidates = [];

    for (const p of properties) {
        // Location-aware scoring: strip city suffix if it matches this candidate's city
        const locationStrip = stripTrailingLocationSuffix(hotelName, p?.city, p?.country);
        const queryForScore = locationStrip.stripped;

        const matchDetails = scoreNameMatchDetailed(queryForScore, p?.name || "");

        // Add location stripping metadata to match details
        matchDetails.queryOriginal = hotelName;
        matchDetails.queryForScore = queryForScore;
        matchDetails.locationSuffixStripped = locationStrip.wasStripped;
        matchDetails.strippedSuffix = locationStrip.strippedSuffix || null;

        const linkHost = getHostNoWww(p?.link || "");
        const domainMatch = officialDomain ? domainsEquivalent(linkHost, officialDomain) : false;

        // Skip hard mismatches
        if (matchDetails.hardMismatch) {
            allCandidates.push({
                name: p?.name,
                city: p?.city,
                skipped: true,
                reason: matchDetails.brandMismatch ? "brand_mismatch" : "key_mismatch",
                details: matchDetails,
            });
            continue;
        }

        const domainBoost = computeDomainBoost(domainMatch, matchDetails.baseScore);
        const finalScore = matchDetails.baseScore + domainBoost;
        const confidence = computeConfidence(domainMatch, matchDetails.baseScore, matchDetails.hardMismatch);

        allCandidates.push({
            name: p?.name,
            city: p?.city,
            baseScore: matchDetails.baseScore,
            domainMatch,
            domainBoost,
            finalScore,
            confidence,
            locationSuffixStripped: matchDetails.locationSuffixStripped,
            details: matchDetails,
        });

        if (finalScore > bestScore) {
            bestScore = finalScore;
            best = p;
            bestNameScore = matchDetails.baseScore;
            bestDomainMatch = !!domainMatch;
            bestLinkHost = linkHost;
            bestMatchDetails = matchDetails;
            bestConfidence = confidence;
        }
    }

    return {
        best,
        bestScore,
        bestNameScore,
        bestDomainMatch,
        bestLinkHost,
        confidence: bestConfidence,
        matchDetails: bestMatchDetails,
        allCandidates,
    };
}
