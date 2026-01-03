import { describe, it, expect } from 'vitest';

// Note: We need to import from the built worker, but for unit testing
// we can test the matching logic via the exported function
// For now, mock the structure to test the logic

/**
 * Test helper - mimics normalizeForIncludes
 */
function normalizeForIncludes(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Test helper - escapeRegExp
 */
function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Test helper - patternToRegex
 */
function patternToRegex(pattern) {
    const words = normalizeForIncludes(pattern).split(/\s+/).filter(Boolean);
    const body = words.map(escapeRegExp).join("\\s+");
    return new RegExp(`\\b${body}\\b`, "i");
}

// Minimal brand rules for testing
const TEST_BRAND_RULES = [
    { id: "marriott", patterns: ["marriott"] },
    { id: "hilton", patterns: ["hilton"] },
    { id: "best-western", patterns: ["best western"] },
    { id: "holiday-inn", patterns: ["holiday inn"] },
    { id: "premier-inn", patterns: ["premier inn"] },
    { id: "days-inn", patterns: ["days inn"] },
];

// Precompile
const TEST_BRAND_MATCHERS = TEST_BRAND_RULES.map(rule => ({
    id: rule.id,
    res: (rule.patterns || []).map(patternToRegex),
}));

/**
 * Test version of extractStrictBrands
 */
function extractStrictBrands(name) {
    const n = normalizeForIncludes(name);
    const out = new Set();
    for (const rule of TEST_BRAND_MATCHERS) {
        for (const re of rule.res) {
            if (re.test(n)) {
                out.add(rule.id);
                break;
            }
        }
    }
    return out;
}

function hasAnyOverlap(setA, setB) {
    for (const v of setA) if (setB.has(v)) return true;
    return false;
}

describe('Phrase-aware brand matching', () => {

    describe('extractStrictBrands', () => {
        it('extracts "best-western" from "Best Western Plus Bayside"', () => {
            const brands = extractStrictBrands("Best Western Plus Bayside");
            expect(brands.has("best-western")).toBe(true);
            expect(brands.size).toBe(1);
        });

        it('does NOT match "western" alone (no generic token match)', () => {
            const brands = extractStrictBrands("Western Bayside Hotel");
            expect(brands.has("best-western")).toBe(false);
            expect(brands.size).toBe(0);
        });

        it('extracts "holiday-inn" from "Holiday Inn Express Downtown"', () => {
            const brands = extractStrictBrands("Holiday Inn Express Downtown");
            expect(brands.has("holiday-inn")).toBe(true);
        });

        it('does NOT match "holiday" alone (prevents false brand match)', () => {
            const brands = extractStrictBrands("Holiday Apartments Downtown");
            expect(brands.has("holiday-inn")).toBe(false);
            expect(brands.size).toBe(0);
        });

        it('extracts "premier-inn" from "Premier Inn London City"', () => {
            const brands = extractStrictBrands("Premier Inn London City");
            expect(brands.has("premier-inn")).toBe(true);
        });

        it('does NOT match "premier" alone', () => {
            const brands = extractStrictBrands("Premier Suites London City");
            expect(brands.has("premier-inn")).toBe(false);
        });

        it('handles single-word distinctive brands like "marriott"', () => {
            const brands = extractStrictBrands("Marriott Downtown Portland");
            expect(brands.has("marriott")).toBe(true);
        });

        it('returns empty set for no brands', () => {
            const brands = extractStrictBrands("Green Room Apartments");
            expect(brands.size).toBe(0);
        });
    });

    describe('brandMismatch logic', () => {
        it('Best Western query vs Western candidate = mismatch', () => {
            const qBrands = extractStrictBrands("Best Western Plus Bayside");
            const cBrands = extractStrictBrands("Western Bayside Hotel");
            const brandMismatch = (qBrands.size > 0) && !hasAnyOverlap(qBrands, cBrands);
            expect(brandMismatch).toBe(true);
        });

        it('Best Western query vs Best Western candidate = no mismatch', () => {
            const qBrands = extractStrictBrands("Best Western Plus Bayside");
            const cBrands = extractStrictBrands("Best Western Plus Bayside Hotel");
            const brandMismatch = (qBrands.size > 0) && !hasAnyOverlap(qBrands, cBrands);
            expect(brandMismatch).toBe(false);
        });

        it('Holiday Inn query vs Holiday Apartments = mismatch', () => {
            const qBrands = extractStrictBrands("Holiday Inn Express Downtown");
            const cBrands = extractStrictBrands("Holiday Apartments Downtown");
            const brandMismatch = (qBrands.size > 0) && !hasAnyOverlap(qBrands, cBrands);
            expect(brandMismatch).toBe(true);
        });

        it('No brand in query = no brand mismatch', () => {
            const qBrands = extractStrictBrands("Green Room Apartments");
            const cBrands = extractStrictBrands("Hilton Green Room Apartments");
            const brandMismatch = (qBrands.size > 0) && !hasAnyOverlap(qBrands, cBrands);
            expect(brandMismatch).toBe(false); // Query has no brand, so no enforcement
        });
    });
});

// ---------- Key Group Synonym Matching Tests ----------

// Key group rules for testing (matching constants.js)
const TEST_KEY_GROUP_RULES = [
    {
        id: "airport",
        strong: ["airport", "terminal"],
        weak: [],
    },
    {
        id: "station",
        strong: ["train station", "railway station", "metro station", "subway station"],
        weak: ["station"],
    },
    {
        id: "center",
        strong: ["downtown", "city center", "city centre", "old town", "oldtown", "historic center", "historic centre"],
        weak: ["central", "centre"],
    },
    {
        id: "waterfront",
        strong: ["beach", "seafront", "oceanfront", "waterfront", "beachfront"],
        weak: ["harbor", "harbour", "marina", "port"],
    },
];

const KEY_GROUP_BOOST_STRONG = 0.12;
const KEY_GROUP_BOOST_WEAK = 0.06;
const KEY_GROUP_BOOST_CAP = 0.24;

// Precompile key group matchers
const TEST_KEY_GROUP_MATCHERS = TEST_KEY_GROUP_RULES.map(g => ({
    id: g.id,
    strong: (g.strong || []).map(patternToRegex),
    weak: (g.weak || []).map(patternToRegex),
}));

function extractKeySignals(name) {
    const n = normalizeForIncludes(name);
    const strong = new Set();
    const weak = new Set();
    const matched = {};

    for (const g of TEST_KEY_GROUP_MATCHERS) {
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

function computeKeyConflict(qKey, cKey) {
    const overlapStrong = intersectSets(qKey.strong, cKey.strong);
    return qKey.strong.size > 0 && cKey.strong.size > 0 && overlapStrong.size === 0;
}

function computeKeyGroupBoost(qKey, cKey) {
    const qAny = unionSets(qKey.strong, qKey.weak);
    const cAny = unionSets(cKey.strong, cKey.weak);
    const overlapAny = intersectSets(qAny, cAny);

    let boost = 0;
    for (const gid of overlapAny) {
        const bothStrong = qKey.strong.has(gid) && cKey.strong.has(gid);
        boost += bothStrong ? KEY_GROUP_BOOST_STRONG : KEY_GROUP_BOOST_WEAK;
    }
    return Math.min(KEY_GROUP_BOOST_CAP, boost);
}

describe('Synonym-aware key group matching', () => {

    describe('extractKeySignals', () => {
        it('extracts "center" from "Hotel Foo Downtown"', () => {
            const signals = extractKeySignals("Hotel Foo Downtown");
            expect(signals.strong.has("center")).toBe(true);
            expect(signals.matched["center"]).toBe("strong");
        });

        it('extracts "center" from "Hotel Foo City Centre"', () => {
            const signals = extractKeySignals("Hotel Foo City Centre");
            expect(signals.strong.has("center")).toBe(true);
        });

        it('extracts weak "center" from "Hotel Foo Central"', () => {
            const signals = extractKeySignals("Hotel Foo Central");
            expect(signals.weak.has("center")).toBe(true);
            expect(signals.strong.has("center")).toBe(false);
        });

        it('extracts "airport" from "Hotel Foo Airport"', () => {
            const signals = extractKeySignals("Hotel Foo Airport");
            expect(signals.strong.has("airport")).toBe(true);
        });

        it('returns empty for "Hotel Foo" (no key signals)', () => {
            const signals = extractKeySignals("Hotel Foo");
            expect(signals.strong.size).toBe(0);
            expect(signals.weak.size).toBe(0);
        });
    });

    describe('keyConflict logic', () => {
        it('A) Synonym equivalence: Downtown vs City Centre = NO conflict', () => {
            const qKey = extractKeySignals("Hotel Foo Downtown");
            const cKey = extractKeySignals("Hotel Foo City Centre");
            const keyConflict = computeKeyConflict(qKey, cKey);
            expect(keyConflict).toBe(false); // Both have "center" strong
        });

        it('B) Strong conflict: Airport vs Downtown = conflict', () => {
            const qKey = extractKeySignals("Hotel Foo Airport");
            const cKey = extractKeySignals("Hotel Foo Downtown");
            const keyConflict = computeKeyConflict(qKey, cKey);
            expect(keyConflict).toBe(true); // Both have strong, no overlap
        });

        it('C) Missing keys = soft (no conflict)', () => {
            const qKey = extractKeySignals("Hotel Foo Airport");
            const cKey = extractKeySignals("Hotel Foo");
            const keyConflict = computeKeyConflict(qKey, cKey);
            expect(keyConflict).toBe(false); // Candidate has no strong keys
        });

        it('D) Weak tokens don\'t create conflicts', () => {
            const qKey = extractKeySignals("Hotel Foo Airport");
            const cKey = extractKeySignals("Hotel Foo Central"); // weak center
            const keyConflict = computeKeyConflict(qKey, cKey);
            expect(keyConflict).toBe(false); // Candidate has only weak, no conflict
        });

        it('E) Grand/Plaza/City (generic words) don\'t act as disambiguators', () => {
            const signals = extractKeySignals("Grand Plaza Hotel Foo");
            // These generic words should NOT trigger any key group
            expect(signals.strong.size).toBe(0);
            expect(signals.weak.size).toBe(0);
        });
    });

    describe('keyGroupBoost', () => {
        it('Downtown vs City Centre = positive boost', () => {
            const qKey = extractKeySignals("Hotel Foo Downtown");
            const cKey = extractKeySignals("Hotel Foo City Centre");
            const boost = computeKeyGroupBoost(qKey, cKey);
            expect(boost).toBe(KEY_GROUP_BOOST_STRONG); // Both strong
        });

        it('Downtown vs Central = weaker boost', () => {
            const qKey = extractKeySignals("Hotel Foo Downtown");
            const cKey = extractKeySignals("Hotel Foo Central");
            const boost = computeKeyGroupBoost(qKey, cKey);
            expect(boost).toBe(KEY_GROUP_BOOST_WEAK); // One weak
        });

        it('Airport vs Downtown = no boost (different groups)', () => {
            const qKey = extractKeySignals("Hotel Foo Airport");
            const cKey = extractKeySignals("Hotel Foo Downtown");
            const boost = computeKeyGroupBoost(qKey, cKey);
            expect(boost).toBe(0);
        });

        it('No keys = no boost', () => {
            const qKey = extractKeySignals("Hotel Foo");
            const cKey = extractKeySignals("Hotel Bar");
            const boost = computeKeyGroupBoost(qKey, cKey);
            expect(boost).toBe(0);
        });
    });
});

// ---------- Accommodation Type Signal Tests ----------

// Type group rules for testing (matching constants.js)
const TEST_ACCOM_TYPE_GROUPS = [
    {
        id: "apartment",
        patterns: ["apartment", "apartments", "serviced apartment", "aparthotel", "residence"],
        strength: "strong",
    },
    {
        id: "hostel",
        patterns: ["hostel", "youth hostel"],
        strength: "strong",
    },
    {
        id: "guesthouse",
        patterns: ["guesthouse", "guest house", "pension"],
        strength: "strong",
    },
    {
        id: "hotel",
        patterns: ["hotel", "inn", "lodge", "resort", "suite", "suites"],
        strength: "weak",
    },
];

const TYPE_MATCH_BOOST = 0.05;
const TYPE_MISMATCH_PENALTY_STRONG = 0.18;
const TYPE_MISMATCH_PENALTY_WEAK = 0.10;
const TYPE_EFFECT_CAP = 0.20;

// Precompile type matchers
const TEST_ACCOM_TYPE_MATCHERS = TEST_ACCOM_TYPE_GROUPS.map(g => ({
    id: g.id,
    strength: g.strength || "weak",
    res: (g.patterns || []).map(patternToRegex),
}));

function extractAccommodationTypeGroups(name) {
    const n = normalizeForIncludes(name);
    const groups = new Set();
    const strengths = {};

    for (const g of TEST_ACCOM_TYPE_MATCHERS) {
        if (g.res.some(re => re.test(n))) {
            groups.add(g.id);
            strengths[g.id] = g.strength;
        }
    }
    return { groups, strengths };
}

function computeTypePenalty(qType, cType) {
    const qGroups = qType.groups;
    const cGroups = cType.groups;

    const typeOverlap = new Set();
    for (const g of qGroups) if (cGroups.has(g)) typeOverlap.add(g);

    if (qGroups.size === 0 || cGroups.size === 0) return 0;
    if (typeOverlap.size > 0) return 0; // Match, no penalty

    const qHasStrongNonHotel = [...qGroups].some(g => qType.strengths[g] === "strong" && g !== "hotel");
    const cHasStrongNonHotel = [...cGroups].some(g => cType.strengths[g] === "strong" && g !== "hotel");

    if (qHasStrongNonHotel && cHasStrongNonHotel) {
        return TYPE_MISMATCH_PENALTY_STRONG;
    } else if (qHasStrongNonHotel || cHasStrongNonHotel) {
        return TYPE_MISMATCH_PENALTY_WEAK;
    }
    return 0;
}

function computeTypeBoost(qType, cType) {
    const qGroups = qType.groups;
    const cGroups = cType.groups;

    const typeOverlap = new Set();
    for (const g of qGroups) if (cGroups.has(g)) typeOverlap.add(g);

    if (qGroups.size > 0 && cGroups.size > 0 && typeOverlap.size > 0) {
        return TYPE_MATCH_BOOST;
    }
    return 0;
}

describe('Accommodation type signals', () => {

    describe('extractAccommodationTypeGroups', () => {
        it('extracts "apartment" from "Green Room Apartments"', () => {
            const type = extractAccommodationTypeGroups("Green Room Apartments");
            expect(type.groups.has("apartment")).toBe(true);
            expect(type.strengths["apartment"]).toBe("strong");
        });

        it('extracts "hostel" from "Central Hostel"', () => {
            const type = extractAccommodationTypeGroups("Central Hostel");
            expect(type.groups.has("hostel")).toBe(true);
            expect(type.strengths["hostel"]).toBe("strong");
        });

        it('extracts "hotel" from "Green Room Hotel"', () => {
            const type = extractAccommodationTypeGroups("Green Room Hotel");
            expect(type.groups.has("hotel")).toBe(true);
            expect(type.strengths["hotel"]).toBe("weak");
        });

        it('returns empty for "Green Room" (no type)', () => {
            const type = extractAccommodationTypeGroups("Green Room");
            expect(type.groups.size).toBe(0);
        });
    });

    describe('type penalty logic', () => {
        it('1) Apartment vs Hotel = should penalize (weak penalty)', () => {
            const qType = extractAccommodationTypeGroups("Green Room Apartments");
            const cType = extractAccommodationTypeGroups("Green Room Hotel");
            const penalty = computeTypePenalty(qType, cType);
            expect(penalty).toBe(TYPE_MISMATCH_PENALTY_WEAK); // apartment(strong) vs hotel(weak)
        });

        it('2) Apartment vs Apartments = no penalty (match)', () => {
            const qType = extractAccommodationTypeGroups("Green Room Apartments");
            const cType = extractAccommodationTypeGroups("Green Room Apartments");
            const penalty = computeTypePenalty(qType, cType);
            expect(penalty).toBe(0);
        });

        it('3) Query missing type = no penalty', () => {
            const qType = extractAccommodationTypeGroups("Green Room");
            const cType = extractAccommodationTypeGroups("Green Room Apartments");
            const penalty = computeTypePenalty(qType, cType);
            expect(penalty).toBe(0); // Don't punish omission
        });

        it('4) Hostel vs Apartment = strong penalty', () => {
            const qType = extractAccommodationTypeGroups("Central Hostel");
            const cType = extractAccommodationTypeGroups("Central Apartments");
            const penalty = computeTypePenalty(qType, cType);
            expect(penalty).toBe(TYPE_MISMATCH_PENALTY_STRONG); // Both strong, no overlap
        });

        it('5) Inn vs Hotel = no penalty (both in hotel group)', () => {
            const qType = extractAccommodationTypeGroups("Sunset Inn");
            const cType = extractAccommodationTypeGroups("Sunset Hotel");
            const penalty = computeTypePenalty(qType, cType);
            expect(penalty).toBe(0); // Both map to "hotel" group
        });
    });

    describe('type boost logic', () => {
        it('Apartments vs Apartments = boost', () => {
            const qType = extractAccommodationTypeGroups("Green Room Apartments");
            const cType = extractAccommodationTypeGroups("Green Room Apartments");
            const boost = computeTypeBoost(qType, cType);
            expect(boost).toBe(TYPE_MATCH_BOOST);
        });

        it('Hotel vs Hotel = boost', () => {
            const qType = extractAccommodationTypeGroups("Grand Hotel");
            const cType = extractAccommodationTypeGroups("Grand Hotel");
            const boost = computeTypeBoost(qType, cType);
            expect(boost).toBe(TYPE_MATCH_BOOST);
        });

        it('No type = no boost', () => {
            const qType = extractAccommodationTypeGroups("Green Room");
            const cType = extractAccommodationTypeGroups("Green Room");
            const boost = computeTypeBoost(qType, cType);
            expect(boost).toBe(0); // Neither has type
        });
    });
});
