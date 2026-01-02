/**
 * Offer processing utilities.
 * Badge extraction, room simplification, OTA matching.
 * 
 * @module lib/offers
 */

import { MAX_ROOMS_PER_OFFER } from './constants.js';
import { parseMoneyToNumber, normalizeKey } from './normalize.js';

/**
 * Extract badges from raw offer data.
 * @param {Object} raw - Raw offer from SearchApi
 * @param {boolean} debug - Include debug info
 * @returns {string[]|Object}
 */
export function extractBadges(raw, debug = false) {
    const badges = [];
    const labelSources = [
        raw?.label,
        raw?.badge,
        raw?.promo_label,
        raw?.rate_label,
        raw?.offer_label,
        raw?.discount_label,
        raw?.loyalty_label,
        raw?.total_price?.label,
        raw?.total_price?.badge,
        raw?.price_per_night?.label,
        ...(Array.isArray(raw?.labels) ? raw.labels : []),
        ...(Array.isArray(raw?.badges) ? raw.badges : []),
        raw?.offer_type,
        raw?.rate_type,
    ].filter(Boolean);

    const label = labelSources.join(' ').toLowerCase();

    const rawFeatures = raw?.features;
    const featureParts =
        Array.isArray(rawFeatures) ? rawFeatures :
            (typeof rawFeatures === 'string' ? [rawFeatures] : []);
    const features = featureParts.join(' ').toLowerCase();

    const combined = label + ' ' + features;

    if (/member|loyalty|genius|vip|rewards|exclusive/i.test(combined)) badges.push('Member');
    if (/sign.?in|log.?in|login|registered/i.test(combined)) badges.push('Login');
    if (/mobile|app.only/i.test(combined)) badges.push('Mobile');
    if (/coupon|promo|deal|discount/i.test(combined)) badges.push('Promo');

    if (debug) {
        return {
            badges,
            debug: {
                labelSourcesFound: labelSources,
                combinedString: combined.slice(0, 500),
                rawKeys: raw ? Object.keys(raw) : [],
                totalPriceKeys: raw?.total_price ? Object.keys(raw.total_price) : [],
                pricePerNightKeys: raw?.price_per_night ? Object.keys(raw.price_per_night) : [],
                hasFeatures: Boolean(raw?.features?.length),
                sampleFields: {
                    source: raw?.source,
                    is_official: raw?.is_official,
                    label: raw?.label,
                    badge: raw?.badge,
                    rate_type: raw?.rate_type,
                    offer_type: raw?.offer_type,
                },
            },
        };
    }

    return badges;
}

/**
 * Extract badges from URL parameters.
 * @param {string} url - URL to parse
 * @param {boolean} debug - Include debug info
 * @returns {string[]|Object}
 */
export function extractBadgesFromUrl(url, debug = false) {
    const badges = [];
    const debugInfo = { urlChecked: false, flagsFound: {} };

    if (!url) {
        return debug ? { badges, debug: debugInfo } : badges;
    }

    debugInfo.urlChecked = true;

    try {
        const urlStr = String(url);
        const lowerUrl = urlStr.toLowerCase();
        const allParams = [];

        const parsed = new URL(urlStr);
        for (const [k, v] of parsed.searchParams) {
            allParams.push({ key: k.toLowerCase(), value: v.toLowerCase() });
        }

        for (const val of [parsed.searchParams.get('url'), parsed.searchParams.get('turl'), parsed.searchParams.get('dest')]) {
            if (val) {
                try {
                    const nested = new URL(decodeURIComponent(val));
                    for (const [k, v] of nested.searchParams) {
                        allParams.push({ key: k.toLowerCase(), value: v.toLowerCase() });
                    }
                } catch { }
            }
        }

        for (const { key, value } of allParams) {
            if (key === 'isprivaterate' && value === '1') {
                debugInfo.flagsFound.isPrivateRate = true;
                if (!badges.includes('Member')) badges.push('Member');
            }
            if (key === 'isaudienceuser' && value === '1') {
                debugInfo.flagsFound.isAudienceUser = true;
                if (!badges.includes('Login')) badges.push('Login');
            }
            if (key === 'prid' && /member/i.test(value)) {
                debugInfo.flagsFound.pridMember = value;
                if (!badges.includes('Member')) badges.push('Member');
            }
            if (key === 'rateid' && /genius|member|vip/i.test(value)) {
                debugInfo.flagsFound.rateIdMember = value;
                if (!badges.includes('Member')) badges.push('Member');
            }
        }

        if (/genius/i.test(lowerUrl) && !badges.includes('Member')) {
            debugInfo.flagsFound.urlContainsGenius = true;
            badges.push('Member');
        }

        if (/mobile[_-]?only|app[_-]?only/i.test(lowerUrl) && !badges.includes('Mobile')) {
            debugInfo.flagsFound.urlContainsMobileOnly = true;
            badges.push('Mobile');
        }

    } catch (e) {
        debugInfo.parseError = e.message;
    }

    return debug ? { badges, debug: debugInfo } : badges;
}

/**
 * Simplify a room object.
 * @param {Object} r - Raw room data
 * @param {number} nights - Number of nights
 * @returns {Object|null}
 */
