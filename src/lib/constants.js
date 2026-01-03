/**
 * Shared constants for Worker.
 * All TTLs, endpoints, regex, rate limits, and config values.
 * 
 * @module lib/constants
 */

// ---------- BUILD INFO ----------
export const BUILD_TAG = "2025-12-17T03:40Z-search-fallback";

// ---------- CONTACT LOOKUP CONFIG ----------
export const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}/g;
export const EMAIL_REGEX_ANCHORED = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}$/;

export const CONTACT_HINTS = [
    "contact", "contact-us", "kontakt", "impressum", "contatti", "contacto", "contato", "contactez",
    "reservation", "reservations", "booking", "book", "reception", "frontdesk", "front-desk",
    "about", "legal", "privacy", "gdpr",
];

// Junk filter for websites + email domains
export const JUNK_DOMAINS = [
    "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "tiktok.com", "linktr.ee", "carrd.co",
    "booking.com", "agoda.com", "expedia.com", "hotels.com", "tripadvisor.com",
    "trivago.com", "kayak.com", "skyscanner.com", "orbitz.com", "priceline.com",
    "hostelworld.com", "airbnb.com", "vrbo.com", "google.com", "yahoo.com", "bing.com",
    "trip.com", "hotelscombined.com", "momondo.com", "cheapflights.com",
    // competitors/tools / generic builder hosts
    "inn.fan", "site.io", "page.link", "website.com", "business.site", "wixsite.com", "wordpress.com",
];

export const BAD_TLDS = new Set([
    "png", "jpg", "jpeg", "svg", "webp", "gif", "css", "js", "ico",
    "woff", "woff2", "ttf", "eot", "map", "mp4", "mp3",
]);

export const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// ---------- CONTACT TIMEOUTS ----------
export const TIMEOUT_HOME_MS = 6000;
export const TIMEOUT_PAGE_MS = 4000;
export const MAX_CONTACT_PAGES = 5;

// ---------- SEARCH API FALLBACK CONFIG ----------
export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const GOOGLE_CSE_ENDPOINT = "https://customsearch.googleapis.com/customsearch/v1";
export const FALLBACK_SEARCH_TIMEOUT_MS = 8000;
export const FALLBACK_SEARCH_MAX_RESULTS = 8;
export const FALLBACK_SEARCH_MAX_PAGES_TO_CRAWL = 5;
export const FALLBACK_SEARCH_CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
export const MAX_EMAIL_PARSE_BYTES = 2 * 1024 * 1024; // 2 MB

// ---------- RATE LIMITING ----------
export const COMPARE_RATE_LIMIT = 60; // requests per hour
export const COMPARE_WINDOW_SEC = 60 * 60; // 1 hour
export const CTX_RATE_LIMIT = 30; // prefetch calls per hour per IP
export const CTX_WINDOW_SEC = 3600; // 1 hour

// ---------- SEARCHAPI CONFIG ----------
export const SEARCHAPI_ENDPOINT = "https://www.searchapi.io/api/v1/search";
export const SEARCHAPI_TIMEOUT_MS = 8000;

// ---------- CACHE TTLs ----------
export const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
export const TOKEN_TTL_NO_DOMAIN_SEC = 7 * 24 * 60 * 60; // 7 days (fallback)
export const OFFERS_TTL_SEC = 30 * 60; // 30 minutes
export const CTX_TTL_SEC = 30 * 60; // 30 minutes

// ---------- LIMITS ----------
export const MAX_OFFERS_RETURNED = 25;

// ---------- SUPPORTED LANGUAGES ----------
// Supported Google Travel UI languages (SearchApi list)
// Source: https://www.searchapi.io/docs/parameters/google-travel/hl
export const SUPPORTED_TRAVEL_HL = new Set([
    "af", "bs", "ca", "cs", "da", "de", "et",
    "en-GB", "en-US",
    "es", "es-419",
    "eu", "fil", "fr", "gl", "hr", "id", "is", "it", "sw", "lv", "lt", "hu", "ms", "nl", "no", "pl",
    "pt-BR", "pt-PT",
    "ro", "sq", "sk", "sl", "sr-Latn", "fi", "sv", "vi", "tr", "el", "bg", "mk", "mn", "ru", "sr", "uk", "ka",
    "iw", "ur", "ar", "fa", "am", "ne", "mr", "hi", "bn", "pa", "gu", "ta", "te", "kn", "ml", "si", "th", "lo", "km", "ko", "ja",
    "zh-CN", "zh-TW",
]);

