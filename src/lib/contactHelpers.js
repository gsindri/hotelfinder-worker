/**
 * Contact lookup helpers.
 * Email extraction, contact page discovery, DDG scraping.
 * 
 * @module lib/contactHelpers
 */

import {
    EMAIL_REGEX,
    EMAIL_REGEX_ANCHORED,
    JUNK_DOMAINS,
    BAD_TLDS,
    CONTACT_HINTS,
    USER_AGENT,
    TIMEOUT_PAGE_MS
} from './constants.js';
import { fetchWithTimeout, isHtmlResponse, domainMatchesList } from './http.js';
import { getHostNoWww } from './normalize.js';

/**
 * Decode HTML entities.
 * @param {string} str - String to decode
 * @returns {string}
 */
export function decodeHtmlEntities(str) {
    if (!str) return "";
    return String(str)
        .replace(/\u00A0/g, " ")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&commat;|&at;/gi, "@")
        .replace(/&period;|&dot;/gi, ".")
        .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Decode Cloudflare email obfuscation.
 * @param {string} cfHex - Hex string
 * @returns {string|null}
 */
export function decodeCfEmail(cfHex) {
    if (!cfHex || cfHex.length < 4) return null;
    const key = parseInt(cfHex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < cfHex.length; i += 2) {
        const b = parseInt(cfHex.slice(i, i + 2), 16);
        out += String.fromCharCode(b ^ key);
    }
    return out;
}

/**
 * Normalize email address.
 * @param {string} raw - Raw email
 * @returns {string|null}
 */
export function normalizeEmail(raw) {
    if (!raw) return null;
    let e = decodeHtmlEntities(String(raw)).trim();
    e = e.replace(/^mailto:/i, "");
    e = e.replace(/[>\])}.,;:'"]+$/g, "");
    try { e = decodeURIComponent(e); } catch { }
    e = e.trim();

    if (!EMAIL_REGEX_ANCHORED.test(e)) return null;

    const [local, domain] = e.split("@");
    if (!local || !domain || local.length > 64 || domain.length > 255) return null;

    return e;
}

/**
 * Deep collect emails from JSON object.
 * @param {any} node - JSON node
 * @param {string[]} out - Output array
 */
export function deepCollectEmails(node, out) {
    if (!node) return;

    if (typeof node === "string") {
        const matches = node.match(EMAIL_REGEX);
        if (matches) out.push(...matches);
        return;
    }

    if (Array.isArray(node)) {
        node.forEach((v) => deepCollectEmails(v, out));
        return;
    }

    if (typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
            if (k && typeof k === "string" && k.toLowerCase() === "email" && typeof v === "string") {
                out.push(v);
            }
            deepCollectEmails(v, out);
        }
    }
}

/**
 * Extract emails from JSON-LD blocks.
 * @param {string} html - HTML content
 * @returns {string[]}
 */
export function extractEmailsFromJsonLd(html) {
    const out = [];
    const re = /<script[^>]*type=(?:"application\/ld\+json[^"]*"|'application\/ld\+json[^']*'|application\/ld\+json[^\s>]*)(?:[^>]*)>([\s\S]*?)<\/script>/gi;

    let m;
    while ((m = re.exec(html)) !== null) {
        const raw = (m[1] || "").trim();
        if (!raw) continue;
        try {
            const json = JSON.parse(decodeHtmlEntities(raw));
            deepCollectEmails(json, out);
        } catch { }
    }
    return out;
}

/**
 * Extract emails from HTML (comprehensive).
 * @param {string} html - HTML content
 * @returns {string[]}
 */
