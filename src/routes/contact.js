/**
 * Contact lookup route handler.
 * Google Places + email scraping.
 *
 * @module routes/contact
 */

import {
    USER_AGENT,
    TIMEOUT_HOME_MS,
    TIMEOUT_PAGE_MS,
    MAX_CONTACT_PAGES,
    CONTACT_HINTS,
    FALLBACK_SEARCH_MAX_PAGES_TO_CRAWL,
} from '../lib/constants.js';
import { jsonResponse, fetchWithTimeout, safeJson, isHtmlResponse } from '../lib/http.js';
import { getHostNoWww } from '../lib/normalize.js';
import { fetchEmailsPage, pickBestEmailFromPages } from '../lib/emailScrape.js';
import {
    getBraveApiKey,
    getGoogleCseKey,
    getGoogleCseCx,
    fallbackSearchUrls,
} from '../lib/fallbackSearch.js';
import {
    extractEmails,
    pickBestEmail,
    pickBestEmailFromBatch,
    makeHostMatcher,
    discoverContactUrls,
    rankContactUrls,
    extractDuckDuckGoResultUrls,
    isSocialOrOta,
    isPlausibleDomain,
    fetchAndExtract,
} from '../lib/contactHelpers.js';

/**
 * Handle contact lookup request (?query=...).
 * @param {Object} ctx - Request context
 * @returns {Promise<Response>}
 */
