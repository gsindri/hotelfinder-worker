// @ts-nocheck
/**
 * Hotel Direct Contact Worker V14 (/compare hardened + officialUrl matching)
 *
 * Routes:
 *  - /compare : SearchApi (google_hotels + google_hotels_property) with KV caching
 *  - /        : ?query=... (Google Places website/phone + email scraping)
 *
 * REQUIRED ENV / BINDINGS:
 *  - env.GOOGLE_API_KEY
 *  - env.SEARCHAPI_KEY
 *  - env.CACHE_KV (KV Namespace binding)
 *
 * OPTIONAL ENV:
 *  - env.CHROME_EXTENSION_ID or env.COMPARE_ALLOWED_ORIGINS (for /compare CORS allowlist)
 *  - env.COMPARE_ALLOW_LOCALHOST=1 (to allow localhost origins in /compare)
 *
 * Improvements vs V13:
 *  - /compare accepts officialUrl and uses its domain for property_token matching (much more accurate)
 *  - token cache key prefers official domain and no longer fragments by hl
 *  - returns currentOtaOffer when currentHost is provided (Booking/Hotels/Expedia/etc)
 *  - never stores debug payloads in KV cache
 *  - SearchApi fetch has a timeout and clearer error reporting
 *  - /compare allows requests with no Origin header (curl/server-to-server) while still blocking web origins
 */

// ---------- BUILD INFO ----------
const BUILD_TAG = "2025-12-17T03:40Z-search-fallback";

// ---------- CONTACT LOOKUP CONFIG ----------
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}/g;
const EMAIL_REGEX_ANCHORED = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}$/;

const CONTACT_HINTS = [
  "contact", "contact-us", "kontakt", "impressum", "contatti", "contacto", "contato", "contactez",
  "reservation", "reservations", "booking", "book", "reception", "frontdesk", "front-desk",
  "about", "legal", "privacy", "gdpr",
];

// Junk filter for websites + email domains
const JUNK_DOMAINS = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "tiktok.com", "linktr.ee", "carrd.co",
  "booking.com", "agoda.com", "expedia.com", "hotels.com", "tripadvisor.com",
  "trivago.com", "kayak.com", "skyscanner.com", "orbitz.com", "priceline.com",
  "hostelworld.com", "airbnb.com", "vrbo.com", "google.com", "yahoo.com", "bing.com",
  "trip.com", "hotelscombined.com", "momondo.com", "cheapflights.com",
  // competitors/tools / generic builder hosts
  "inn.fan", "site.io", "page.link", "website.com", "business.site", "wixsite.com", "wordpress.com",
];

const BAD_TLDS = new Set([
  "png", "jpg", "jpeg", "svg", "webp", "gif", "css", "js", "ico",
  "woff", "woff2", "ttf", "eot", "map", "mp4", "mp3",
]);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const TIMEOUT_HOME_MS = 6000;
const TIMEOUT_PAGE_MS = 4000;
const MAX_CONTACT_PAGES = 5; // Increased from 3 for better hit-rate on multilingual sites

// ---------- SEARCH API FALLBACK CONFIG ----------
const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const GOOGLE_CSE_ENDPOINT = "https://customsearch.googleapis.com/customsearch/v1";
const FALLBACK_SEARCH_TIMEOUT_MS = 8000;
const FALLBACK_SEARCH_MAX_RESULTS = 8;
const FALLBACK_SEARCH_MAX_PAGES_TO_CRAWL = 5;
const FALLBACK_SEARCH_CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const MAX_EMAIL_PARSE_BYTES = 2 * 1024 * 1024; // 2 MB

// ---------- RATE LIMITING (for /compare only) ----------
const COMPARE_RATE_LIMIT = 60; // requests
const COMPARE_WINDOW_SEC = 60 * 60; // per hour

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// Returns a Response if blocked, or null if allowed
async function rateLimitCompare(request, env, corsHeaders) {
  if (!env.CACHE_KV) {
    return jsonResponse({ error: "Missing CACHE_KV binding" }, 500, corsHeaders);
  }

  const ip = getClientIp(request);
  const now = Date.now();
  const hourBucket = Math.floor(now / 3600000); // changes once per hour
  const key = `rl:compare:${hourBucket}:${ip}`;

  const currentRaw = await env.CACHE_KV.get(key);
  const current = currentRaw ? parseInt(currentRaw, 10) : 0;

  if (current >= COMPARE_RATE_LIMIT) {
    const secondsIntoHour = Math.floor((now % 3600000) / 1000);
    const retryAfter = COMPARE_WINDOW_SEC - secondsIntoHour;

    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        ...corsHeaders,
      },
    });
  }

  // Minimum defense (not perfectly atomic, but enough to stop casual abuse)
  await env.CACHE_KV.put(key, String(current + 1), {
    expirationTtl: COMPARE_WINDOW_SEC + 60,
  });

  return null;
}

// ---------- CORS LOCKDOWN (for /compare only) ----------
// Goal: Only your Chrome extension (or explicit allowlist) can call /compare from the browser.
//
// REQUIRED (set at least ONE):
//  - env.CHROME_EXTENSION_ID = <your extension id>
//      OR
//  - env.COMPARE_ALLOWED_ORIGINS = "chrome-extension://<id>,http://localhost:3000"
//
// Notes:
// - This blocks *browser* use from random websites. Server-to-server abuse is still possible without auth.
// - If your extension calls /compare from a content-script (page context), the Origin will be the website,
//   and it WILL be blocked. Call /compare from your extension background/popup instead.

function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/+$/g, ""); // strip trailing slashes
}

function parseAllowedOriginsCsv(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => normalizeOrigin(s))
    .filter(Boolean);
}

