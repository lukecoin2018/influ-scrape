import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPostPlace, derivePlaceFromPosts,
  MIN_TAGGED_POSTS, MIN_DOMINANCE, type PostPlace,
} from './postLocation.ts';

// Shapes copied from real clockworks/tiktok-profile-scraper items.
const NYC  = { cityCode: '5128581', countryCode: '6252001', locationName: 'Fleur du Mal NYC Nolita Boutique', address: '372 Broome St, New York, NY 10013, USA', city: 'New York' };
const LA   = { cityCode: '5368361', countryCode: '6252001', locationName: 'Fleur du Mal LA Boutique', address: '519 N Almont Dr, West Hollywood, CA 90069, USA', city: 'Los Angeles County' };
const BKK  = { cityCode: '1609348', countryCode: '1605651', locationName: 'Bangkok', address: 'Thailand', city: '' };
const post = (lm?: unknown) => (lm === undefined ? {} : { locationMeta: lm });
const place = (lm: Record<string, unknown>) => extractPostPlace(post(lm))!;

// ── extractPostPlace ────────────────────────────────────────────────────────

test('a real locationMeta is read into flat fields', () => {
  assert.deepEqual(extractPostPlace(post(NYC)), {
    cityCode: '5128581', countryCode: '6252001',
    name: 'Fleur du Mal NYC Nolita Boutique',
    address: '372 Broome St, New York, NY 10013, USA', city: 'New York',
  });
});

test('an untagged post yields null, not an object of nulls', () => {
  // 92% of posts. "No place" must not be storable as a blank place.
  assert.equal(extractPostPlace(post()), null);
  assert.equal(extractPostPlace(post(null)), null);
  assert.equal(extractPostPlace({}), null);
  assert.equal(extractPostPlace(null), null);
  assert.equal(extractPostPlace('nope'), null);
});

test('an empty string city is null, not ""', () => {
  // BKK really does arrive with city: "" — measured.
  assert.equal(place(BKK).city, null);
  assert.equal(place(BKK).cityCode, '1609348');
});

test('a locationMeta with no identifier is not a place', () => {
  assert.equal(extractPostPlace(post({ locationName: 'Somewhere', address: 'Nowhere' })), null);
});

test('a country code alone still counts', () => {
  const p = extractPostPlace(post({ countryCode: '6252001' }));
  assert.equal(p?.countryCode, '6252001');
  assert.equal(p?.cityCode, null);
});

// ── derivePlaceFromPosts: the thresholds ────────────────────────────────────

test('one tagged post is a visit, not a residence', () => {
  assert.equal(MIN_TAGGED_POSTS, 2);
  const posts = [place(NYC), ...Array(14).fill(null)];
  assert.equal(derivePlaceFromPosts(posts), null);
});

test('two on the same code clears the bar', () => {
  const r = derivePlaceFromPosts([place(NYC), place(NYC), null, null]);
  assert.equal(r?.cityCode, '5128581');
  assert.equal(r?.confidence, 1);
  assert.equal(r?.taggedPosts, 2);
  assert.equal(r?.totalPosts, 4);
});

test('a real habitual tagger resolves with full confidence', () => {
  // @katnimpa: 15/15 tagged, all Bangkok.
  const r = derivePlaceFromPosts(Array(15).fill(place(BKK)));
  assert.equal(r?.cityCode, '1609348');
  assert.equal(r?.countryCode, '1605651');
  assert.equal(r?.confidence, 1);
  assert.equal(r?.taggedPosts, 15);
});

test('a split creator resolves to the dominant city, keeping the country', () => {
  // @fleurdumalnyc: 13 New York + 2 Los Angeles. Both United States.
  const r = derivePlaceFromPosts([...Array(13).fill(place(NYC)), ...Array(2).fill(place(LA))]);
  assert.equal(r?.cityCode, '5128581');
  assert.equal(r?.countryCode, '6252001', 'country comes from the winning city');
  assert.ok(Math.abs(r!.confidence - 13 / 15) < 1e-9);
});

test('an even split between cities yields no CITY answer', () => {
  assert.equal(MIN_DOMINANCE, 0.6);
  // Updated when the country fallback landed. New York vs Los Angeles fails
  // the city bar, but both are the United States, so the run now resolves at
  // country level rather than returning nothing. The city half of the
  // assertion is the part that still matters.
  const r = derivePlaceFromPosts([place(NYC), place(LA)]);
  assert.equal(r?.cityCode, null, 'no dominant city');
  assert.equal(r?.level, 'country');
});

test('a genuine tourist — many places, none dominant — yields nothing', () => {
  // Each city in a DIFFERENT country, so neither vote finds a majority.
  // Before the country fallback this fixture shared one country and passed for
  // the wrong reason; it now tests what its name claims.
  const somewhere = (city: string, country: string) =>
    place({ cityCode: city, countryCode: country, locationName: city });
  const posts = [
    somewhere('5128581', '6252001'), somewhere('1609348', '1605651'),
    somewhere('2647599', '2635167'), somewhere('3674962', '3686110'),
    somewhere('6697808', '390903'),
  ];
  assert.equal(derivePlaceFromPosts(posts), null);
});

