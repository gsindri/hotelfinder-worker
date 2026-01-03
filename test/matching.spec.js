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