function getCompareAllowedOrigins(env) {
  const allowed = new Set();

  // Comma-separated list of origins
  for (const o of parseAllowedOriginsCsv(env.COMPARE_ALLOWED_ORIGINS || env.ALLOWED_COMPARE_ORIGINS || "")) {
    allowed.add(o);
  }

  // Convenience: set your Chrome extension ID and we build the origin
  const extId = String(env.CHROME_EXTENSION_ID || env.EXTENSION_ID || "").trim();
  if (extId) allowed.add(`chrome-extension://${extId}`);

  // Optional: allow local dev if you want (set COMPARE_ALLOW_LOCALHOST=1)
  if (String(env.COMPARE_ALLOW_LOCALHOST || "").trim() === "1") {
    allowed.add("http://localhost:3000");
    allowed.add("http://localhost:5173");
    allowed.add("http://127.0.0.1:3000");
    allowed.add("http://127.0.0.1:5173");
  }

  return allowed;
}

function buildCompareCors(request, env) {
  const origin = normalizeOrigin(request.headers.get("Origin") || "");
  const allowedOrigins = getCompareAllowedOrigins(env);
  const configured = allowedOrigins.size > 0;

  /** @type {Record<string, string>} */
  const base = {
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Retry-After",
    "Vary": "Origin",
  };

  // If Origin is missing (curl/server-to-server), allow. CORS is a browser concern.
  if (configured && !origin) {
    return {
      configured: true,
      allowed: true,
      origin: null,
      corsHeaders: base,
    };
  }

  if (configured && origin && allowedOrigins.has(origin)) {
    return {
      configured: true,
      allowed: true,
      origin,
      corsHeaders: {
        ...base,
        "Access-Control-Allow-Origin": origin,
      },
    };
  }

  // Not allowed (or not configured) -> omit Allow-Origin
  return {
    configured,
    allowed: false,
    origin: origin || null,
    corsHeaders: base,
  };
}

// ---------- /compare (SearchApi + KV cache) ----------
const SEARCHAPI_ENDPOINT = "https://www.searchapi.io/api/v1/search";
const SEARCHAPI_TIMEOUT_MS = 8000;

const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const TOKEN_TTL_NO_DOMAIN_SEC = 7 * 24 * 60 * 60; // 7 days (fallback caching when official domain is unknown)
const OFFERS_TTL_SEC = 30 * 60; // 30 minutes
const CTX_TTL_SEC = 30 * 60; // 30 minutes (search context - short since it's for active session)
const CTX_RATE_LIMIT = 30; // 30 prefetch calls per hour per IP
const CTX_WINDOW_SEC = 3600; // 1 hour window for rate limit
const MAX_OFFERS_RETURNED = 25;

// Supported Google Travel UI languages (SearchApi list)
// Source: https://www.searchapi.io/docs/parameters/google-travel/hl
const SUPPORTED_TRAVEL_HL = new Set([
  "af", "bs", "ca", "cs", "da", "de", "et",
  "en-GB", "en-US",
  "es", "es-419",
  "eu", "fil", "fr", "gl", "hr", "id", "is", "it", "sw", "lv", "lt", "hu", "ms", "nl", "no", "pl",
  "pt-BR", "pt-PT",
  "ro", "sq", "sk", "sl", "sr-Latn", "fi", "sv", "vi", "tr", "el", "bg", "mk", "mn", "ru", "sr", "uk", "ka",
  "iw", "ur", "ar", "fa", "am", "ne", "mr", "hi", "bn", "pa", "gu", "ta", "te", "kn", "ml", "si", "th", "lo", "km", "ko", "ja",
  "zh-CN", "zh-TW",
]);

function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// --- Shared currency normalization (used by /prefetchCtx and /compare) ---
const SYMBOL_TO_ISO = {
  "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY", "₹": "INR",
  "₩": "KRW", "₽": "RUB", "₪": "ILS", "฿": "THB", "₫": "VND",
};

function normalizeCurrencyParam(raw) {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();

  // Valid ISO 3-letter code?
  if (/^[A-Z]{3}$/.test(s)) return s;

  // Try symbol mapping
  const mapped = SYMBOL_TO_ISO[raw.trim()];
  if (mapped) return mapped;

  return null; // Invalid - will be omitted from SearchApi call
}

function nightsBetweenIso(checkIn, checkOut) {
  // interpret as UTC midnights to avoid timezone surprises
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const diff = Math.round((b - a) / (1000 * 60 * 60 * 24));
  return diff;
}

function normalizeHl(hl) {
  const raw = String(hl || "").trim();
  if (!raw) return "";

  // normalize separators
  const s = raw.replace(/_/g, "-");

  // Plain 2-letter / 3-letter language
  if (/^[a-z]{2,3}$/i.test(s)) return s.toLowerCase();

  // language-REGION: en-US, pt-BR
  let m = s.match(/^([a-z]{2,3})-([a-z]{2})$/i);
  if (m) return `${m[1].toLowerCase()}-${m[2].toUpperCase()}`;

  // language-Script: sr-Latn
  m = s.match(/^([a-z]{2,3})-([a-z]{4})$/i);
  if (m) {
    const script = `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}`;
    return `${m[1].toLowerCase()}-${script}`;
  }

  // language-###: es-419
  m = s.match(/^([a-z]{2,3})-(\d{3})$/i);
  if (m) return `${m[1].toLowerCase()}-${m[2]}`;

  return s;
}

function normalizeTravelHl(rawHl) {
  let n = normalizeHl(rawHl);

  // People often pass "en"; SearchApi's travel list uses en-US / en-GB.
  if (n === "en") n = "en-US";

  // If supported, we can send it. Otherwise, omit hl and let SearchApi default.
  const hlSent = SUPPORTED_TRAVEL_HL.has(n) ? n : undefined;

  // Key should be stable even if we omit (for caching/debugging)
  const hlKey = hlSent || (n ? `raw:${n}` : "default");

  return { hlNormalized: n, hlSent, hlKey };
}

function normalizeKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 120);
}

function parseMoneyToNumber(val) {
  if (val == null) return null;
  if (typeof val === "number" && Number.isFinite(val)) return val;

  const s = String(val);
  // Strip currency symbols/letters; keep digits, dot, comma
  const cleaned = s.replace(/[^\d.,-]/g, "").trim();
  if (!cleaned) return null;

  // Heuristic:
  // - If both "," and "." exist, assume "," is thousands separator -> remove commas
  // - Else if only "," exists, assume it's thousands separator -> remove commas
  let normalized = cleaned;
  if (cleaned.includes(".") && cleaned.includes(",")) normalized = cleaned.replace(/,/g, "");
  else if (!cleaned.includes(".") && cleaned.includes(",")) normalized = cleaned.replace(/,/g, "");

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

async function kvGetJson(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function kvPutJson(kv, key, obj, ttlSec) {
  await kv.put(key, JSON.stringify(obj), { expirationTtl: ttlSec });
}

function tokenizeName(s) {
  const stop = new Set([
    "hotel", "by", "the", "and", "of", "at", "in", "a", "an", "resort", "inn",
    "apartments", "apartment", "suites", "suite", "hostel", "guesthouse",
  ]);
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length > 1 && !stop.has(t));
}

function scoreNameMatch(query, candidate) {
  const qTokens = tokenizeName(query);
  const cTokens = new Set(tokenizeName(candidate));
  if (!qTokens.length) return 0;

  let hit = 0;
  for (const t of qTokens) if (cTokens.has(t)) hit++;

  const coverage = hit / qTokens.length;
  const qNorm = String(query || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const cNorm = String(candidate || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const containsBoost = cNorm.includes(qNorm) && qNorm.length >= 6 ? 0.25 : 0;

  return coverage + containsBoost;
}

function domainsEquivalent(a, b) {
  const da = String(a || "").toLowerCase().replace(/^www\./, "");
  const db = String(b || "").toLowerCase().replace(/^www\./, "");
  if (!da || !db) return false;
  return da === db || da.endsWith("." + db) || db.endsWith("." + da);
}

function pickBestProperty(properties, hotelName, officialDomain) {
  if (!Array.isArray(properties) || properties.length === 0) return null;

  let best = null;
  let bestScore = -1;
  let bestNameScore = 0;
  let bestDomainMatch = false;
  let bestLinkHost = "";

  for (const p of properties) {
    const nameScore = scoreNameMatch(hotelName, p?.name || "");
    const linkHost = getHostNoWww(p?.link || "");
    const domainMatch = officialDomain ? domainsEquivalent(linkHost, officialDomain) : false;
    const score = (domainMatch ? 2.0 : 0) + nameScore;

    if (score > bestScore) {
      bestScore = score;
      best = p;
      bestNameScore = nameScore;
      bestDomainMatch = !!domainMatch;
      bestLinkHost = linkHost;
    }
  }

  return { best, bestScore, bestNameScore, bestDomainMatch, bestLinkHost };
}

function searchApiErrorText(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.message === "string") return data.message;
  try { return JSON.stringify(data); } catch { return String(data); }
}

function isHlParamError(data) {
  const msg = searchApiErrorText(data).toLowerCase();
  return msg.includes("hl") && (msg.includes("unsupported") || msg.includes("invalid") || msg.includes("parameter"));
}

async function searchApiCall(env, params) {
  const doCall = async (p) => {
    const u = new URL(SEARCHAPI_ENDPOINT);
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, String(v));
    }

    const res = await fetchWithTimeout(
      u.toString(),
      {
        headers: {
          "Authorization": `Bearer ${env.SEARCHAPI_KEY}`,
          "Accept": "application/json",
        },
      },
      SEARCHAPI_TIMEOUT_MS
    );

    if (!res) {
      return { res: null, data: null, requestUrl: u.toString(), fetchError: "timeout_or_network_error" };
    }

    const data = await safeJson(res);
    return { res, data, requestUrl: u.toString(), fetchError: null };
  };

  // 1) Normal attempt
  let out = await doCall(params);

  // 2) If SearchApi rejects hl, retry once without hl
  if (out?.res?.status === 400 && params?.hl && isHlParamError(out.data)) {
    const p2 = { ...params };
    delete p2.hl;
    const retry = await doCall(p2);
    return { ...retry, hlFallback: true, firstError: out.data, firstFetchError: out.fetchError || null };
  }

  return { ...out, hlFallback: false };
}

function simplifyOffer(o, nights) {
  const link = o?.link || o?.tracking_link || null;

  // Some SearchApi/Google Hotels results only provide "before_taxes" fields.
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

  // Canonical total:
  // 1) extracted_price
  // 2) extracted_price_before_taxes
  // 3) parse from price / price_before_taxes
  // 4) per-night * nights
  let total = totalExtracted;
  if (total == null) total = parseMoneyToNumber(totalText);
  if (total == null && beforeTax != null) total = beforeTax;
  if (total == null && perNightExtracted != null && nights) total = perNightExtracted * nights;

  return {
    source: o?.source || null,
    isOfficial: o?.is_official === true,

    // total is what you sort/display by (may be before-tax when that's all we get)
    total,
    totalText,

    // keep explicit before-tax fields too (useful for UI labeling later)
    beforeTax,
    beforeTaxText,

    perNight: perNightExtracted ?? parseMoneyToNumber(perNightText),
    perNightText,

    link,

    // Optional hint for the UI (won't break anything if ignored)
    totalIsBeforeTax:
      o?.total_price?.extracted_price == null &&
      o?.total_price?.price == null &&
      beforeTax != null,
  };
}

function normalizeOtaKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "");
}

