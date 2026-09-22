import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHandleList } from './handles.ts';

// ── Bare handles: the behaviour that predates URL support, unchanged ─────────

test('bare handles: @ stripped, lowercased, de-duplicated in input order', () => {
  const out = parseHandleList('@Fashionista\nstyleinfluencer\n@fashionista, Beauty.Blogger');
  assert.deepEqual(out.valid, ['fashionista', 'styleinfluencer', 'beauty.blogger']);
  assert.deepEqual(out.invalid, []);
});

test('invalid tokens are reported under the pasted text, not dropped', () => {
  const out = parseHandleList('ok_handle\nbad-handle\n1\n12345');
  assert.deepEqual(out.valid, ['ok_handle']);
  assert.deepEqual(out.invalid.map(i => i.input), ['bad-handle', '1', '12345']);
});

// ── Instagram URLs ────────────────────────────────────────────────────────────

test('instagram.com/handle in every common spelling resolves to the handle', () => {
  const forms = [
    'instagram.com/Some.Creator',
    'www.instagram.com/some.creator',
    'https://instagram.com/some.creator',
    'https://www.instagram.com/some.creator/',
    'http://www.instagram.com/some.creator?hl=en',
    'https://www.instagram.com/some.creator/?igsh=abc123&utm_source=ig',
    'https://instagram.com/some.creator#reels',
  ];
  for (const form of forms) {
    const out = parseHandleList(form);
    assert.deepEqual(out.valid, ['some.creator'], form);
    assert.deepEqual(out.invalid, [], form);
  }
});

// ── TikTok URLs ───────────────────────────────────────────────────────────────

test('tiktok.com/@handle in every common spelling resolves to the handle', () => {
  const forms = [
    'tiktok.com/@Dance.Queen',
    'www.tiktok.com/@dance.queen',
    'https://tiktok.com/@dance.queen',
    'https://www.tiktok.com/@dance.queen/',
    'https://www.tiktok.com/@dance.queen?lang=en',
    'https://www.tiktok.com/@dance.queen?_t=8abc&_r=1',
    'https://m.tiktok.com/@dance.queen',
  ];
  for (const form of forms) {
    const out = parseHandleList(form);
    assert.deepEqual(out.valid, ['dance.queen'], form);
    assert.deepEqual(out.invalid, [], form);
  }
});

test('a deeper profile path still yields the account', () => {
  assert.deepEqual(
    parseHandleList('https://www.tiktok.com/@dance.queen/video/7300000000000000000').valid,
    ['dance.queen'],
  );
});

// ── Mixed input ───────────────────────────────────────────────────────────────

test('a URL and the same bare handle de-duplicate to one entry', () => {
  const out = parseHandleList('https://www.tiktok.com/@dance.queen?lang=en\n@dance.queen\ndance.queen');
  assert.deepEqual(out.valid, ['dance.queen']);
});

test('URLs and handles mix freely across separators', () => {
  const out = parseHandleList('instagram.com/one, @two; https://www.tiktok.com/@three/ four');
  assert.deepEqual(out.valid, ['one', 'two', 'three', 'four']);
});

// ── URLs that are not profiles ────────────────────────────────────────────────

test('post, reel and explore links are rejected as not-a-profile, not as a handle', () => {
  const out = parseHandleList([
    'https://www.instagram.com/p/Cxyz123/',
    'https://www.instagram.com/reel/Cxyz123/',
    'https://www.instagram.com/explore/tags/ootd/',
    'https://www.tiktok.com/discover/miami',
  ].join('\n'));
  assert.deepEqual(out.valid, []);
  assert.equal(out.invalid.length, 4);
  for (const entry of out.invalid) {
    assert.equal(entry.reason, 'not a profile URL', entry.input);
    assert.match(entry.input, /^https:\/\//, 'reported under the pasted URL');
  }
});

test('a URL whose account segment fails validation reports the URL as input', () => {
  const out = parseHandleList('https://www.instagram.com/bad-name/');
  assert.deepEqual(out.valid, []);
  assert.equal(out.invalid[0].input, 'https://www.instagram.com/bad-name/');
  assert.match(out.invalid[0].reason, /invalid character/);
});

test('other domains are not treated as profile URLs', () => {
  const out = parseHandleList('https://linktr.ee/someone');
  assert.deepEqual(out.valid, []);
  assert.equal(out.invalid.length, 1);
  assert.match(out.invalid[0].reason, /invalid character/);
});
