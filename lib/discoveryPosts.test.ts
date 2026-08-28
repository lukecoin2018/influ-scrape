import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthorHandles } from './discoveryPosts.ts';

test('Instagram posts yield ownerUsername', () => {
  assert.deepEqual(
    extractAuthorHandles([
      { ownerUsername: 'creatorone', caption: 'hi' },
      { ownerUsername: 'creatortwo' },
    ], 'instagram'),
    ['creatorone', 'creatortwo'],
  );
});

test('TikTok posts yield authorMeta.name', () => {
  assert.deepEqual(
    extractAuthorHandles([
      { authorMeta: { name: 'creatorone', nickName: 'Creator One' }, text: 'hi' },
      { authorMeta: { name: 'creatortwo', nickName: 'Creator Two' } },
    ], 'tiktok'),
    ['creatorone', 'creatortwo'],
  );
});

test('the TikTok DISPLAY name is never used as a handle', () => {
  // nickName is "M·A·C Cosmetics"-shaped. Reading it as a handle is what
  // produced the stored fragments "levi", "lor" and "the".
  const out = extractAuthorHandles(
    [{ authorMeta: { name: 'maccosmetics', nickName: 'M·A·C Cosmetics' } }],
    'tiktok',
  );
  assert.deepEqual(out, ['maccosmetics']);
});

test('platforms do not read each other fields', () => {
  // An Instagram-shaped post read as TikTok yields nothing, rather than
  // silently falling through to a field that happens to exist.
  assert.deepEqual(extractAuthorHandles([{ ownerUsername: 'x' }], 'tiktok'), []);
  assert.deepEqual(extractAuthorHandles([{ authorMeta: { name: 'x' } }], 'instagram'), []);
});

test('handles are deduplicated and normalised', () => {
  assert.deepEqual(
    extractAuthorHandles([
      { ownerUsername: 'CreatorOne' },
      { ownerUsername: '@creatorone' },
      { ownerUsername: 'creatorone' },
    ], 'instagram'),
    ['creatorone'],
  );
});

test('junk entries are dropped rather than producing empty handles', () => {
  assert.deepEqual(
    extractAuthorHandles(
      [null, undefined, 'a string', 42, {}, { ownerUsername: '' }, { ownerUsername: '   ' },
       { ownerUsername: 'a' }, { ownerUsername: '12345' }, { ownerUsername: 'good' }],
      'instagram',
    ),
    ['good'],
  );
});

test('Instagram falls back to owner.username when ownerUsername is absent', () => {
  assert.deepEqual(
    extractAuthorHandles([{ owner: { username: 'creatorone' } }], 'instagram'),
    ['creatorone'],
  );
});

test('TikTok falls back through author.uniqueId and uniqueId', () => {
  assert.deepEqual(
    extractAuthorHandles([
      { author: { uniqueId: 'one' } },
      { uniqueId: 'two' },
    ], 'tiktok'),
    ['one', 'two'],
  );
});

test('an empty post list gives an empty result', () => {
  assert.deepEqual(extractAuthorHandles([], 'instagram'), []);
  assert.deepEqual(extractAuthorHandles([], 'tiktok'), []);
});