function buildOtaAliasesFromHost(host) {
  const key = normalizeOtaKey(host);
  const out = new Set();
  if (!key) return out;

  out.add(key);

  // Common "remove TLD" style aliasing
  if (key.endsWith("com")) out.add(key.slice(0, -3));
  if (key.endsWith("net")) out.add(key.slice(0, -3));
  if (key.endsWith("org")) out.add(key.slice(0, -3));

  // Known brand exceptions (sources may omit ".com")
  if (key === "expediacom") out.add("expedia");
  if (key === "hotelscom") out.add("hotels");
  if (key === "bookingcom") out.add("booking");
  if (key === "agodacom") out.add("agoda");
  if (key === "tripcom") out.add("trip");
  if (key === "pricelinecom") out.add("priceline");

  return out;
}

function findOfferForHost(offers, host) {
  if (!host || !Array.isArray(offers) || offers.length === 0) return null;
  const aliases = buildOtaAliasesFromHost(host);
  if (!aliases.size) return null;

  // 1) Exact-ish match
  for (const o of offers) {
    const sk = normalizeOtaKey(o?.source);
    if (aliases.has(sk)) return o;
  }

  // 2) Substring match (backup)
  for (const o of offers) {
    const sk = normalizeOtaKey(o?.source);
    for (const a of aliases) {
      if (a && sk.includes(a)) return o;
    }
  }

  return null;
}

// ---------- SEARCH CONTEXT (CTX) HELPERS ----------