export function extractEmails(html) {
    const candidates = [];
    let m;

    // Cloudflare obfuscation
    const cfDataRe = /data-cfemail=["']([0-9a-fA-F]+)["']/g;
    while ((m = cfDataRe.exec(html)) !== null) {
        const d = decodeCfEmail(m[1]);
        if (d) candidates.push(d);
    }

    const cfHrefRe = /\/cdn-cgi\/l\/email-protection#([0-9a-fA-F]+)/g;
    while ((m = cfHrefRe.exec(html)) !== null) {
        const d = decodeCfEmail(m[1]);
        if (d) candidates.push(d);
    }

    // mailto:
    const mailtoRe = /href\s*=\s*["']\s*mailto:([^"'>\s]+)\s*["']/gi;
    while ((m = mailtoRe.exec(html)) !== null) {
        const raw = (m[1] || "").split("?")[0];
        raw.split(/[;,]/g).forEach((part) => candidates.push(decodeHtmlEntities(part)));
    }

    // JSON-LD
    candidates.push(...extractEmailsFromJsonLd(html));

    // decode entities/unicode for text scanning
    const decoded = decodeHtmlEntities(html);

    // spaced @ (info @ hotel.com)
    const spacedAtRe = /([a-z0-9._%+-]+)\s*@\s*([a-z0-9.-]+\.[a-z]{2,24})/gi;
    while ((m = spacedAtRe.exec(decoded)) !== null) candidates.push(`${m[1]}@${m[2]}`);

    // (at) (dot)
    const obfAtDotRe = /([a-z0-9._%+-]+)\s*(?:\(|\[|\{)?\s*at\s*(?:\)|\]|\})?\s*([a-z0-9.-]+)\s*(?:\(|\[|\{)?\s*dot\s*(?:\)|\]|\})?\s*([a-z]{2,24})/gi;
    while ((m = obfAtDotRe.exec(decoded)) !== null) candidates.push(`${m[1]}@${m[2]}.${m[3]}`);

    // (at) domain.com (at-only)
    const obfAtOnlyRe = /([a-z0-9._%+-]+)\s*(?:\(|\[|\{)?\s*at\s*(?:\)|\]|\})?\s*([a-z0-9.-]+\.[a-z]{2,24})/gi;
    while ((m = obfAtOnlyRe.exec(decoded)) !== null) candidates.push(`${m[1]}@${m[2]}`);

    // raw regex scan
    const rawMatches = decoded.match(EMAIL_REGEX);
    if (rawMatches) candidates.push(...rawMatches);

    // normalize + dedupe
    const out = [];
    const seen = new Set();
    for (const c of candidates) {
        const n = normalizeEmail(c);
        if (!n) continue;
        const k = n.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(n);
    }
    return out;
}

/**
 * Pick best email with scoring.
 * @param {string[]} emails - Candidate emails
 * @param {string} websiteUrl - Website URL
 * @param {string} sourceUrl - Source URL
 * @param {Object} options - Options
 * @returns {string|null}
 */
export function pickBestEmail(emails, websiteUrl, sourceUrl = "", { minScore = 10 } = {}) {
    if (!emails?.length) return null;

    const websiteHost = getHostNoWww(websiteUrl);

    const denyDomainFragments = [
        "ingest.sentry.io", "sentry.io",
        "wixpress.com", "wix.com",
        "cloudflare.com",
        "example.com", "domain.com",
        "duckduckgo.com",
        "google.com",
        "yandex.ru",
    ];

    const scored = emails
        .map((email) => {
            const lower = email.toLowerCase();
            const parts = lower.split("@");
            const local = parts[0] || "";
            const domain = (parts[1] || "").replace(/^www\./, "");
            const tld = domain.split(".").pop() || "";

            let score = 0;

            if (
                websiteHost &&
                (domain === websiteHost || domain.endsWith("." + websiteHost) || websiteHost.endsWith("." + domain))
            ) {
                score += 100;
            }

            if (/(info|contact|reservation|reservations|booking|reception|frontdesk|hello|stay|office|hallo|halló)/i.test(local)) {
                score += 15;
            }

            if (/contact|kontakt|impressum|reservation|booking/i.test(sourceUrl)) {
                score += 10;
            }

            if (domainMatchesList(domain, JUNK_DOMAINS)) {
                score -= 500;
            }

            if (/(noreply|no-reply|donotreply|mailer-daemon|postmaster)/i.test(local)) {
                score -= 50;
            }

            if (denyDomainFragments.some((f) => domain.includes(f))) {
                score -= 80;
            }

            if (BAD_TLDS.has(tld)) {
                score -= 200;
            }

            return { email, score };
        })
        .sort((a, b) => b.score - a.score);

    return scored[0]?.score >= minScore ? scored[0].email : null;
}

/**
 * Pick first email from batch.
 * @param {string[]} emailList - List of emails
 * @returns {string|null}
 */
export function pickBestEmailFromBatch(emailList) {
    return emailList[0] || null;
}

/**
 * Create host matcher function.
 * @param {string} websiteUrl - Website URL
 * @returns {Function}
 */
export function makeHostMatcher(websiteUrl) {
    const baseHost = getHostNoWww(websiteUrl);
    return function hostMatches(urlStr) {
        try {
            const h = new URL(urlStr).hostname.replace(/^www\./, "").toLowerCase();
            return baseHost && (h === baseHost || h.endsWith("." + baseHost) || baseHost.endsWith("." + h));
        } catch {
            return false;
        }
    };
}

/**
 * Discover contact URLs from HTML.
 * @param {string} html - HTML content
 * @param {string} baseUrl - Base URL
 * @returns {string[]}
 */
export function discoverContactUrls(html, baseUrl) {
    let base;
    try { base = new URL(baseUrl); } catch { return []; }

    const hostMatches = makeHostMatcher(base.href);
    const discovered = [];
    const guessed = [];

    const aRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;

    while ((m = aRe.exec(html)) !== null) {
        const href = (m[1] || "").trim();
        if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;

        let abs;
        try { abs = new URL(href, base); } catch { continue; }
        if (!hostMatches(abs.href)) continue;

        const text = (m[2] || "").replace(/<[^>]+>/g, " ");
        const hay = (href + " " + text).toLowerCase();

        if (CONTACT_HINTS.some((h) => hay.includes(h))) discovered.push(abs.href);
    }

    for (const hint of CONTACT_HINTS) guessed.push(new URL(`/${hint}`, base.origin).href);

    return [...new Set([...discovered, ...guessed])];
}

/**
 * Rank contact URLs by relevance.
 * @param {string[]} urls - URLs to rank
 * @returns {string[]}
 */
export function rankContactUrls(urls) {
    function score(u) {
        const s = u.toLowerCase();
        let pts = 0;
        if (s.includes("contact") || s.includes("kontakt") || s.includes("contatti") || s.includes("contacto") || s.includes("contactez") || s.includes("contato")) pts += 100;
        if (s.includes("reservation") || s.includes("booking") || s.includes("/book")) pts += 80;
        if (s.includes("reception") || s.includes("frontdesk") || s.includes("front-desk")) pts += 70;
        if (s.includes("impressum") || s.includes("legal")) pts += 50;
        if (s.includes("privacy") || s.includes("gdpr")) pts += 40;
        if (s.includes("about")) pts += 10;
        return pts;
    }
    return [...urls].sort((a, b) => score(b) - score(a));
}

/**
 * Extract URLs from DuckDuckGo HTML results.
 * @param {string} ddgHtml - DDG HTML content
 * @param {number} max - Max URLs to extract
 * @returns {string[]}
 */
export function extractDuckDuckGoResultUrls(ddgHtml, max = 3) {
    const urls = [];
    const seen = new Set();

    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"/gi;
    let m;

    while ((m = re.exec(ddgHtml)) !== null && urls.length < max) {
        let href = (m[1] || "").trim();
        if (!href) continue;

        try {
            const u = new URL(href, "https://duckduckgo.com");
            const uddg = u.searchParams.get("uddg");
            href = uddg ? decodeURIComponent(uddg) : u.href;
        } catch { }

        if (!/^https?:\/\//i.test(href)) continue;

        const key = href.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(href);
    }

    return urls;
}

/**
 * Check if URL is social or OTA.
 * @param {string} urlStr - URL to check
 * @returns {boolean}
 */
export function isSocialOrOta(urlStr) {
    try {
        const hostname = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, "");
        return domainMatchesList(hostname, JUNK_DOMAINS);
    } catch {
        return false;
    }
}

/**
 * Check if domain is plausible for query.
 * @param {string} urlStr - URL to check
 * @param {string} query - Search query
 * @returns {boolean}
 */
export function isPlausibleDomain(urlStr, query) {
    try {
        const host = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, "");
        const qLower = query.toLowerCase().replace(/[^a-z0-9]+/g, "");
        const hostClean = host.replace(/[^a-z0-9]/g, "");
        // Simple heuristic: at least 3 chars of query appear in host
        return qLower.length >= 3 && hostClean.includes(qLower.slice(0, 6));
    } catch {
        return false;
    }
}

/**
 * Fetch page and extract best email.
 * @param {string} url - URL to fetch
 * @param {string} websiteUrl - Website URL
 * @param {number} timeout - Timeout in ms
 * @param {Object} debugInfo - Debug info object
 * @returns {Promise<string|null>}
 */
export async function fetchAndExtract(url, websiteUrl, timeout, debugInfo) {
    const res = await fetchWithTimeout(
        url,
        {
            headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" },
            redirect: "follow",
        },
        timeout
    );

    if (!res?.ok || !isHtmlResponse(res)) return null;

    const actualUrl = res.url || url;
    if (debugInfo) debugInfo.checked_urls.push(actualUrl);

    const html = await res.text();
    const emails = extractEmails(html);

    if (debugInfo && emails.length) debugInfo.email_candidates.push({ url: actualUrl, emails });

    return pickBestEmail(emails, websiteUrl, actualUrl, { minScore: 5 });
}