// ---------- CURRENCY SYMBOLS ----------
export const SYMBOL_TO_ISO = {
    "€": "EUR", "$": "USD", "£": "GBP", "¥": "JPY", "₹": "INR",
    "₩": "KRW", "₽": "RUB", "₪": "ILS", "฿": "THB", "₫": "VND",
};

// ---------- MATCHING CONSTANTS ----------
// Strict brand rules with phrase patterns for accurate matching.
// Multi-word brands (e.g., "Best Western", "Holiday Inn") are treated as phrases
// to prevent false overlaps on generic words like "western" or "holiday".
export const STRICT_BRAND_RULES = [
    // Truly distinctive single-token brands
    { id: "marriott", patterns: ["marriott"] },
    { id: "hilton", patterns: ["hilton"] },
    { id: "hyatt", patterns: ["hyatt"] },
    { id: "sheraton", patterns: ["sheraton"] },
    { id: "westin", patterns: ["westin"] },
    { id: "radisson", patterns: ["radisson"] },
    { id: "scandic", patterns: ["scandic"] },
    { id: "wyndham", patterns: ["wyndham"] },
    { id: "ramada", patterns: ["ramada"] },
    { id: "travelodge", patterns: ["travelodge"] },
    { id: "novotel", patterns: ["novotel"] },
    { id: "mercure", patterns: ["mercure"] },
    { id: "ibis", patterns: ["ibis"] },
    { id: "sofitel", patterns: ["sofitel"] },
    { id: "pullman", patterns: ["pullman"] },
    { id: "intercontinental", patterns: ["intercontinental"] },
    { id: "accor", patterns: ["accor"] },
    { id: "clarion", patterns: ["clarion"] },

    // Phrase brands (fixes "any overlap" bugs with generic words)
    { id: "best-western", patterns: ["best western"] },
    { id: "holiday-inn", patterns: ["holiday inn"] },
    { id: "crowne-plaza", patterns: ["crowne plaza"] },
    { id: "premier-inn", patterns: ["premier inn"] },
    { id: "days-inn", patterns: ["days inn"] },
    { id: "hotel-indigo", patterns: ["hotel indigo", "indigo hotel"] },
    { id: "motel-6", patterns: ["motel 6", "motel six"] },

    // Choice Hotels phrases (avoid generic "comfort/quality" tokens)
    { id: "comfort-inn", patterns: ["comfort inn"] },
    { id: "comfort-suites", patterns: ["comfort suites"] },
    { id: "quality-inn", patterns: ["quality inn"] },
];

// ---------- KEY DISAMBIGUATOR GROUPS (synonym-aware) ----------
// "Strong" patterns are location-defining (trigger conflicts if mismatched).
// "Weak" patterns are ambiguous (contribute to boost but not conflict).
// Removed generic words like "city", "plaza", "grand" that caused false mismatches.
export const KEY_GROUP_RULES = [
    {
        id: "airport",
        strong: ["airport", "terminal"],
        weak: [],
    },
    {
        id: "station",
        strong: ["train station", "railway station", "metro station", "subway station"],
        weak: ["station"], // "station" alone is often ambiguous
    },
    {
        id: "center",
        strong: ["downtown", "city center", "city centre", "old town", "oldtown", "historic center", "historic centre"],
        weak: ["central", "centre"], // can appear in non-location contexts
    },
    {
        id: "waterfront",
        strong: ["beach", "seafront", "oceanfront", "waterfront", "beachfront"],
        weak: ["harbor", "harbour", "marina", "port"],
    },
];

// Boost when query+candidate share a key-group (helps "downtown" vs "city centre")
export const KEY_GROUP_BOOST_STRONG = 0.12; // both sides strong
export const KEY_GROUP_BOOST_WEAK = 0.06;   // at least one side weak
export const KEY_GROUP_BOOST_CAP = 0.24;    // max total boost

// ---------- DOMAIN BOOST ----------
export const MIN_SCORE_FOR_DOMAIN_BOOST = 0.55;

// ---------- ROOM LIMIT ----------
export const MAX_ROOMS_PER_OFFER = 8;