// Compute ctxId from normalized search params
function computeCtxId(gl, hlKey, q, checkIn, checkOut, adults, currency) {
  // Simple stable hash: join normalized values
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
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

// Rate limit for /prefetchCtx - returns Response if blocked, null if allowed
async function rateLimitPrefetch(request, env, corsHeaders) {
  if (!env.CACHE_KV) {
    return jsonResponse({ error: "Missing CACHE_KV binding" }, 500, corsHeaders);
  }

  const ip = getClientIp(request);
  const now = Date.now();
  const hourBucket = Math.floor(now / 3600000);
  const key = `rl:prefetch:${hourBucket}:${ip}`;

  const currentRaw = await env.CACHE_KV.get(key);
  const current = currentRaw ? parseInt(currentRaw, 10) : 0;

  if (current >= CTX_RATE_LIMIT) {
    const secondsIntoHour = Math.floor((now % 3600000) / 1000);
    const retryAfter = CTX_WINDOW_SEC - secondsIntoHour;

    return new Response(JSON.stringify({ error: "Prefetch rate limit exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        ...corsHeaders,
      },
    });
  }

  // Increment
  await env.CACHE_KV.put(key, String(current + 1), {
    expirationTtl: CTX_WINDOW_SEC + 60,
  });

  return null;
}

// ---------- SEARCH API FALLBACK HELPERS ----------

function cleanSearchResultUrl(urlStr) {
  const raw = String(urlStr || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    try {
      const u = new URL("https://" + raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      u.hash = "";
      return u.toString();
    } catch {
      return null;
    }
  }
}

function dedupeUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const u of Array.isArray(urls) ? urls : []) {
    const cleaned = cleanSearchResultUrl(u);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function getBraveApiKey(env) {
  return env.BRAVE_SEARCH_API_KEY || env.BRAVE_API_KEY || env.BRAVE_KEY || "";
}

function getGoogleCseKey(env) {
  return env.GOOGLE_CSE_API_KEY || env.GOOGLE_CSE_KEY || "";
}

function getGoogleCseCx(env) {
  return env.GOOGLE_CSE_CX || env.GOOGLE_CSE_ID || env.GOOGLE_CSE_ENGINE_ID || "";
}

async function fetchWithTimeoutSimple(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (e) {
    clearTimeout(timeoutId);
    return null;
  }
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function braveSearchUrlsDetailed(env, q, count) {
  const key = getBraveApiKey(env);
  if (!key) return { provider: null, urls: [] };

  const u = new URL(BRAVE_SEARCH_ENDPOINT);
  u.searchParams.set("q", q);
  u.searchParams.set("count", String(Math.min(20, Math.max(1, count || FALLBACK_SEARCH_MAX_RESULTS))));

  const res = await fetchWithTimeoutSimple(
    u.toString(),
    {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": key
      }
    },
    FALLBACK_SEARCH_TIMEOUT_MS
  );

  if (!res?.ok) return { provider: "brave", urls: [] };

  const data = await safeJson(res);
  const results = data?.web?.results;
  const urls = [];
  if (Array.isArray(results)) {
    for (const r of results) {
      const link = r?.url || r?.link || r?.profile?.url;
      if (typeof link === "string") urls.push(link);
    }
  }
  return { provider: "brave", urls: dedupeUrls(urls) };
}

async function googleCseUrlsDetailed(env, q, count) {
  const key = getGoogleCseKey(env);
  const cx = getGoogleCseCx(env);
  if (!key || !cx) return { provider: null, urls: [] };

  const u = new URL(GOOGLE_CSE_ENDPOINT);
  u.searchParams.set("key", key);
  u.searchParams.set("cx", cx);
  u.searchParams.set("q", q);
  u.searchParams.set("num", String(Math.min(10, Math.max(1, count || FALLBACK_SEARCH_MAX_RESULTS))));

  const res = await fetchWithTimeoutSimple(
    u.toString(),
    { headers: { "Accept": "application/json" } },
    FALLBACK_SEARCH_TIMEOUT_MS
  );

  if (!res?.ok) return { provider: "google_cse", urls: [] };

  const data = await safeJson(res);
  const items = data?.items;
  const urls = [];
  if (Array.isArray(items)) {
    for (const it of items) {
      if (typeof it?.link === "string") urls.push(it.link);
    }
  }
  return { provider: "google_cse", urls: dedupeUrls(urls) };
}

function preferredFallbackProvider(env) {
  const p = String(env.SEARCH_FALLBACK_PROVIDER || "").toLowerCase().trim();
  if (p === "google" || p === "cse" || p === "google_cse") return "google";
  if (p === "brave") return "brave";
  return "brave"; // default
}

async function fallbackSearchUrls(env, ctx, q, { count = FALLBACK_SEARCH_MAX_RESULTS, cacheKeyPrefix = "sf", cacheTtlSec = FALLBACK_SEARCH_CACHE_TTL_SEC } = {}) {
  const cacheKey = `${cacheKeyPrefix}:${normalizeKey(q)}`;

  if (env.CACHE_KV) {
    const cached = await kvGetJson(env.CACHE_KV, cacheKey);
    if (cached?.urls && Array.isArray(cached.urls) && cached.urls.length) {
      return { provider: cached.provider || null, urls: cached.urls, cache: "hit" };
    }
  }

  const prefer = preferredFallbackProvider(env);
  let out = { provider: null, urls: [] };

  if (prefer === "google") {
    out = await googleCseUrlsDetailed(env, q, count);
    if (!out.urls.length) out = await braveSearchUrlsDetailed(env, q, count);
  } else {
    out = await braveSearchUrlsDetailed(env, q, count);
    if (!out.urls.length) out = await googleCseUrlsDetailed(env, q, count);
  }

  if (env.CACHE_KV && out.urls.length) {
    ctx.waitUntil(kvPutJson(env.CACHE_KV, cacheKey, { provider: out.provider, urls: out.urls }, cacheTtlSec));
  }

  return { ...out, cache: "miss" };
}

function isEmailParsableResponse(res) {
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  return (
    ctype.includes("text/html") ||
    ctype.includes("application/xhtml+xml") ||
    ctype.includes("text/plain") ||
    ctype.includes("application/pdf")
  );
}

async function fetchEmailsPage(url, websiteUrl, timeout, debugInfo) {
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

function pickBestEmailFromPages(pages, websiteUrl, { minScore = 5 } = {}) {
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

// ---------- WORKER ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isCompare = url.pathname === "/compare";

    // Open CORS for the contact lookup route
    const publicCorsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Expose-Headers": "Retry-After",
    };

    // Locked CORS for /compare (only your extension / allowlist)
    let corsHeaders = publicCorsHeaders;
    let compareCors = null;

    if (isCompare) {
      compareCors = buildCompareCors(request, env);
      corsHeaders = compareCors.corsHeaders;
    }

    if (request.method === "OPTIONS") {
      // Preflight
      if (isCompare) {
        // Fail closed if not configured or not allowed
        if (!compareCors?.configured) return new Response(null, { status: 403, headers: corsHeaders });
        if (!compareCors?.allowed) return new Response(null, { status: 403, headers: corsHeaders });

        return new Response(null, {
          status: 204,
          headers: { ...corsHeaders, "Access-Control-Max-Age": "86400" },
        });
      }

      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders, "Access-Control-Max-Age": "86400" },
      });
    }

    // =========================
    // /__version route (build info)
    // =========================
    if (url.pathname === "/__version") {
      return new Response(JSON.stringify({ build: BUILD_TAG }), {
        headers: { "content-type": "application/json" }
      });
    }

    // =========================
    // /prefetchCtx route (Search Context prefetch)
    // =========================
    if (url.pathname === "/prefetchCtx") {
      // Use same CORS as /compare (extension-only)
      const prefetchCors = buildCompareCors(request, env);
      const prefetchHeaders = prefetchCors.corsHeaders;

      // Handle OPTIONS
      if (request.method === "OPTIONS") {
        if (!prefetchCors?.configured || !prefetchCors?.allowed) {
          return new Response(null, { status: 403, headers: prefetchHeaders });
        }
        return new Response(null, {
          status: 204,
          headers: { ...prefetchHeaders, "Access-Control-Max-Age": "86400" },
        });
      }

      // CORS check
      if (!prefetchCors?.configured) {
        return jsonResponse({ error: "Prefetch CORS not configured" }, 500, prefetchHeaders);
      }
      if (!prefetchCors?.allowed) {
        return jsonResponse({ error: "Origin not allowed" }, 403, prefetchHeaders);
      }

      // Env checks (explicit errors for missing bindings)
      if (!env.SEARCHAPI_KEY) {
        return jsonResponse({ error: "Missing SEARCHAPI_KEY binding" }, 500, prefetchHeaders);
      }
      if (!env.CACHE_KV) {
        return jsonResponse({ error: "Missing CACHE_KV binding" }, 500, prefetchHeaders);
      }

      // Parse params
      const q = (url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
      const checkIn = url.searchParams.get("checkIn") || "";
      const checkOut = url.searchParams.get("checkOut") || "";
      const adultsRaw = parseInt(url.searchParams.get("adults") || "2", 10);
      const adults = Math.max(1, Math.min(10, adultsRaw || 2));
      const currencyRaw = url.searchParams.get("currency") || "";
      const currency = normalizeCurrencyParam(currencyRaw) || "USD";
      const gl = (url.searchParams.get("gl") || "us").toLowerCase();
      const hlRaw = url.searchParams.get("hl") || "";
      const { hlKey, hlSent } = normalizeTravelHl(hlRaw);

      // Validate required params
      const missing = [];
      if (!q) missing.push("q");
      if (!checkIn) missing.push("checkIn");
      if (!checkOut) missing.push("checkOut");
      if (missing.length) {
        return jsonResponse({ error: "Missing required params", missing }, 400, prefetchHeaders);
      }

      if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
        return jsonResponse({ error: "Dates must be YYYY-MM-DD", checkIn, checkOut }, 400, prefetchHeaders);
      }

      // Compute ctxId
      const ctxId = computeCtxId(gl, hlKey, q, checkIn, checkOut, adults, currency);
      const ctxKey = `ctx:${ctxId}`;

      // KV-hit-first: check if already cached (0 credits)
      const refresh = url.searchParams.get("refresh") === "1";
      if (!refresh) {
        const cached = await kvGetJson(env.CACHE_KV, ctxKey);
        if (cached && Array.isArray(cached.properties)) {
          return jsonResponse({
            ok: true,
            ctxId,
            count: cached.properties.length,
            cache: "hit",
          }, 200, prefetchHeaders);
        }
      }

      // Rate limit check (only on cache miss, since we're about to spend a credit)
      const rateLimited = await rateLimitPrefetch(request, env, prefetchHeaders);
      if (rateLimited) return rateLimited;

      // Call SearchApi google_hotels
      const searchCall = await searchApiCall(env, {
        engine: "google_hotels",
        q,
        check_in_date: checkIn,
        check_out_date: checkOut,
        adults,
        currency,
        hl: hlSent,
        gl,
      });

      const { res, data } = searchCall;

      if (!res || !res.ok || data?.error) {
        return jsonResponse({
          error: "SearchApi google_hotels failed",
          status: res?.status ?? 0,
          details: data?.error || data || null,
          fetchError: searchCall.fetchError || null,
        }, 502, prefetchHeaders);
      }

      // Extract minimal property data
      const rawProperties = data?.properties || [];
      const minimalProperties = rawProperties.map(p => ({
        name: p?.name || null,
        city: p?.city || null,
        country: p?.country || null,
        property_token: p?.property_token || null,
        link: p?.link || null,
      })).filter(p => p.property_token); // Only keep ones with valid token

      // Store in KV
      const ctxData = {
        properties: minimalProperties,
        createdAt: new Date().toISOString(),
        query: { q, checkIn, checkOut, adults, currency, gl, hl: hlSent || null },
      };
      ctx.waitUntil(kvPutJson(env.CACHE_KV, ctxKey, ctxData, CTX_TTL_SEC));

      return jsonResponse({
        ok: true,
        ctxId,
        count: minimalProperties.length,
        cache: "miss",
      }, 200, prefetchHeaders);
    }

    // =========================
    // /compare route (SearchApi + KV caching)
    // =========================
    if (isCompare) {
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

      // --- Currency validation (uses shared normalizeCurrencyParam at module scope) ---
      const currencyRaw = url.searchParams.get("currency");
      const currency = normalizeCurrencyParam(currencyRaw) || "USD"; // Default to USD if invalid/missing
      const gl = (url.searchParams.get("gl") || "us").toLowerCase();

      // --- Optional matching hints ---
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

      // --- hl handling ---
      const hlRaw = url.searchParams.get("hl");
      const { hlNormalized, hlSent, hlKey } = normalizeTravelHl(hlRaw);
      const hlToSend = hlSent; // send when supported; searchApiCall will retry without hl if rejected

      const missing = [];
      if (!hotelName) missing.push("hotelName");
      if (!checkIn) missing.push("checkIn");
      if (!checkOut) missing.push("checkOut");
      if (missing.length) return jsonResponse({ error: "Missing required params", missing }, 400, corsHeaders);

      if (!isIsoDate(checkIn) || !isIsoDate(checkOut)) {
        return jsonResponse({ error: "Dates must be YYYY-MM-DD", checkIn, checkOut }, 400, corsHeaders);
      }

      const nights = nightsBetweenIso(checkIn, checkOut);
      if (!nights || nights <= 0) {
        return jsonResponse({ error: "Invalid date range", checkIn, checkOut }, 400, corsHeaders);
      }

      // ---- 1) Resolve property_token (cached) ----
      // Compute BOTH identity keys for cache aliasing
      const nameIdentity = `n:${normalizeKey(hotelName)}`;
      const domainIdentity = officialDomain ? `d:${officialDomain}` : null;

      const tokenKeyName = `tok:${gl}:${nameIdentity}`;
      const tokenKeyDomain = domainIdentity ? `tok:${gl}:${domainIdentity}` : null;

      // For backward compat in debug/logging, primary key is domain if available
      const tokenKey = tokenKeyDomain || tokenKeyName;

      // Track which key we found the token from (for diagnostics)
      let tokenCacheDetail = "miss";

      // Get ctx (search context) if provided
      const ctxParam = url.searchParams.get("ctx") || "";
      const ctxKey = ctxParam ? `ctx:${ctxParam}` : null;

      let tokenObj = null;
      if (!refresh) {
        // 1) Try search context first (from /prefetchCtx)
        if (ctxKey) {
          const ctxData = await kvGetJson(env.CACHE_KV, ctxKey);
          if (ctxData && Array.isArray(ctxData.properties)) {
            // Find matching property using pickBestProperty
            const picked = pickBestProperty(ctxData.properties, hotelName, officialDomain);
            if (picked?.best?.property_token) {
              tokenObj = {
                property_token: picked.best.property_token,
                property_name: picked.best.name || null,
                city: picked.best.city || null,
                country: picked.best.country || null,
                link: picked.best.link || null,
                linkHost: getHostNoWww(picked.best.link || ""),
                score: picked.bestScore,
                nameScore: picked.bestNameScore,
                domainMatch: picked.bestDomainMatch,
                officialDomain: officialDomain || null,
                fromCtx: true, // Flag that this came from context
              };
              tokenCacheDetail = "ctx-hit";

              // Backfill to token cache for future calls without ctx
              const shouldBackfill = tokenObj.domainMatch || (tokenObj.nameScore >= 0.55);
              if (shouldBackfill) {
                ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyName, tokenObj, TOKEN_TTL_NO_DOMAIN_SEC));
                if (tokenKeyDomain) {
                  ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyDomain, tokenObj, TOKEN_TTL_SEC));
                }
              }
            }
          }
        }

        // 2) Try domain key (more stable/trusted)
        if (!tokenObj?.property_token && tokenKeyDomain) {
          tokenObj = await kvGetJson(env.CACHE_KV, tokenKeyDomain);
          if (tokenObj?.property_token) {
            tokenCacheDetail = "hit-domain";
          }
        }

        // 3) Fallback to name key
        if (!tokenObj?.property_token) {
          tokenObj = await kvGetJson(env.CACHE_KV, tokenKeyName);
          if (tokenObj?.property_token) {
            tokenCacheDetail = "hit-name";

            // Backfill: If we have domain key but found via name, copy to domain cache
            if (tokenKeyDomain) {
              ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyDomain, tokenObj, TOKEN_TTL_SEC));
            }
          }
        }
      }

      let candidatesDebug = null;
      let debugSearch = debug ? {} : null;

      if (!tokenObj?.property_token) {
        tokenCacheDetail = "miss";

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
        const picked = pickBestProperty(props, hotelName, officialDomain);

        if (!picked?.best?.property_token) {
          return jsonResponse({ error: "No property_token found for hotel", hotelName, officialDomain: officialDomain || null, debug: debugSearch }, 404, corsHeaders);
        }

        tokenObj = {
          property_token: picked.best.property_token,
          property_name: picked.best.name || null,
          city: picked.best.city || null,
          country: picked.best.country || null,
          link: picked.best.link || null,
          linkHost: getHostNoWww(picked.best.link || ""),
          score: picked.bestScore,
          nameScore: picked.bestNameScore,
          domainMatch: picked.bestDomainMatch,
          officialDomain: officialDomain || null,
        };

        if (debug) {
          candidatesDebug = (props || []).slice(0, 8).map((p) => {
            const nameScore = scoreNameMatch(hotelName, p?.name || "");
            const linkHost = getHostNoWww(p?.link || "");
            const domainMatch = officialDomain ? domainsEquivalent(linkHost, officialDomain) : false;
            const finalScore = (domainMatch ? 2.0 : 0) + nameScore;
            return {
              name: p?.name,
              city: p?.city,
              country: p?.country,
              linkHost,
              domainMatch,
              nameScore,
              finalScore,
            };
          });
        }

        // Cache token to BOTH keys
        // - Name key: always cache (shorter TTL if no domain match)
        // - Domain key: cache if we have officialDomain
        const shouldCache = tokenObj.domainMatch === true || (tokenObj.nameScore != null && tokenObj.nameScore >= 0.55);

        if (shouldCache) {
          const nameTtl = tokenObj.domainMatch ? TOKEN_TTL_SEC : TOKEN_TTL_NO_DOMAIN_SEC;

          // Always write to name key
          ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyName, tokenObj, nameTtl));

          // Also write to domain key if available (with longer TTL)
          if (tokenKeyDomain) {
            ctx.waitUntil(kvPutJson(env.CACHE_KV, tokenKeyDomain, tokenObj, TOKEN_TTL_SEC));
          }
        }
      }

      const propertyToken = tokenObj.property_token;

      // ---- 2) Offers cache ----
      // Offers can vary by itinerary, currency, adults, region (gl). Keep hlKey in cache key for safety.
      const offersKey = `offers:${propertyToken}:${checkIn}:${checkOut}:${adults}:${currency}:${gl}:${hlKey}`;
      const cached = !refresh ? await kvGetJson(env.CACHE_KV, offersKey) : null;

      if (cached) {
        cached.cache = "hit";
        if (debug) {
          cached.debug = {
            ...(cached.debug || {}),
            cacheDetail: { token: tokenCacheDetail, offers: "hit" },
            tokenCacheKey: tokenKey,
            tokenKeyName,
            tokenKeyDomain: tokenKeyDomain || null,
            offersCacheKey: offersKey,
            tokenObj,
            candidates: candidatesDebug,
            officialUrl: officialUrl || null,
            officialDomain: officialDomain || null,
            currentHost: currentHost || null,
            hlRaw,
            hlNormalized,
            hlSent,
            hlToSend,
            searchApi: debugSearch,
          };
        }
        return jsonResponse(cached, 200, corsHeaders);
      }

      // ---- 3) Fetch property offers ----
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

      // --- Debug: Track raw counts ---
      const rawFeaturedCount = prop.featured_offers?.length || 0;
      const rawAllCount = prop.all_offers?.length || 0;

      const combined = [
        ...(Array.isArray(prop.featured_offers) ? prop.featured_offers : []),
        ...(Array.isArray(prop.all_offers) ? prop.all_offers : []),
      ];
      const combinedCount = combined.length;

      // Deduplicate by source + total + link
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
        } // don’t include offers we can’t price
        simplified.push(s);
      }

      simplified.sort((a, b) => (a.total ?? 1e18) - (b.total ?? 1e18));

      // --- Debug: raw counts object (only when debug=1) ---
      const rawCountsDebug = debug ? {
        rawFeaturedCount,
        rawAllCount,
        combinedCount,
        kept: simplified.length,
        droppedNoTotal,
        droppedDedup,
      } : null;

      // --- Debug: sample raw offer ---
      const sampleRawOfferDebug = debug && combined[0] ? {
        source: combined[0].source,
        total_price: combined[0].total_price,
        price_per_night: combined[0].price_per_night,
        link: combined[0].link,
        tracking_link: combined[0].tracking_link,
      } : null;

      // --- Debug: prop keys ---
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
        match: {
          cacheDetail: { token: tokenCacheDetail, offers: "miss" },
          tokenCacheKey: tokenKey,
          tokenKeyName,
          tokenKeyDomain: tokenKeyDomain || null,
          matchedBy: tokenObj.domainMatch ? "officialDomain" : "name",
          confidence: tokenObj.domainMatch ? 0.95 : Math.max(0, Math.min(0.9, tokenObj.nameScore || 0)),
          nameScore: tokenObj.nameScore ?? null,
          domainMatch: tokenObj.domainMatch ?? null,
          linkHost: tokenObj.linkHost || null,
        },
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
        debug: null, // Will be populated if debug=1
      };

      if (debug) {
        payload.debug = {
          tokenCacheKey: tokenKey,
          offersCacheKey: offersKey,
          tokenObj,
          candidates: candidatesDebug,
          officialUrl: officialUrl || null,
          officialDomain: officialDomain || null,
          currentHost: currentHost || null,
          hlRaw,
          hlNormalized,
          hlSent,
          hlToSend,
          searchApi: debugSearch,
          // --- New debug diagnostics ---
          rawCounts: rawCountsDebug,
          sampleRawOffer: sampleRawOfferDebug,
          propKeys: propKeysDebug,
        };
      }

      // Cache: never store debug payloads
      const toCache = { ...payload };
      delete toCache.cache;
      delete toCache.debug;
      ctx.waitUntil(kvPutJson(env.CACHE_KV, offersKey, toCache, OFFERS_TTL_SEC));

      return jsonResponse(payload, 200, corsHeaders);
    }

    // =========================
    // Existing contact lookup route: ?query=...
    // =========================
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

      // --- Step 2b: Website Recovery (DuckDuckGo + Strict Match) ---
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
            if (debugInfo) debugInfo.steps.push(`Recovered and verified website: ${websiteUrl}`);
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

      // --- Step 4: Last Resort Fallback (Global DDG email search) ---
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
            if (debugInfo) debugInfo.steps.push(`Found email via Global Search: ${snippetBest}`);
          }
        }
      }

      if (debugInfo) result.debug = debugInfo;
      return jsonResponse(result, 200, corsHeaders);
    } catch (error) {
      return jsonResponse({ error: error?.message || String(error) }, 500, corsHeaders);
    }
  },
};

