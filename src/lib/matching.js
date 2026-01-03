/**
 * Hotel name matching utilities.
 * Scoring, brand protection, and property selection.
 * 
 * @module lib/matching
 */

import {
    STRICT_BRAND_RULES,
    KEY_GROUP_RULES,
    KEY_GROUP_BOOST_STRONG,
    KEY_GROUP_BOOST_WEAK,
    KEY_GROUP_BOOST_CAP,
    MIN_SCORE_FOR_DOMAIN_BOOST,
} from './constants.js';
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

// ---------- Phrase-aware brand matching ----------

/**
 * Escape special regex characters.
 * @param {string} s - String to escape
 * @returns {string}
 */
function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert pattern string to word-boundary regex.
 * Supports multi-word patterns with flexible whitespace.
 * @param {string} pattern - Pattern like "best western"
 * @returns {RegExp}
 */
function patternToRegex(pattern) {
    // "best western" -> /\bbest\s+western\b/i
    const words = normalizeForIncludes(pattern).split(/\s+/).filter(Boolean);
    const body = words.map(escapeRegExp).join("\\s+");
    return new RegExp(`\\b${body}\\b`, "i");
}

// Precompile brand regexes once at module load
const STRICT_BRAND_MATCHERS = STRICT_BRAND_RULES.map(rule => ({
    id: rule.id,
    res: (rule.patterns || []).map(patternToRegex),
}));

/**
 * Extract brand IDs from a name using phrase-aware matching.
 * Returns brand IDs (not tokens) for accurate multi-word brand detection.
 * @param {string} name - Hotel name
 * @returns {Set<string>} Set of matched brand IDs
 */
export function extractStrictBrands(name) {
    const n = normalizeForIncludes(name);
    const out = new Set();

    for (const rule of STRICT_BRAND_MATCHERS) {
        for (const re of rule.res) {
            if (re.test(n)) {
                out.add(rule.id);
                break; // Only need one pattern match per brand
            }
        }
    }
    return out;
}

// ---------- Synonym-aware key group matching ----------

// Precompile key group matchers once at module load
const KEY_GROUP_MATCHERS = KEY_GROUP_RULES.map(g => ({
    id: g.id,
    strong: (g.strong || []).map(patternToRegex),
    weak: (g.weak || []).map(patternToRegex),
}));

/**
 * Extract key group signals from a name using phrase-aware matching.
 * Returns strong and weak signal sets for conflict detection and boosting.
 * @param {string} name - Hotel name
 * @returns {{ strong: Set<string>, weak: Set<string>, matched: Object }}
 */
export function extractKeySignals(name) {
    const n = normalizeForIncludes(name);
    const strong = new Set();
    const weak = new Set();
    const matched = {}; // id -> "strong" | "weak"

    for (const g of KEY_GROUP_MATCHERS) {
        const isStrong = g.strong.some(re => re.test(n));
        if (isStrong) {
            strong.add(g.id);
            matched[g.id] = "strong";
            continue;
        }
        const isWeak = g.weak.some(re => re.test(n));
        if (isWeak) {
            weak.add(g.id);
            matched[g.id] = "weak";
        }
    }
    return { strong, weak, matched };
}

// Set helpers for key group logic
function unionSets(a, b) {
    const out = new Set(a);
    for (const v of b) out.add(v);
    return out;
}

