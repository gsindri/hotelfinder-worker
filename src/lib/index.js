/**
 * Lib barrel export.
 * Re-exports all lib modules for convenient importing.
 * 
 * @module lib
 */

// Constants
export * from './constants.js';

// HTTP utilities
export { jsonResponse, fetchWithTimeout, fetchWithTimeoutSimple, safeJson, isHtmlResponse, domainMatchesList } from './http.js';

// KV cache
export { kvGetJson, kvPutJson } from './kvCache.js';

// CORS
export { normalizeOrigin, parseAllowedOriginsCsv, getCompareAllowedOrigins, buildCompareCors, buildPublicCors } from './cors.js';

// Rate limiting
export { getClientIp, rateLimitCompare, rateLimitPrefetch } from './rateLimit.js';

// Normalization
export { isIsoDate, normalizeCurrencyParam, nightsBetweenIso, normalizeHl, normalizeTravelHl, normalizeKey, parseMoneyToNumber, getHostNoWww } from './normalize.js';

// Matching
export { tokenizeName, normalizeForIncludes, extractStrictBrands, extractKeyTokens, stripTrailingLocationSuffix, hasAnyOverlap, scoreNameMatchDetailed, scoreNameMatch, domainsEquivalent, computeDomainBoost, computeConfidence, validateCachedToken, pickBestProperty } from './matching.js';

// SearchApi
export { searchApiErrorText, isHlParamError, searchApiCall } from './searchApi.js';

// Offers
export { extractBadges, extractBadgesFromUrl, simplifyRoom, simplifyRooms, simplifyOffer, normalizeOtaKey, buildOtaAliasesFromHost, findOfferForHost, computeCtxId } from './offers.js';

// Fallback search
export { cleanSearchResultUrl, dedupeUrls, getBraveApiKey, getGoogleCseKey, getGoogleCseCx, braveSearchUrlsDetailed, googleCseUrlsDetailed, preferredFallbackProvider, fallbackSearchUrls } from './fallbackSearch.js';

// Email scrape
export { isEmailParsableResponse, fetchEmailsPage, pickBestEmailFromPages } from './emailScrape.js';

// Contact helpers
export {
    decodeHtmlEntities, decodeCfEmail, normalizeEmail, deepCollectEmails, extractEmailsFromJsonLd,
    extractEmails, pickBestEmail, pickBestEmailFromBatch, makeHostMatcher, discoverContactUrls,
    rankContactUrls, extractDuckDuckGoResultUrls, isSocialOrOta, isPlausibleDomain, fetchAndExtract
} from './contactHelpers.js';