// ---------- GENERIC HELPERS ----------
function jsonResponse(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

function isHtmlResponse(res) {
  const ctype = res.headers.get("content-type") || "";
  return ctype.includes("text/html") || ctype.includes("application/xhtml+xml");
}

// ---------- CONTACT LOOKUP HELPERS ----------

// Boundary-safe match: domain === junk OR domain endsWith(".junk")
function domainMatchesList(domainOrHost, list) {
  const d = String(domainOrHost || "").toLowerCase().replace(/^www\./, "");
  if (!d) return false;
  return list.some((junk) => d === junk || d.endsWith("." + junk));
}

function isSocialOrOta(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, "");
    return domainMatchesList(hostname, JUNK_DOMAINS);
  } catch {
    return false;
  }
}

function isPlausibleDomain(urlStr, queryStr) {
  try {
    const domain = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, "");

    const genericTerms = [
      "hotel", "hostel", "guesthouse", "apartment", "apartments", "villa", "suites",
      "bnb", "bedandbreakfast", "resort", "inn", "motel", "in", "the", "of", "and",
      "at", "heart", "center", "centre",
    ];

    const rawWords = queryStr.toLowerCase().split(/[\s,.-]+/);
    const uniqueKeywords = rawWords.filter((w) => w.length > 2 && !genericTerms.includes(w));

    if (uniqueKeywords.length === 0) return false;

    return uniqueKeywords.some((kw) => domain.includes(kw));
  } catch {
    return false;
  }
}

