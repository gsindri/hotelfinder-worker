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

    const containsBoost = cNorm.includes(qNorm) && qNorm.length >= 6 ? 0.25 : 0;
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
        const matchDetails = scoreNameMatchDetailed(hotelName, p?.name || "");
        const linkHost = getHostNoWww(p?.link || "");
        const domainMatch = officialDomain ? domainsEquivalent(linkHost, officialDomain) : false;

        // Skip hard mismatches
        if (matchDetails.hardMismatch) {
            allCandidates.push({
                name: p?.name,
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
            baseScore: matchDetails.baseScore,
            domainMatch,
            domainBoost,
            finalScore,
            confidence,
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
