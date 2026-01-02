/**
 * Email scraping utilities.
 * Extract emails from web pages and score them.
 * 
 * @module lib/emailScrape
 */

import {
    EMAIL_REGEX,
    USER_AGENT,
    MAX_EMAIL_PARSE_BYTES,
    JUNK_DOMAINS,
    BAD_TLDS
} from './constants.js';
import { fetchWithTimeoutSimple } from './http.js';

/**
 * Check if response is parsable for emails.
 * @param {Response} res - Response to check
 * @returns {boolean}
 */
export function isEmailParsableResponse(res) {
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    return (
        ctype.includes("text/html") ||
        ctype.includes("application/xhtml+xml") ||
        ctype.includes("text/plain") ||
        ctype.includes("application/pdf")
    );
}

/**
 * Fetch a page and extract emails.
 * @param {string} url - URL to fetch
 * @param {string} websiteUrl - Base website URL
 * @param {number} timeout - Timeout in ms
 * @param {Object} debugInfo - Debug info object (mutated)
 * @returns {Promise<Object|null>}
 */
export async function fetchEmailsPage(url, websiteUrl, timeout, debugInfo) {
    const res = await fetchWithTimeoutSimple(
        url,
        {
            headers: {
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9,*/*;q=0.1"
            },
            redirect: "follow"
        },
        timeout
    );

    if (!res?.ok || !isEmailParsableResponse(res)) return null;

    const actualUrl = res.url || url;
    if (debugInfo) debugInfo.checked_urls.push(actualUrl);

    const lenHeader = res.headers.get("content-length");
    const len = lenHeader ? parseInt(lenHeader, 10) : null;
    if (len != null && Number.isFinite(len) && len > MAX_EMAIL_PARSE_BYTES) return null;

    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    let bodyText = "";

    if (ctype.includes("application/pdf")) {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_EMAIL_PARSE_BYTES) return null;
        bodyText = new TextDecoder("utf-8").decode(buf);
    } else {
        bodyText = await res.text();
    }

    const emails = bodyText.match(EMAIL_REGEX) || [];
    if (debugInfo && emails.length) debugInfo.email_candidates.push({ url: actualUrl, emails });

    return { url: actualUrl, emails };
}

/**
 * Pick best email from scraped pages.
 * @param {Object[]} pages - Pages with emails
 * @param {string} websiteUrl - Base website URL
 * @param {Object} options - Options
 * @returns {string|null}
 */
export function pickBestEmailFromPages(pages, websiteUrl, { minScore = 5 } = {}) {
    if (!Array.isArray(pages) || pages.length === 0) return null;

    const websiteHost = websiteUrl ? new URL(websiteUrl).hostname.replace(/^www\./i, "") : "";
    const denyDomainFragments = [
        "ingest.sentry.io", "sentry.io", "wixpress.com", "wix.com",
        "cloudflare.com", "example.com", "domain.com", "duckduckgo.com",
        "google.com", "yandex.ru"
    ];

    const bestByEmail = new Map();

    for (const p of pages) {
        const sourceUrl = String(p?.url || "");
        const emails = Array.isArray(p?.emails) ? p.emails : [];

        for (const email of emails) {
            const lower = email.toLowerCase();
            const parts = lower.split("@");
            const local = parts[0] || "";
            const domain = (parts[1] || "").replace(/^www\./, "");
            const tld = domain.split(".").pop() || "";

            let score = 0;

            if (websiteHost && (domain === websiteHost || domain.endsWith("." + websiteHost) || websiteHost.endsWith("." + domain))) {
                score += 100;
            }
            if (/(info|contact|reservation|reservations|booking|reception|frontdesk|hello|stay|office|hallo|halló)/i.test(local)) {
                score += 15;
            }
            if (/contact|kontakt|impressum|reservation|booking/i.test(sourceUrl)) {
                score += 10;
            }
            if (JUNK_DOMAINS.some(j => domain.includes(j))) {
                score -= 500;
            }
            if (/(noreply|no-reply|donotreply|mailer-daemon|postmaster)/i.test(local)) {
                score -= 50;
            }
            if (denyDomainFragments.some(f => domain.includes(f))) {
                score -= 80;
            }
            if (BAD_TLDS.has(tld)) {
                score -= 200;
            }

            const prev = bestByEmail.get(lower);
            if (!prev || score > prev.score) bestByEmail.set(lower, { email, score });
        }
    }

    const scored = [...bestByEmail.values()].sort((a, b) => b.score - a.score);
    return scored[0]?.score >= minScore ? scored[0].email : null;
}