test('exactly at the 60% boundary passes', () => {
  const r = derivePlaceFromPosts([...Array(3).fill(place(NYC)), ...Array(2).fill(place(LA))]);
  assert.equal(r?.cityCode, '5128581');
  assert.ok(Math.abs(r!.confidence - 0.6) < 1e-9);
});

test('the thresholds are overridable for analysis without changing the default', () => {
  const posts = [place(NYC)];
  assert.equal(derivePlaceFromPosts(posts), null);
  assert.equal(derivePlaceFromPosts(posts, { minTagged: 1 })?.cityCode, '5128581');
});

test('an all-untagged creator yields nothing rather than throwing', () => {
  assert.equal(derivePlaceFromPosts(Array(15).fill(null)), null);
  assert.equal(derivePlaceFromPosts([]), null);
});

test('a tie is broken deterministically, not by actor return order', () => {
  // Without the tiebreak the winner would depend on Map insertion order.
  const a = place({ cityCode: 'aaa', countryCode: 'X' });
  const b = place({ cityCode: 'bbb', countryCode: 'Y' });
  const one = derivePlaceFromPosts([a, a, b, b], { minDominance: 0.5 });
  const two = derivePlaceFromPosts([b, b, a, a], { minDominance: 0.5 });
  assert.equal(one?.cityCode, two?.cityCode, 'same input, different order, same answer');
  assert.equal(one?.cityCode, 'aaa');
});

test('name prefers city over the noisy venue label', () => {
  // One New York code carried both "Fleur du Mal NYC Nolita Boutique" and
  // "Fleur Du Mal"; city is the cleaner of the two where present.
  assert.equal(derivePlaceFromPosts([place(NYC), place(NYC)])?.name, 'New York');
  assert.equal(derivePlaceFromPosts([place(BKK), place(BKK)])?.name, 'Bangkok',
    'falls back to locationName when city is empty');
});

test('posts with a country but no city do not count toward the city vote', () => {
  // They resolve the COUNTRY instead — the behaviour the "0" sentinel needs.
  const countryOnly = extractPostPlace(post({ countryCode: '6252001' }))!;
  const r = derivePlaceFromPosts([countryOnly, countryOnly]);
  assert.equal(r?.cityCode, null, 'must never win the city vote');
  assert.equal(r?.level, 'country');
  assert.equal(r?.countryCode, '6252001');
});

test('a dominant city outvotes country-only posts', () => {
  // City is preferred whenever it clears its own bar, regardless of how many
  // country-level tags sit alongside it.
  const countryOnly = extractPostPlace(post({ countryCode: '6252001' }))!;
  const r = derivePlaceFromPosts([place(NYC), place(NYC), place(NYC), countryOnly]);
  assert.equal(r?.level, 'city');
  assert.equal(r?.cityCode, '5128581');
});

// ── The "0" sentinel, found on real data after the first re-enrich ──────────

const BVI = { cityCode: '0', countryCode: '3577718', locationName: 'Spanish Town', address: 'British Virgin Islands', city: '' };

test('cityCode "0" is an absence, not a place', () => {
  // The actor sends the literal string "0" on country-level tags. GeoNames ids
  // start at 1, so it cannot be a place. Stored as-is it collapses every
  // country-level creator on earth into one bogus "city 0" bucket.
  const p = extractPostPlace(post(BVI))!;
  assert.equal(p.cityCode, null);
  assert.equal(p.countryCode, '3577718');
});

test('a country-level tag is still a place, not discarded', () => {
  assert.notEqual(extractPostPlace(post(BVI)), null);
});

test('@donnacayman resolves at country level rather than being lost', () => {
  // Three posts, all British Virgin Islands, no city on any of them. Nulling
  // the "0" without this fallback would throw the answer away.
  const r = derivePlaceFromPosts([...Array(3).fill(place(BVI)), ...Array(17).fill(null)]);
  assert.equal(r?.level, 'country');
  assert.equal(r?.cityCode, null);
  assert.equal(r?.countryCode, '3577718');
  assert.equal(r?.confidence, 1);
  assert.equal(r?.taggedPosts, 3);
  assert.equal(r?.totalPosts, 20);
});

test('a city answer still wins when one exists, and is labelled as such', () => {
  const r = derivePlaceFromPosts([place(NYC), place(NYC)]);
  assert.equal(r?.level, 'city');
  assert.equal(r?.cityCode, '5128581');
});

test('a creator moving between cities in one country falls back to the country', () => {
  // The city vote fails the dominance bar; the country vote does not.
  const r = derivePlaceFromPosts([place(NYC), place(LA)]);
  assert.equal(r?.level, 'country');
  assert.equal(r?.countryCode, '6252001');
  assert.equal(r?.cityCode, null);
});

test('cities in DIFFERENT countries still yield nothing', () => {
  // No dominant city and no dominant country — a genuine traveller.
  assert.equal(derivePlaceFromPosts([place(NYC), place(BKK)]), null);
});

test('one country-level post is still a visit', () => {
  assert.equal(derivePlaceFromPosts([place(BVI), ...Array(19).fill(null)]), null);
});

test('a country-level answer names the place from what it has', () => {
  assert.equal(derivePlaceFromPosts([place(BVI), place(BVI)])?.name, 'Spanish Town');
});
