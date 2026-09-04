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

test('an even split is below the dominance bar and yields nothing', () => {
  assert.equal(MIN_DOMINANCE, 0.6);
  assert.equal(derivePlaceFromPosts([place(NYC), place(LA)]), null);
});

test('a genuine tourist — many places, none dominant — yields nothing', () => {
  const somewhere = (code: string) =>
    place({ cityCode: code, countryCode: '6252001', locationName: code });
  assert.equal(derivePlaceFromPosts(
    ['1', '2', '3', '4', '5'].map(somewhere)), null);
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
  const countryOnly = extractPostPlace(post({ countryCode: '6252001' }))!;
  assert.equal(derivePlaceFromPosts([countryOnly, countryOnly]), null);
});
