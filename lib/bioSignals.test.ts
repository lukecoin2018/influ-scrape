import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLanguage, scoreLanguages, stripNonLanguageTokens,
  detectLocation, countryFromEmailTld, mayWriteEmailTldCountry,
} from './bioSignals.ts';

// ── Language: emails, URLs and domains are not words ────────────────────────

test('an email address no longer contributes the stopword "com"', () => {
  // @jackyinberlin's bio, which was labelled Portuguese on this token alone.
  const bio = 'berlin & munich fashion, lifestyle & beauty 💌: krapf.jacqueline@yahoo.com';
  assert.deepEqual(scoreLanguages(bio, []), []);
  assert.equal(detectLanguage(bio, []).primary, 'unknown');
});

test('URLs and bare domains are stripped too', () => {
  const text = 'shop https://shopltk.com/explore/x and linktr.ee/me or www.mysite.com/de';
  const stripped = stripNonLanguageTokens(text);
  for (const gone of ['shopltk', 'linktr', 'mysite', 'com']) assert.ok(!stripped.includes(gone), gone);
  assert.ok(stripped.includes('shop'));
  assert.ok(stripped.includes('and'));
});

test('"com" as a real Portuguese word still counts', () => {
  const caption = 'Um dia incrível com as minhas amigas, muito obrigada por tudo';
  assert.equal(detectLanguage('', [caption]).primary, 'pt');
});

// ── Language: a tie is no answer ────────────────────────────────────────────

test('a tie yields no label rather than the first language in the table', () => {
  // @luhtrends: one hit each for de ("das"), es and pt ("como"). The old
  // stable sort handed it to German by list order.
  const bio = 'Achadinhos do TikTok Shop 🛍️ Como Faço meus vídeos das compras';
  assert.deepEqual(scoreLanguages(bio, []).map(([, n]) => n), [1, 1, 1]);
  assert.equal(detectLanguage(bio, []).primary, 'unknown');
  assert.deepEqual(detectLanguage(bio, []).all, []);
});

test('a clear winner is unchanged', () => {
  const r = detectLanguage('Ich bin Journalistin, liebe Mode, Bücher und Reisen.', [
    'Ich wünsche euch einen wunderschönen Tag und viel Spaß mit dem Look',
  ]);
  assert.equal(r.primary, 'de');
});

test('a single hit with no rival is still enough (no two-hit minimum)', () => {
  assert.equal(detectLanguage('one more photo dump from the trip', []).primary, 'en');
});

// ── Location: DACH cities ───────────────────────────────────────────────────

test('the added DACH cities resolve, in local and English spellings', () => {
  const cases: [string, string][] = [
    ['📍 Graz', 'Austria'], ['Linz based creator', 'Austria'], ['Salzburg | Wien', 'Austria'],
    ['Innsbruck 🏔️', 'Austria'], ['Basel, CH', 'Switzerland'], ['Bâle', 'Switzerland'],
    ['Bern', 'Switzerland'], ['Leipzig', 'Germany'], ['Nürnberg', 'Germany'],
    ['nuernberg', 'Germany'], ['Nuremberg', 'Germany'],
  ];
  for (const [bio, country] of cases) {
    const loc = detectLocation(bio);
    assert.equal(loc.country, country, bio);
    assert.equal(loc.countrySource, 'city', bio);
  }
});

// ── Location: email TLD fallback ────────────────────────────────────────────

test('.de .at .ch addresses map to their countries', () => {
  assert.equal(countryFromEmailTld(['saloua.lam@gmx.de']), 'Germany');
  assert.equal(countryFromEmailTld(['kontakt@agentur.at']), 'Austria');
  assert.equal(countryFromEmailTld(['hi@bluewin.ch']), 'Switzerland');
  assert.equal(countryFromEmailTld(['x@gmail.com']), null);
  assert.equal(countryFromEmailTld([]), null);
});

test('addresses pointing at two countries give no fallback', () => {
  assert.equal(countryFromEmailTld(['a@gmx.de', 'b@bluewin.ch']), null);
  assert.equal(countryFromEmailTld(['a@gmx.de', 'b@gmail.com']), 'Germany');
});

test('the TLD is used only when the bio sets no country itself', () => {
  const fallback = detectLocation('beauty & lifestyle 💌 mia@medialogix.de', ['mia@medialogix.de']);
  assert.equal(fallback.country, 'Germany');
  assert.equal(fallback.countrySource, 'email_tld');

  // A flag, a city or a country name wins, and is reported as such.
  const flag = detectLocation('🇺🇸 creator 💌 mia@medialogix.de', ['mia@medialogix.de']);
  assert.deepEqual([flag.country, flag.countrySource], ['United States', 'flag']);
  const city = detectLocation('Miami 🌴 mia@medialogix.de', ['mia@medialogix.de']);
  assert.deepEqual([city.country, city.countrySource], ['United States', 'city']);
});

test('the fallback is written only when nothing is stored, and never over a geotag', () => {
  const nothing = { detectedCountry: null, placeCountryCode: null, countrySource: null };
  assert.equal(mayWriteEmailTldCountry(nothing), true);
  // Any stored country — heuristic, AI or hand-entered — stays.
  assert.equal(mayWriteEmailTldCountry({ ...nothing, detectedCountry: 'United States' }), false);
  // A geotag country is something else setting a country.
  assert.equal(mayWriteEmailTldCountry({ ...nothing, placeCountryCode: '2658434' }), false);
  // The fallback may refresh what it wrote itself.
  assert.equal(mayWriteEmailTldCountry({ ...nothing, detectedCountry: 'Germany', countrySource: 'email_tld' }), true);
});