export async function handleContact({ request, env, ctx, url, corsHeaders }) {
    const query = url.searchParams.get("query");
    const debug = url.searchParams.get("debug") === "1";

    if (!env.GOOGLE_API_KEY) return jsonResponse({ error: "Missing API Key" }, 500, corsHeaders);
    if (!query) return jsonResponse({ error: "Missing query" }, 400, corsHeaders);

    const debugInfo = debug ? { checked_urls: [], email_candidates: [], steps: [] } : null;

    try {
        // --- Step 1: Text Search (Google) ---
        const searchRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": env.GOOGLE_API_KEY,
                "X-Goog-FieldMask": "places.name",
            },
            body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
        });

        const searchData = await safeJson(searchRes);
        if (!searchData?.places?.length) {
            return jsonResponse({ error: "Hotel not found" }, 404, corsHeaders);
        }

        // --- Step 2: Details (Google) ---
        const placeName = searchData.places[0].name;
        const detailsRes = await fetch(`https://places.googleapis.com/v1/${placeName}`, {
            headers: {
                "X-Goog-Api-Key": env.GOOGLE_API_KEY,
                "X-Goog-FieldMask": "websiteUri,internationalPhoneNumber",
            },
        });

        const detailsData = await safeJson(detailsRes);
        let websiteUrl = detailsData?.websiteUri || null;

        // --- Step 2a: Junk Filter (website URL) ---
        if (websiteUrl && isSocialOrOta(websiteUrl)) {
            if (debugInfo) debugInfo.steps.push(`Rejected junk website: ${websiteUrl}`);
            websiteUrl = null;
        }

        // --- Step 2b: Website Recovery (Search API first, DDG as last resort) ---
        if (!websiteUrl) {
            const hasFallbackApi = getBraveApiKey(env) || (getGoogleCseKey(env) && getGoogleCseCx(env));

            if (hasFallbackApi) {
                if (debugInfo) debugInfo.steps.push("Attempting Website Recovery via Search API...");

                const websiteQuery = `${query} official website`;
                const { provider, urls } = await fallbackSearchUrls(env, ctx, websiteQuery, { cacheKeyPrefix: "sf:site" });

                const filtered = urls.filter((u) => !isSocialOrOta(u) && isPlausibleDomain(u, query));
                const recovered = filtered[0] || null;

                if (recovered) {
                    websiteUrl = recovered;
                    if (debugInfo) debugInfo.steps.push(`Recovered website via Search API (${provider || "unknown"}): ${websiteUrl}`);
                } else if (debugInfo) {
                    debugInfo.steps.push(`Search API website recovery (${provider || "unknown"}) returned no plausible site`);
                }
            }

            // DDG HTML as last resort if API didn't work
            if (!websiteUrl) {
                if (debugInfo) debugInfo.steps.push("Attempting Website Recovery via DDG...");

                const ddgQuery = `${query} official website`;
                const ddgRes = await fetchWithTimeout(
                    `https://html.duckduckgo.com/html?q=${encodeURIComponent(ddgQuery)}`,
                    { headers: { "User-Agent": USER_AGENT } },
                    TIMEOUT_HOME_MS
                );

                if (ddgRes?.ok) {
                    const ddgHtml = await ddgRes.text();
                    const resultUrls = extractDuckDuckGoResultUrls(ddgHtml, 4);

                    const recoveredUrl = resultUrls.find((u) => {
                        if (isSocialOrOta(u)) return false;
                        return isPlausibleDomain(u, query);
                    });

                    if (recoveredUrl) {
                        websiteUrl = recoveredUrl;
                        if (debugInfo) debugInfo.steps.push(`Recovered and verified website via DDG: ${websiteUrl}`);
                    }
                }
            }
        }

        const result = {
            website: websiteUrl,
            phone: detailsData?.internationalPhoneNumber || null,
            found_email: null,
        };

        // --- Step 3: Deep Dive (Scrape the Website) ---
        if (result.website) {
            const homeRes = await fetchWithTimeout(
                result.website,
                {
                    headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" },
                    redirect: "follow",
                },
                TIMEOUT_HOME_MS
            );

            if (homeRes?.ok && isHtmlResponse(homeRes)) {
                const finalUrl = homeRes.url || result.website;
                const html = await homeRes.text();

                if (debugInfo) debugInfo.checked_urls.push(finalUrl);

                const emails = extractEmails(html);
                if (debugInfo && emails.length) debugInfo.email_candidates.push({ url: finalUrl, emails });

                result.found_email = pickBestEmail(emails, finalUrl, finalUrl, { minScore: 5 });

                // B. Parallel Crawl of Contact Pages
                if (!result.found_email) {
                    const hostMatches = makeHostMatcher(finalUrl);
                    const discovered = discoverContactUrls(html, finalUrl).filter((u) => hostMatches(u));
                    const contactUrls = rankContactUrls(discovered).slice(0, MAX_CONTACT_PAGES);

                    if (contactUrls.length > 0) {
                        const pagePromises = contactUrls.map((u) => fetchAndExtract(u, finalUrl, TIMEOUT_PAGE_MS, debugInfo));
                        const pageResults = await Promise.all(pagePromises);

                        const bestOfBatch = pickBestEmailFromBatch(pageResults.filter((r) => r !== null));
                        if (bestOfBatch) result.found_email = bestOfBatch;
                    }
                }
            }
        }

        // --- Step 3c: Site-Search Fallback (if website known but no email yet) ---
        if (!result.found_email && result.website) {
            const hasFallbackApi = getBraveApiKey(env) || (getGoogleCseKey(env) && getGoogleCseCx(env));

            if (hasFallbackApi) {
                const host = getHostNoWww(result.website);
                if (host) {
                    if (debugInfo) debugInfo.steps.push(`Attempting site-search fallback for ${host}...`);

                    const siteQuery = `site:${host} (contact OR kontakt OR impressum OR reservation OR booking) (email OR mailto)`;
                    const { provider, urls } = await fallbackSearchUrls(env, ctx, siteQuery, { cacheKeyPrefix: `sf:in:${host}` });

                    const hostMatches = makeHostMatcher(result.website);
                    const candidateUrls = rankContactUrls(urls.filter((u) => hostMatches(u) && !isSocialOrOta(u))).slice(0, FALLBACK_SEARCH_MAX_PAGES_TO_CRAWL);

                    if (candidateUrls.length) {
                        const pages = (await Promise.all(candidateUrls.map((u) => fetchEmailsPage(u, result.website, TIMEOUT_PAGE_MS, debugInfo)))).filter(Boolean);
                        const best = pickBestEmailFromPages(pages, result.website, { minScore: 5 });

                        if (best) {
                            result.found_email = best;
                            if (debugInfo) debugInfo.steps.push(`Found email via site-search fallback (${provider || "unknown"}): ${best}`);
                        }
                    }
                }
            }
        }

        // --- Step 4: Global-Search Fallback (URL-first, then crawl) ---
        if (!result.found_email) {
            const hasFallbackApi = getBraveApiKey(env) || (getGoogleCseKey(env) && getGoogleCseCx(env));

            if (hasFallbackApi) {
                if (debugInfo) debugInfo.steps.push("Attempting global-search fallback...");

                const globalQuery = `${query} email contact`;
                const { provider, urls } = await fallbackSearchUrls(env, ctx, globalQuery, { cacheKeyPrefix: "sf:global", cacheTtlSec: 24 * 60 * 60 });

                const officialHost = getHostNoWww(result.website || "");
                const hostMatches = officialHost ? makeHostMatcher("https://" + officialHost) : null;

                const scored = [];
                for (const u of urls) {
                    if (isSocialOrOta(u)) continue;

                    let pts = 0;
                    if (hostMatches && hostMatches(u)) pts += 200;
                    if (isPlausibleDomain(u, query)) pts += 30;

                    const low = u.toLowerCase();
                    if (CONTACT_HINTS.some((h) => low.includes(h))) pts += 50;

                    scored.push({ u, pts });
                }

                scored.sort((a, b) => b.pts - a.pts);
                const candidateUrls = scored.map((x) => x.u).slice(0, FALLBACK_SEARCH_MAX_PAGES_TO_CRAWL);

                if (candidateUrls.length) {
                    const pages = (await Promise.all(candidateUrls.map((u) => fetchEmailsPage(u, result.website || "", TIMEOUT_PAGE_MS, debugInfo)))).filter(Boolean);
                    const best = pickBestEmailFromPages(pages, result.website || "", { minScore: 5 });

                    if (best) {
                        result.found_email = best;
                        if (debugInfo) debugInfo.steps.push(`Found email via global-search fallback (${provider || "unknown"}): ${best}`);
                    }
                }
            }
        }

        // --- Step 5: Last Resort Fallback (DDG snippet scraping) ---
        if (!result.found_email) {
            const ddgQuery = `${query} email contact address`;

            if (debugInfo) debugInfo.steps.push(`Final DDG Global Email Search: ${ddgQuery}`);

            const ddgRes = await fetchWithTimeout(
                `https://html.duckduckgo.com/html?q=${encodeURIComponent(ddgQuery)}`,
                { headers: { "User-Agent": USER_AGENT } },
                TIMEOUT_HOME_MS
            );

            if (ddgRes?.ok) {
                const ddgHtml = await ddgRes.text();
                const snippetEmails = extractEmails(ddgHtml);

                const snippetBest = pickBestEmail(snippetEmails, result.website || "", "ddg_snippet", { minScore: 5 });

                if (snippetBest) {
                    result.found_email = snippetBest;
                    if (debugInfo) debugInfo.steps.push(`Found email via DDG snippet: ${snippetBest}`);
                }
            }
        }

        if (debugInfo) result.debug = debugInfo;
        return jsonResponse(result, 200, corsHeaders);
    } catch (error) {
        return jsonResponse({ error: error?.message || String(error) }, 500, corsHeaders);
    }
}