export function simplifyRoom(r, nights) {
    const name = r?.name || r?.room_name || r?.title || null;
    const numGuests = r?.num_guests || null;

    const totalObj = r?.total_price || r?.totalPrice || null;
    const perNightObj = r?.price_per_night || r?.pricePerNight || null;

    const totalExtracted =
        totalObj?.extracted_price ??
        totalObj?.extracted_price_before_taxes ??
        null;
    const totalText =
        totalObj?.price ??
        totalObj?.price_before_taxes ??
        null;
    let total = totalExtracted ?? parseMoneyToNumber(totalText);

    const perNightExtracted =
        perNightObj?.extracted_price ??
        perNightObj?.extracted_price_before_taxes ??
        null;
    const perNightText =
        perNightObj?.price ??
        perNightObj?.price_before_taxes ??
        null;
    const perNight = perNightExtracted ?? parseMoneyToNumber(perNightText);

    if (total == null && perNight != null && nights) {
        total = perNight * nights;
    }

    const link = r?.link || r?.tracking_link || null;

    if (!name || total == null) return null;

    const badges = extractBadgesFromUrl(link);

    return {
        name,
        numGuests,
        total,
        totalText,
        perNight,
        perNightText,
        link,
        badges: badges.length > 0 ? badges : undefined,
        totalIsBeforeTax: totalObj?.extracted_price == null && totalObj?.extracted_price_before_taxes != null,
    };
}

/**
 * Simplify rooms array.
 * @param {Object[]} rooms - Raw rooms data
 * @param {number} nights - Number of nights
 * @returns {Object[]}
 */
export function simplifyRooms(rooms, nights) {
    if (!Array.isArray(rooms)) return [];
    return rooms.slice(0, MAX_ROOMS_PER_OFFER).map(r => simplifyRoom(r, nights)).filter(Boolean);
}

/**
 * Simplify an offer object.
 * @param {Object} o - Raw offer data
 * @param {number} nights - Number of nights
 * @returns {Object}
 */
export function simplifyOffer(o, nights) {
    const link = o?.link || o?.tracking_link || null;

    const totalExtracted =
        o?.total_price?.extracted_price ??
        o?.total_price?.extracted_price_before_taxes ??
        null;

    const totalText =
        o?.total_price?.price ??
        o?.total_price?.price_before_taxes ??
        null;

    const perNightExtracted =
        o?.price_per_night?.extracted_price ??
        o?.price_per_night?.extracted_price_before_taxes ??
        null;

    const perNightText =
        o?.price_per_night?.price ??
        o?.price_per_night?.price_before_taxes ??
        null;

    const beforeTaxExtracted = o?.total_price?.extracted_price_before_taxes ?? null;
    const beforeTaxText = o?.total_price?.price_before_taxes ?? null;
    const beforeTax = beforeTaxExtracted ?? parseMoneyToNumber(beforeTaxText);

    let total = totalExtracted;
    if (total == null) total = parseMoneyToNumber(totalText);
    if (total == null && beforeTax != null) total = beforeTax;
    if (total == null && perNightExtracted != null && nights) total = perNightExtracted * nights;

    return {
        source: o?.source || null,
        isOfficial: o?.is_official === true,
        total,
        totalText,
        beforeTax,
        beforeTaxText,
        perNight: perNightExtracted ?? parseMoneyToNumber(perNightText),
        perNightText,
        link,
        totalIsBeforeTax:
            o?.total_price?.extracted_price == null &&
            o?.total_price?.price == null &&
            beforeTax != null,
        badges: [...new Set([...extractBadges(o), ...extractBadgesFromUrl(link)])],
    };
}

/**
 * Normalize OTA key for matching.
 * @param {string} s - OTA name/source
 * @returns {string}
 */
export function normalizeOtaKey(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/^www\./, "")
        .replace(/[^a-z0-9]+/g, "");
}

/**
 * Build OTA aliases from host.
 * @param {string} host - Host name
 * @returns {Set<string>}
 */
export function buildOtaAliasesFromHost(host) {
    const key = normalizeOtaKey(host);
    const out = new Set();
    if (!key) return out;

    out.add(key);

    if (key.endsWith("com")) out.add(key.slice(0, -3));
    if (key.endsWith("net")) out.add(key.slice(0, -3));
    if (key.endsWith("org")) out.add(key.slice(0, -3));

    if (key === "expediacom") out.add("expedia");
    if (key === "hotelscom") out.add("hotels");
    if (key === "bookingcom") out.add("booking");
    if (key === "agodacom") out.add("agoda");
    if (key === "tripcom") out.add("trip");
    if (key === "pricelinecom") out.add("priceline");

    return out;
}

/**
 * Find offer for a given host.
 * @param {Object[]} offers - List of offers
 * @param {string} host - Host to match
 * @returns {Object|null}
 */
export function findOfferForHost(offers, host) {
    if (!host || !Array.isArray(offers) || offers.length === 0) return null;
    const aliases = buildOtaAliasesFromHost(host);
    if (!aliases.size) return null;

    for (const o of offers) {
        const sk = normalizeOtaKey(o?.source);
        if (aliases.has(sk)) return o;
    }

    for (const o of offers) {
        const sk = normalizeOtaKey(o?.source);
        for (const a of aliases) {
            if (a && sk.includes(a)) return o;
        }
    }

    return null;
}

/**
 * Compute context ID from search params.
 * @param {string} gl - Geo location
 * @param {string} hlKey - Language key
 * @param {string} q - Query
 * @param {string} checkIn - Check-in date
 * @param {string} checkOut - Check-out date
 * @param {number} adults - Number of adults
 * @param {string} currency - Currency code
 * @returns {string}
 */
export function computeCtxId(gl, hlKey, q, checkIn, checkOut, adults, currency) {
    const normalized = [
        (gl || "us").toLowerCase(),
        (hlKey || "default").toLowerCase(),
        normalizeKey(q || ""),
        checkIn || "",
        checkOut || "",
        String(adults || 2),
        (currency || "USD").toUpperCase(),
    ].join("|");

    // Simple string hash (djb2)
    let hash = 5381;
    for (let i = 0; i < normalized.length; i++) {
        hash = ((hash << 5) + hash) + normalized.charCodeAt(i);
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}