async function fetchAndExtract(url, websiteUrl, timeout, debugInfo) {
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

function pickBestEmailFromBatch(emailList) {
  return emailList[0] || null;
}

function normalizeEmail(raw) {
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

function decodeCfEmail(cfHex) {
  if (!cfHex || cfHex.length < 4) return null;
  const key = parseInt(cfHex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < cfHex.length; i += 2) {
    const b = parseInt(cfHex.slice(i, i + 2), 16);
    out += String.fromCharCode(b ^ key);
  }
  return out;
}

function decodeHtmlEntities(str) {
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

function extractEmailsFromJsonLd(html) {
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

function deepCollectEmails(node, out) {
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

function extractEmails(html) {
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

// Aggressive email filter (blocks JUNK_DOMAINS hard)
function pickBestEmail(emails, websiteUrl, sourceUrl = "", { minScore = 10 } = {}) {
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

      // strong positive: domain matches official website domain
      if (
        websiteHost &&
        (domain === websiteHost || domain.endsWith("." + websiteHost) || websiteHost.endsWith("." + domain))
      ) {
        score += 100;
      }

      // good local-part keywords
      if (/(info|contact|reservation|reservations|booking|reception|frontdesk|hello|stay|office|hallo|halló)/i.test(local)) {
        score += 15;
      }

      // good source page
      if (/contact|kontakt|impressum|reservation|booking/i.test(sourceUrl)) {
        score += 10;
      }

      // HARD BLOCK: OTAs & social
      if (domainMatchesList(domain, JUNK_DOMAINS)) {
        score -= 500;
      }

      // no-reply/system
      if (/(noreply|no-reply|donotreply|mailer-daemon|postmaster)/i.test(local)) {
        score -= 50;
      }

      // technical junk fragments
      if (denyDomainFragments.some((f) => domain.includes(f))) {
        score -= 80;
      }

      // asset/file TLDs
      if (BAD_TLDS.has(tld)) {
        score -= 200;
      }

      return { email, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.score >= minScore ? scored[0].email : null;
}

function getHostNoWww(urlStr) {
  const raw = String(urlStr || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    // Support passing bare domains like "example.com"
    try {
      return new URL("https://" + raw).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  }
}

function makeHostMatcher(websiteUrl) {
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

function discoverContactUrls(html, baseUrl) {
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

  // Preserve discovered-first ordering; Set keeps insertion order
  return [...new Set([...discovered, ...guessed])];
}

function rankContactUrls(urls) {
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

function extractDuckDuckGoResultUrls(ddgHtml, max = 3) {
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