function intersectSets(a, b) {
    const out = new Set();
    for (const v of a) if (b.has(v)) out.add(v);
    return out;
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

    // Key group extraction (synonym-aware)
    const qKey = extractKeySignals(qNorm);
    const cKey = extractKeySignals(cNorm);

    // Conflict uses STRONG patterns only (prevents ambiguous words from causing hard reject)
    const overlapStrong = intersectSets(qKey.strong, cKey.strong);
    const keyConflict =
        qKey.strong.size > 0 &&
        cKey.strong.size > 0 &&
        overlapStrong.size === 0;

    // Overlap boost uses STRONG+WEAK union (helps "downtown" vs "central/centre")
    const qAny = unionSets(qKey.strong, qKey.weak);
    const cAny = unionSets(cKey.strong, cKey.weak);
    const overlapAny = intersectSets(qAny, cAny);

    let keyGroupBoost = 0;
    for (const gid of overlapAny) {
        const bothStrong = qKey.strong.has(gid) && cKey.strong.has(gid);
        keyGroupBoost += bothStrong ? KEY_GROUP_BOOST_STRONG : KEY_GROUP_BOOST_WEAK;
    }
    keyGroupBoost = Math.min(KEY_GROUP_BOOST_CAP, keyGroupBoost);

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

    const baseScore = coverage + containsBoost + keyGroupBoost;
    const hardMismatch = brandMismatch || keyConflict;

    return {
        hardMismatch,
        brandMismatch,
        keyConflict,
        qBrands: [...qBrands],
        cBrands: [...cBrands],
        qKeyStrong: [...qKey.strong],
        qKeyWeak: [...qKey.weak],
        cKeyStrong: [...cKey.strong],
        cKeyWeak: [...cKey.weak],
        keyOverlapAny: [...overlapAny],
        keyOverlapStrong: [...overlapStrong],
        keyGroupBoost,
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
 * Validate a cached token against the current query.
 * Re-scores using current matching logic to detect stale/wrong cache entries.
 * 
 * @param {Object} params
 * @param {string} params.hotelName - Current query hotel name
 * @param {string} params.officialDomain - Current official domain (if any)
 * @param {Object} params.tokenObj - Cached token object from KV
 * @param {string} params.source - Cache source ("hit-domain", "hit-name", "ctx-hit")
 * @returns {Object} Validation result with ok, reason, updates, confidence, etc.
 */
export function validateCachedToken({ hotelName, officialDomain, tokenObj, source }) {
    const candidateName = tokenObj?.property_name || "";
    if (!candidateName) {
        return { ok: false, reason: "missing_property_name" };
    }

    // Ensure linkHost available
    const linkHost = tokenObj?.linkHost || getHostNoWww(tokenObj?.link || "");
    const domainMatch = officialDomain ? domainsEquivalent(linkHost, officialDomain) : false;

    // Use city suffix stripping consistent with pickBestProperty
    const locationStrip = stripTrailingLocationSuffix(hotelName, tokenObj?.city, tokenObj?.country);
    const queryForScore = locationStrip.stripped;

    const details = scoreNameMatchDetailed(queryForScore, candidateName);
    details.queryOriginal = hotelName;
    details.queryForScore = queryForScore;
    details.locationSuffixStripped = locationStrip.wasStripped;

    const baseScore = details.baseScore;
    const confidence = computeConfidence(domainMatch, baseScore, details.hardMismatch);

    // Validation thresholds:
    // - Always reject hardMismatch
    if (details.hardMismatch) {
        return {
            ok: false,
            reason: "hard_mismatch",
            details,
            confidence,
            baseScore,
            domainMatch,
            queryForScore
        };
    }

    // - For hit-domain, still require some baseScore to avoid chain-domain collisions
    if (source === "hit-domain") {
        if (baseScore < MIN_SCORE_FOR_DOMAIN_BOOST) {
            return {
                ok: false,
                reason: `domain_hit_but_name_too_low:${baseScore.toFixed(3)}`,
                details,
                confidence,
                baseScore,
                domainMatch,
                queryForScore
            };
        }
    } else {
        // hit-name or ctx-hit: require at least the ctx threshold
        if (confidence < 0.55) {
            return {
                ok: false,
                reason: `confidence_too_low:${confidence.toFixed(3)}`,
                details,
                confidence,
                baseScore,
                domainMatch,
                queryForScore
            };
        }
    }

    // Validation passed - return freshened fields
    return {
        ok: true,
        updates: {
            linkHost,
            nameScore: baseScore,
            confidence,
            domainMatch,
            matchDetails: details,
            officialDomain: officialDomain || null,
        },
        confidence,
        baseScore,
        domainMatch,
        queryForScore,
        details,
    };
}

/**
 * Pick best property from candidates.
 * @param {Object[]} properties - Candidate properties
 * @param {string} hotelName - Query hotel name
 * @param {string} officialDomain - Official domain for boost
 * @param {Object} [opts] - Options
 * @param {string} [opts.altQuery] - Alternative query for score boosting (e.g., from Booking slug)
 * @returns {Object|null}
 */
export function pickBestProperty(properties, hotelName, officialDomain, opts = {}) {
    if (!Array.isArray(properties) || properties.length === 0) return null;

    const altQuery = String(opts.altQuery || "").trim();

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

        // Skip hard mismatches (main query determines this, not altQuery)
        if (matchDetails.hardMismatch) {
            allCandidates.push({
                name: p?.name,
                city: p?.city,
                skipped: true,
                reason: matchDetails.brandMismatch ? "brand_mismatch" : matchDetails.keyConflict ? "key_conflict" : "hard_mismatch",
                details: matchDetails,
            });
            continue;
        }

        // altQuery scoring: can only IMPROVE baseScore, never bypass hardMismatch
        let baseScore = matchDetails.baseScore;
        let altUsed = false;
        let altBaseScore = null;

        if (altQuery) {
            const alt = scoreNameMatchDetailed(altQuery, p?.name || "");
            altBaseScore = alt.baseScore;
            // Only use alt if it improves score AND doesn't have its own hardMismatch
            if (!alt.hardMismatch && alt.baseScore > baseScore) {
                baseScore = alt.baseScore;
                altUsed = true;
            }
        }

        matchDetails.altQuery = altQuery || null;
        matchDetails.altUsed = altUsed;
        matchDetails.altBaseScore = altBaseScore;
        matchDetails.mainBaseScore = matchDetails.baseScore;
        matchDetails.effectiveBaseScore = baseScore;

        const domainBoost = computeDomainBoost(domainMatch, baseScore);
        const finalScore = baseScore + domainBoost;
        const confidence = computeConfidence(domainMatch, baseScore, matchDetails.hardMismatch);

        allCandidates.push({
            name: p?.name,
            city: p?.city,
            baseScore,
            mainBaseScore: matchDetails.baseScore,
            altBaseScore,
            altUsed,
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
            bestNameScore = baseScore;
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
