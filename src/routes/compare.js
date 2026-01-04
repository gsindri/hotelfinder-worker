/**
 * /compare route handler.
 * SearchApi-based hotel offer comparison with KV caching.
 *
 * @module routes/compare
 */

import {
    TOKEN_TTL_SEC,
    TOKEN_TTL_NO_DOMAIN_SEC,
    OFFERS_TTL_SEC,
    MAX_OFFERS_RETURNED,
} from '../lib/constants.js';
import { jsonResponse } from '../lib/http.js';
import { kvGetJson, kvPutJson } from '../lib/kvCache.js';
import { rateLimitCompare } from '../lib/rateLimit.js';
import {
    isIsoDate,
    normalizeCurrencyParam,
    normalizeTravelHl,
    normalizeKey,
    nightsBetweenIso,
    getHostNoWww,
    parseBookingHotelSlug,
} from '../lib/normalize.js';
import { pickBestProperty, validateCachedToken } from '../lib/matching.js';
import { searchApiCall } from '../lib/searchApi.js';
import {
    extractBadges,
    extractBadgesFromUrl,
    simplifyOffer,
    simplifyRooms,
    normalizeOtaKey,
    findOfferForHost,
    computeCtxId,
} from '../lib/offers.js';

/**
 * Round to 3 decimal places for compact summaries.
 * @param {number} x
 * @returns {number|null}
 */
function round3(x) {
    return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
}

/**
 * Make a small, stable summary from pickBestProperty().allCandidates
 * - limit payload
 * - avoid property_token leakage
 * - preserve why candidates were skipped
 * @param {Array} allCandidates - Array of candidate objects from pickBestProperty
 * @param {number} limit - Max number of top candidates to include
 * @returns {Object|null}
 */
function summarizeCandidates(allCandidates, limit = 3) {
    if (!Array.isArray(allCandidates) || allCandidates.length === 0) return null;

    const skippedCounts = {};
    const considered = [];

    for (const c of allCandidates) {
        if (c?.skipped) {
            const r = c?.reason || "skipped";
            skippedCounts[r] = (skippedCounts[r] || 0) + 1;
        } else {
            considered.push(c);
        }
    }

    considered.sort((a, b) => {
        const sa = (a?.finalScore ?? a?.baseScore ?? 0);
        const sb = (b?.finalScore ?? b?.baseScore ?? 0);
        return sb - sa;
    });

    const topCandidates = considered.slice(0, limit).map(c => ({
        name: c?.name || null,
        confidence: round3(c?.confidence),
        finalScore: round3(c?.finalScore),
        baseScore: round3(c?.baseScore),
        domainMatch: !!c?.domainMatch,
    }));

    return {
        topCandidates,
        skippedCounts,
        total: allCandidates.length,
    };
}

/**
 * Handle /compare request.
 * @param {Object} ctx - Request context
 * @returns {Promise<Response>}
 */
