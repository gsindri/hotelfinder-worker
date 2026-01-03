import { describe, it, expect } from 'vitest';
import { parseBookingHotelSlug } from '../src/lib/normalize.js';

describe('parseBookingHotelSlug', () => {
    it('parses standard en-gb URL', () => {
        const result = parseBookingHotelSlug(
            'https://www.booking.com/hotel/gb/green-room-apartments.en-gb.html'
        );
        expect(result).toEqual({ cc: 'gb', slug: 'green-room-apartments' });
    });

    it('parses URL without language suffix', () => {
        const result = parseBookingHotelSlug(
            'https://www.booking.com/hotel/us/hotel-foo.html'
        );
        expect(result).toEqual({ cc: 'us', slug: 'hotel-foo' });
    });

    it('parses URL with query params', () => {
        const result = parseBookingHotelSlug(
            'https://www.booking.com/hotel/us/hotel-foo.html?aid=123&label=test'
        );
        expect(result).toEqual({ cc: 'us', slug: 'hotel-foo' });
    });

    it('parses URL with two-letter language suffix', () => {
        const result = parseBookingHotelSlug(
            'https://www.booking.com/hotel/de/hotel-berlin.de.html'
        );
        expect(result).toEqual({ cc: 'de', slug: 'hotel-berlin' });
    });

    it('parses subdomain (secure.booking.com)', () => {
        const result = parseBookingHotelSlug(
            'https://secure.booking.com/hotel/fr/hotel-paris.fr.html'
        );
        expect(result).toEqual({ cc: 'fr', slug: 'hotel-paris' });
    });

    it('returns null for non-booking host', () => {
        const result = parseBookingHotelSlug(
            'https://example.com/hotel/gb/test.html'
        );
        expect(result).toBeNull();
    });

    it('returns null for search results page', () => {
        const result = parseBookingHotelSlug(
            'https://www.booking.com/searchresults.html?dest_id=-12345'
        );
        expect(result).toBeNull();
    });

    it('returns null for invalid URL', () => {
        expect(parseBookingHotelSlug('not a url')).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(parseBookingHotelSlug('')).toBeNull();
        expect(parseBookingHotelSlug(null)).toBeNull();
        expect(parseBookingHotelSlug(undefined)).toBeNull();
    });

    it('handles URL-encoded characters in slug', () => {
        const result = parseBookingHotelSlug(
            'https://www.booking.com/hotel/es/hotel-caf%C3%A9.es.html'
        );
        // café -> cafe after normalization
        expect(result).toEqual({ cc: 'es', slug: 'hotel-caf' });
    });

    it('normalizes slug to lowercase', () => {
        const result = parseBookingHotelSlug(
            'https://www.booking.com/hotel/gb/The-Grand-Hotel.en-gb.html'
        );
        expect(result).toEqual({ cc: 'gb', slug: 'the-grand-hotel' });
    });
});