export async function handleCompare({ request, env, ctx, url, corsHeaders, compareCors }) {
    // CORS lock: only allow your extension / explicit allowlist
    if (!compareCors?.configured) {
        return jsonResponse(
            {
                error: "Compare CORS not configured",
                hint: "Set CHROME_EXTENSION_ID or COMPARE_ALLOWED_ORIGINS in your Worker environment variables.",
            },
            500,
            corsHeaders
        );
    }

    if (!compareCors?.allowed) {
        return jsonResponse(
            { error: "Forbidden", reason: "Origin not allowed for /compare", origin: compareCors?.origin || null },
            403,
            corsHeaders
        );
    }

    const rl = await rateLimitCompare(request, env, corsHeaders);
    if (rl) return rl;

    if (!env.SEARCHAPI_KEY) return jsonResponse({ error: "Missing SEARCHAPI_KEY" }, 500, corsHeaders);
    if (!env.CACHE_KV) return jsonResponse({ error: "Missing CACHE_KV binding" }, 500, corsHeaders);

    const debug = url.searchParams.get("debug") === "1";
    const refresh = url.searchParams.get("refresh") === "1";
    const includeRooms = url.searchParams.get("includeRooms") === "1";

    // Smart matching: Booking URL slug
    const smartRaw = url.searchParams.get("smart");
    const smart = smartRaw === "1" || smartRaw === "true";
    const bookingUrlRaw = url.searchParams.get("bookingUrl") || "";

    const hotelName =
        url.searchParams.get("hotelName") ||
        url.searchParams.get("hotel") ||
        url.searchParams.get("q") ||
        url.searchParams.get("query");

    const checkIn =
        url.searchParams.get("checkIn") ||
        url.searchParams.get("check_in_date") ||
        url.searchParams.get("check_in");

    const checkOut =
        url.searchParams.get("checkOut") ||
        url.searchParams.get("check_out_date") ||
        url.searchParams.get("check_out");

    const adultsRaw = url.searchParams.get("adults");
    const adults = Math.min(10, Math.max(1, parseInt(adultsRaw || "2", 10) || 2));

    const currencyRaw = url.searchParams.get("currency");
    const currency = normalizeCurrencyParam(currencyRaw) || "USD";
    const gl = (url.searchParams.get("gl") || "us").toLowerCase();

    const officialUrl =
        url.searchParams.get("officialUrl") ||
        url.searchParams.get("official") ||
        url.searchParams.get("website") ||
        url.searchParams.get("site") ||
        "";

    const officialDomain = getHostNoWww(officialUrl);

    const currentHost =
        url.searchParams.get("currentHost") ||
        url.searchParams.get("host") ||
        url.searchParams.get("otaHost") ||
        "";

    const hlRaw = url.searchParams.get("hl");
    const { hlNormalized, hlSent, hlKey } = normalizeTravelHl(hlRaw);
    const hlToSend = hlSent;

    const missing = [];
    if (!hotelName) missing.push("hotelName");
    if (!checkIn) missing.push("checkIn");
    if (!checkOut) missing.push("checkOut");
    if (missing.length) return jsonResponse({ error: "Missing required params", error_code: "INVALID_PARAMS", missing }, 400, corsHeaders);

    if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
        return jsonResponse({ error: "Dates must be YYYY-MM-DD", error_code: "INVALID_PARAMS", checkIn, checkOut }, 400, corsHeaders);
    }

    const nights = nightsBetweenIso(checkIn, checkOut);
    if (!nights || nights <= 0) {
        return jsonResponse({ error: "Invalid date range", error_code: "INVALID_PARAMS", checkIn, checkOut }, 400, corsHeaders);
    }

    // ---- 1) Resolve property_token (cached) ----
    const nameIdentity = `n:${normalizeKey(hotelName)}`;
    const domainIdentity = officialDomain ? `d:${officialDomain}` : null;

    const tokenKeyName = `tok:${gl}:${nameIdentity}`;
    const tokenKeyDomain = domainIdentity ? `tok:${gl}:${domainIdentity}` : null;
    const tokenKey = tokenKeyDomain || tokenKeyName;

    // Booking slug identity (stable across name variations)
    const bookingParsed = smart ? parseBookingHotelSlug(bookingUrlRaw) : null;
    const bookingSlug = bookingParsed?.slug || "";
    const bookingIdentity = bookingSlug ? `b:${bookingSlug}` : null;
    const tokenKeyBooking = bookingIdentity ? `tok:${gl}:${bookingIdentity}` : null;

    let tokenCacheDetail = "miss";

    const ctxParam = url.searchParams.get("ctx") || "";
    const ctxKey = ctxParam ? `ctx:${ctxParam}` : null;

    let ctxDebug = {
        ctxAttempted: !!ctxKey,
        ctxHit: false,
        ctxNameScore: null,
        ctxRejectedReason: null,
    };

    let tokenObj = null;
    let tokenValidation = null; // Debug info for cache validation
    if (!refresh) {
        // 1) Try search context first (from /prefetchCtx)
        if (ctxKey) {
            const ctxData = await kvGetJson(env.CACHE_KV, ctxKey);

            if (!ctxData) {
                ctxDebug.ctxRejectedReason = "ctx_missing_or_expired";
            } else if (!Array.isArray(ctxData.properties) || ctxData.properties.length === 0) {
                ctxDebug.ctxRejectedReason = "ctx_empty";
            } else {
                // Derive altQuery from booking slug for improved matching
                const altQuery = bookingSlug ? bookingSlug.replace(/-/g, " ") : "";
                const picked = pickBestProperty(ctxData.properties, hotelName, officialDomain, { altQuery });

                // Capture candidate summary for uncertain match explanation
                const ctxCandidateSummary = summarizeCandidates(picked?.allCandidates, 3);
                ctxDebug.ctxCandidateSummary = ctxCandidateSummary;

                const CTX_MIN_CONFIDENCE = 0.55;
                const acceptCtx = picked?.best?.property_token &&
                    picked.confidence >= CTX_MIN_CONFIDENCE &&
                    !picked.matchDetails?.hardMismatch;

                ctxDebug.ctxNameScore = picked?.bestNameScore ?? null;
                ctxDebug.ctxConfidence = picked?.confidence ?? null;
                ctxDebug.ctxMatchedProperty = picked?.best?.name || null;
                ctxDebug.ctxMatchDetails = picked?.matchDetails || null;

                if (acceptCtx) {
                    tokenObj = {
                        property_token: picked.best.property_token,
                        property_name: picked.best.name || null,
                        city: picked.best.city || null,
                        country: picked.best.country || null,
                        link: picked.best.link || null,
                        linkHost: getHostNoWww(picked.best.link || ""),
                        score: picked.bestScore,
                        nameScore: picked.bestNameScore,
                        confidence: picked.confidence,
                        domainMatch: picked.bestDomainMatch,
                        officialDomain: officialDomain || null,
                        fromCtx: true,
                        candidateSummary: ctxCandidateSummary,
                    };
                    tokenCacheDetail = "ctx-hit";
                    ctxDebug.ctxHit = true;

                    const shouldBackfill = picked.confidence >= 0.75;
                    if (shouldBackfill) {
                        ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyName, tokenObj, TOKEN_TTL_NO_DOMAIN_SEC));
                        if (tokenKeyDomain) {
                            ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyDomain, tokenObj, TOKEN_TTL_SEC));
                        }
                        if (tokenKeyBooking) {
                            ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyBooking, tokenObj, TOKEN_TTL_NO_DOMAIN_SEC));
                        }
                    }
                } else if (picked?.best?.property_token) {
                    tokenCacheDetail = "ctx-nomatch";
                    ctxDebug.ctxRejectedReason = picked.confidence < CTX_MIN_CONFIDENCE
                        ? `confidence_too_low:${picked.confidence?.toFixed(3)}`
                        : picked.matchDetails?.hardMismatch ? "hard_mismatch" : "unknown";
                } else {
                    ctxDebug.ctxRejectedReason = "no_matching_property";
                }
            }
        }

        // 2) Try domain key (more stable/trusted)
        if (!tokenObj?.property_token && tokenKeyDomain) {
            tokenObj = await kvGetJson(env.CACHE_KV, tokenKeyDomain);
            if (tokenObj?.property_token) {
                // Validate cached token against current query
                const v = validateCachedToken({ hotelName, officialDomain, tokenObj, source: "hit-domain" });
                tokenValidation = { source: "hit-domain", ...v };
                if (!v.ok) {
                    tokenObj = null;
                    tokenCacheDetail = `invalid-hit-domain:${v.reason}`;
                } else {
                    Object.assign(tokenObj, v.updates);
                    tokenCacheDetail = "hit-domain";
                }
            }
        }

        // 2.5) Try booking slug key (stable across name variations)
        if (!tokenObj?.property_token && tokenKeyBooking) {
            tokenObj = await kvGetJson(env.CACHE_KV, tokenKeyBooking);
            if (tokenObj?.property_token) {
                // Validate like hit-name (same thresholds)
                const v = validateCachedToken({ hotelName, officialDomain, tokenObj, source: "hit-booking" });
                tokenValidation = { source: "hit-booking", ...v };
                if (!v.ok) {
                    tokenObj = null;
                    tokenCacheDetail = `invalid-hit-booking:${v.reason}`;
                } else {
                    Object.assign(tokenObj, v.updates);
                    tokenCacheDetail = "hit-booking";
                }
            }
        }

        // 3) Fallback to name key
        if (!tokenObj?.property_token) {
            tokenObj = await kvGetJson(env.CACHE_KV, tokenKeyName);
            if (tokenObj?.property_token) {
                // Validate cached token against current query
                const v = validateCachedToken({ hotelName, officialDomain, tokenObj, source: "hit-name" });
                tokenValidation = { source: "hit-name", ...v };
                if (!v.ok) {
                    tokenObj = null;
                    tokenCacheDetail = `invalid-hit-name:${v.reason}`;
                } else {
                    Object.assign(tokenObj, v.updates);
                    tokenCacheDetail = "hit-name";

                    if (tokenKeyDomain) {
                        ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyDomain, tokenObj, TOKEN_TTL_SEC));
                    }
                }
            }
        }
    }

    let candidatesDebug = null;
    let debugSearch = debug ? {} : null;
    let searchCandidateSummary = null;

    const usage = { searchapi_calls: { google_hotels: 0, google_hotels_property: 0 } };

    if (!tokenObj?.property_token) {
        tokenCacheDetail = "miss";

        usage.searchapi_calls.google_hotels++;

        const firstCall = await searchApiCall(env, {
            engine: "google_hotels",
            q: hotelName,
            check_in_date: checkIn,
            check_out_date: checkOut,
            adults,
            currency,
            hl: hlToSend,
            gl,
        });

        if (debugSearch) {
            debugSearch.google_hotels = {
                requestUrl: firstCall.requestUrl,
                hlRaw,
                hlNormalized,
                hlSent,
                hlToSend,
                hlFallback: firstCall.hlFallback,
                firstError: firstCall.firstError || null,
                fetchError: firstCall.fetchError || null,
                firstFetchError: firstCall.firstFetchError || null,
                status: firstCall?.res?.status ?? 0,
            };
        }

        const { res, data } = firstCall;

        if (!res || !res.ok || data?.error) {
            return jsonResponse(
                {
                    error: "SearchApi google_hotels failed",
                    error_code: "SEARCH_FAILED",
                    status: res?.status ?? 0,
                    details: data?.error || data || null,
                    fetchError: firstCall.fetchError || null,
                    debug: debugSearch,
                },
                502,
                corsHeaders
            );
        }

        const props = data?.properties || [];

        // Derive altQuery from booking slug for improved matching
        const altQuery = bookingSlug ? bookingSlug.replace(/-/g, " ") : "";
        const picked = pickBestProperty(props, hotelName, officialDomain, { altQuery });

        if (!picked?.best?.property_token) {
            return jsonResponse({
                ok: false,
                error: "No property_token found for hotel",
                error_code: "NO_PROPERTY_FOUND",
                hotelName,
                officialDomain: officialDomain || null,
                ctxDebug,
                debug: debugSearch
            }, 404, corsHeaders);
        }

        // Capture candidate summary for uncertain match explanation
        searchCandidateSummary = summarizeCandidates(picked?.allCandidates, 3);

        tokenObj = {
            property_token: picked.best.property_token,
            property_name: picked.best.name || null,
            city: picked.best.city || null,
            country: picked.best.country || null,
            link: picked.best.link || null,
            linkHost: getHostNoWww(picked.best.link || ""),
            score: picked.bestScore,
            nameScore: picked.bestNameScore,
            confidence: picked.confidence,
            domainMatch: picked.bestDomainMatch,
            officialDomain: officialDomain || null,
            matchDetails: picked.matchDetails || null,
            candidateSummary: searchCandidateSummary,
        };

        if (debug) {
            candidatesDebug = picked.allCandidates || [];
        }

        const shouldCache = picked.confidence >= 0.65;

        if (shouldCache) {
            const nameTtl = picked.confidence >= 0.80 ? TOKEN_TTL_SEC : TOKEN_TTL_NO_DOMAIN_SEC;

            ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyName, tokenObj, nameTtl));

            if (tokenKeyDomain && picked.confidence >= 0.75) {
                ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyDomain, tokenObj, TOKEN_TTL_SEC));
            }

            // Cache under booking slug key with slightly lower threshold
            if (tokenKeyBooking && picked.confidence >= 0.70) {
                ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyBooking, tokenObj, TOKEN_TTL_NO_DOMAIN_SEC));
            }
        }
    }

    // ---- Verify lookup fallback for uncertain cached tokens without candidateSummary ----
    // When we have a cached token that's uncertain but missing candidateSummary (old cache entries),
    // make a single google_hotels call to compute the summary and backfill it.
    const earlyMatchConfidence = tokenObj?.confidence ?? tokenObj?.nameScore ?? 0;
    const earlyMatchUncertain = earlyMatchConfidence < 0.65;
    const hasCachedToken = tokenCacheDetail.startsWith("hit-") || tokenCacheDetail === "ctx-hit";
    const needsVerifyLookup = earlyMatchUncertain &&
        !tokenObj?.candidateSummary &&
        !ctxDebug?.ctxCandidateSummary &&
        !searchCandidateSummary &&
        !refresh &&
        hasCachedToken;

    if (needsVerifyLookup) {
        usage.searchapi_calls.google_hotels++;

        const verifyCall = await searchApiCall(env, {
            engine: "google_hotels",
            q: hotelName,
            check_in_date: checkIn,
            check_out_date: checkOut,
            adults,
            currency,
            hl: hlToSend,
            gl,
        });

        if (debugSearch) {
            debugSearch.google_hotels_verify = {
                requestUrl: verifyCall.requestUrl,
                reason: "verify_lookup_for_uncertain_cached_token",
                tokenCacheDetail,
                status: verifyCall?.res?.status ?? 0,
            };
        }

        if (verifyCall?.res?.ok && !verifyCall?.data?.error) {
            const verifyProps = verifyCall.data?.properties || [];
            const altQuery = bookingSlug ? bookingSlug.replace(/-/g, " ") : "";
            const verifyPicked = pickBestProperty(verifyProps, hotelName, officialDomain, { altQuery });

            if (verifyPicked?.allCandidates?.length > 0) {
                const verifySummary = summarizeCandidates(verifyPicked.allCandidates, 3);
                verifySummary._fromVerify = true; // Track source for response
                searchCandidateSummary = verifySummary;

                // Backfill candidateSummary to tokenObj and update KV
                tokenObj.candidateSummary = verifySummary;

                // Re-cache with the updated candidateSummary
                const backfillTtl = tokenKeyDomain ? TOKEN_TTL_SEC : TOKEN_TTL_NO_DOMAIN_SEC;
                if (tokenCacheDetail === "hit-domain" && tokenKeyDomain) {
                    ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyDomain, tokenObj, TOKEN_TTL_SEC));
                } else if (tokenCacheDetail === "hit-booking" && tokenKeyBooking) {
                    ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyBooking, tokenObj, TOKEN_TTL_NO_DOMAIN_SEC));
                } else if (tokenCacheDetail === "hit-name") {
                    ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyName, tokenObj, backfillTtl));
                }
            }
        }
    }

    const propertyToken = tokenObj.property_token;

    // ---- 2) Offers cache ----
    const hlCacheKey = hlToSend || "nohl";
    const roomsCacheKey = includeRooms ? ":r1" : "";
    const offersKey = `offers:${propertyToken}:${checkIn}:${checkOut}:${adults}:${currency}:${gl}:${hlCacheKey}${roomsCacheKey}`;
    const cached = (!refresh && !debug) ? await kvGetJson(env.CACHE_KV, offersKey) : null;

    if (cached) {
        const servedAt = new Date().toISOString();

        const hydrated = {
            ...cached,
            cache: "hit",
            servedAt,
            query: {
                hotelName,
                checkIn,
                checkOut,
                adults,
                currency,
                gl,
                hl: hlSent || null,
                hlSentToApi: hlToSend || null,
                officialDomain: officialDomain || null,
                currentHost: currentHost || null,
            },
            match: (() => {
                const matchConfidence = tokenObj?.confidence ?? tokenObj?.nameScore ?? 0;
                const matchUncertain = matchConfidence < 0.65;

                // Select candidate summary source in priority order
                let candidateSummary = null;
                let candidateSummarySource = null;
                if (matchUncertain) {
                    if (ctxDebug?.ctxCandidateSummary) {
                        candidateSummary = ctxDebug.ctxCandidateSummary;
                        candidateSummarySource = "ctx";
                    } else if (tokenObj?.candidateSummary) {
                        candidateSummary = tokenObj.candidateSummary;
                        candidateSummarySource = "token";
                    }
                }

                return {
                    cacheDetail: { token: tokenCacheDetail, offers: "hit" },
                    tokenCacheKey: tokenKey,
                    tokenKeyName,
                    tokenKeyDomain: tokenKeyDomain || null,
                    matchedBy: tokenObj?.domainMatch ? "officialDomain" : "name",
                    confidence: matchConfidence,
                    matchedHotelName: tokenObj?.property_name || null,
                    nameScore: tokenObj?.nameScore ?? null,
                    domainMatch: tokenObj?.domainMatch ?? null,
                    linkHost: tokenObj?.linkHost || null,
                    matchDetails: tokenObj?.matchDetails || null,
                    ...ctxDebug,
                    ...(matchUncertain ? { candidateSummary, candidateSummarySource } : {}),
                };
            })(),
            matchUncertain: (tokenObj?.confidence ?? tokenObj?.nameScore ?? 0) < 0.65,
            usage: { searchapi_calls: { google_hotels: 0, google_hotels_property: 0 } },
        };

        if (debug) {
            hydrated.debug = {
                tokenCacheKey: tokenKey,
                offersCacheKey: offersKey,
                tokenObj,
                tokenValidation,
                candidates: candidatesDebug,
                officialUrl: officialUrl || null,
                officialDomain: officialDomain || null,
                currentHost: currentHost || null,
                hlRaw,
                hlNormalized,
                hlSent,
                hlToSend,
                searchApi: debugSearch,
                cacheHydrated: true,
                badgeDebug: { note: "Raw offers unavailable (served from cache)." },
            };
        }

        return jsonResponse(hydrated, 200, corsHeaders);
    }

    // ---- 3) Fetch property offers ----
    usage.searchapi_calls.google_hotels_property++;

    const propCall = await searchApiCall(env, {
        engine: "google_hotels_property",
        property_token: propertyToken,
        check_in_date: checkIn,
        check_out_date: checkOut,
        adults,
        currency,
        hl: hlToSend,
        gl,
    });

    if (debugSearch) {
        debugSearch.google_hotels_property = {
            requestUrl: propCall.requestUrl,
            hlRaw,
            hlNormalized,
            hlSent,
            hlToSend,
            hlFallback: propCall.hlFallback,
            firstError: propCall.firstError || null,
            fetchError: propCall.fetchError || null,
            firstFetchError: propCall.firstFetchError || null,
            status: propCall?.res?.status ?? 0,
        };
    }

    const { res: propRes, data: propData } = propCall;

    if (!propRes || !propRes.ok || propData?.error) {
        return jsonResponse(
            {
                error: "SearchApi google_hotels_property failed",
                status: propRes?.status ?? 0,
                details: propData?.error || propData || null,
                fetchError: propCall.fetchError || null,
                debug: debugSearch,
            },
            502,
            corsHeaders
        );
    }

    const prop = propData?.property;
    if (!prop) {
        return jsonResponse({ error: "Missing property in response", details: propData, debug: debugSearch }, 502, corsHeaders);
    }

    const rawFeaturedCount = prop.featured_offers?.length || 0;
    const rawAllCount = prop.all_offers?.length || 0;

    const combined = [
        ...(Array.isArray(prop.featured_offers) ? prop.featured_offers : []),
        ...(Array.isArray(prop.all_offers) ? prop.all_offers : []),
    ];
    const combinedCount = combined.length;

    const firstRawOffer = combined[0];
    const firstOfferLink = firstRawOffer?.link || firstRawOffer?.tracking_link || null;
    const badgeDebugInfo = debug && firstRawOffer ? {
        labelExtraction: extractBadges(firstRawOffer, true),
        urlExtraction: extractBadgesFromUrl(firstOfferLink, true),
    } : null;

    const seen = new Set();
    const simplified = [];
    let droppedNoTotal = 0;
    let droppedDedup = 0;
    for (const o of combined) {
        const s = simplifyOffer(o, nights);
        const dedupeKey = `${normalizeOtaKey(s.source)}|${s.total ?? "na"}|${String(s.link || "").slice(0, 80)}`;
        if (seen.has(dedupeKey)) {
            droppedDedup++;
            continue;
        }
        seen.add(dedupeKey);
        if (s.total == null) {
            droppedNoTotal++;
            continue;
        }

        if (includeRooms && Array.isArray(o.rooms) && o.rooms.length > 0) {
            s.rooms = simplifyRooms(o.rooms, nights);
        }

        simplified.push(s);
    }

    simplified.sort((a, b) => (a.total ?? 1e18) - (b.total ?? 1e18));

    const rawCountsDebug = debug ? {
        rawFeaturedCount,
        rawAllCount,
        combinedCount,
        kept: simplified.length,
        droppedNoTotal,
        droppedDedup,
    } : null;

    const sampleRawOfferDebug = debug && combined[0] ? {
        source: combined[0].source,
        total_price: combined[0].total_price,
        price_per_night: combined[0].price_per_night,
        link: combined[0].link,
        tracking_link: combined[0].tracking_link,
    } : null;

    const sampleRooms = Array.isArray(combined[0]?.rooms) ? combined[0].rooms : [];
    const sampleRoomsDebug = debug ? {
        roomsLen: sampleRooms.length,
        roomKeys: sampleRooms[0] ? Object.keys(sampleRooms[0]).slice(0, 60) : [],
        sampleRoom: sampleRooms[0] || null,
    } : null;

    const propKeysDebug = debug ? Object.keys(prop).slice(0, 60) : null;

    const cheapestOverall = simplified[0] || null;
    const cheapestOfficial = simplified.find((o) => o.isOfficial) || null;

    const bookingOffer = findOfferForHost(simplified, "booking.com");
    const currentOtaOffer = currentHost ? findOfferForHost(simplified, currentHost) : null;

    const payload = {
        ok: true,
        cache: "miss",
        fetchedAt: new Date().toISOString(),
        query: {
            hotelName,
            checkIn,
            checkOut,
            adults,
            currency,
            gl,
            hl: hlSent || null,
            hlSentToApi: hlToSend || null,
            officialDomain: officialDomain || null,
            currentHost: currentHost || null,
        },
        nights,
        match: (() => {
            const matchConfidence = tokenObj.confidence ?? tokenObj.nameScore ?? 0;
            const matchUncertain = matchConfidence < 0.65;

            // Select candidate summary source in priority order
            let candidateSummary = null;
            let candidateSummarySource = null;
            if (matchUncertain) {
                if (searchCandidateSummary) {
                    candidateSummary = searchCandidateSummary;
                    candidateSummarySource = searchCandidateSummary._fromVerify ? "verify" : "searchapi";
                    // Clean up internal flag before sending
                    if (candidateSummary._fromVerify) delete candidateSummary._fromVerify;
                } else if (ctxDebug?.ctxCandidateSummary) {
                    candidateSummary = ctxDebug.ctxCandidateSummary;
                    candidateSummarySource = "ctx";
                } else if (tokenObj?.candidateSummary) {
                    candidateSummary = tokenObj.candidateSummary;
                    candidateSummarySource = "token";
                }
            }

            return {
                cacheDetail: { token: tokenCacheDetail, offers: "miss" },
                tokenCacheKey: tokenKey,
                tokenKeyName,
                tokenKeyDomain: tokenKeyDomain || null,
                matchedBy: tokenObj.domainMatch ? "officialDomain" : "name",
                confidence: matchConfidence,
                matchedHotelName: tokenObj.property_name || null,
                nameScore: tokenObj.nameScore ?? null,
                domainMatch: tokenObj.domainMatch ?? null,
                linkHost: tokenObj.linkHost || null,
                matchDetails: tokenObj.matchDetails || null,
                ...ctxDebug,
                ...(matchUncertain ? { candidateSummary, candidateSummarySource } : {}),
            };
        })(),
        matchUncertain: (tokenObj.confidence ?? tokenObj.nameScore ?? 0) < 0.65,
        property: {
            name: prop.name || tokenObj.property_name || hotelName,
            address: prop.address || null,
            phone: prop.phone || null,
            link: prop.link || tokenObj.link || null,
            property_token: propertyToken,
        },
        offersCount: simplified.length,
        offers: simplified.slice(0, MAX_OFFERS_RETURNED),
        cheapestOverall,
        cheapestOfficial,
        currentOtaOffer,
        bookingOffer,
        usage,
        debug: null,
    };

    if (debug) {
        payload.debug = {
            tokenCacheKey: tokenKey,
            offersCacheKey: offersKey,
            tokenObj,
            tokenValidation,
            candidates: candidatesDebug,
            officialUrl: officialUrl || null,
            officialDomain: officialDomain || null,
            currentHost: currentHost || null,
            // Booking smart matching debug
            smart,
            bookingUrl: bookingUrlRaw || null,
            bookingSlug: bookingSlug || null,
            tokenKeyBooking: tokenKeyBooking || null,
            hlRaw,
            hlNormalized,
            hlSent,
            hlToSend,
            searchApi: debugSearch,
            rawCounts: rawCountsDebug,
            sampleRawOffer: sampleRawOfferDebug,
            sampleRooms: sampleRoomsDebug,
            propKeys: propKeysDebug,
            badgeDebug: badgeDebugInfo,
        };
    }

    // Cache: never store debug payloads
    const toCache = { ...payload };
    delete toCache.cache;
    delete toCache.debug;
    ctx.waitUntil(kvPutJson(env.CACHE_KV, offersKey, toCache, OFFERS_TTL_SEC));

    return jsonResponse(payload, 200, corsHeaders);
}
