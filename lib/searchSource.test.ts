import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthorHandles } from './discoveryPosts.ts';

/**
 * V3: the failure this guards against.
 *
 * extractAuthorHandles returns [] rather than throwing when the author field is
 * missing, which downstream is indistinguishable from a term nobody posted
 * under. These pin the two cases apart so the route's `posts > 0 && handles
 * === 0` condition provably separates them.
 */

// Multi-character handles: normaliseHandleToken rejects single characters as
// noise, so 'a' would be dropped for a reason unrelated to what is under test.
const igPost = (owner: string) => ({ ownerUsername: owner, caption: 'x' });

test('V3: a term nobody posted under yields no posts and no handles', () => {
  assert.deepEqual(extractAuthorHandles([], 'instagram'), []);
});

test('V3: posts WITH ownerUsername yield handles — the healthy case', () => {
  const handles = extractAuthorHandles([igPost('creatorone'), igPost('creatortwo')], 'instagram');
  assert.deepEqual(handles, ['creatorone', 'creatortwo']);
});

test('V3: posts WITHOUT ownerUsername yield zero handles — silent today', () => {
  // The shape Instagram's keyword dataset might return: real posts, no
  // ownerUsername. Extraction cannot tell this from "nobody posted".
  const keywordShaped = [
    { caption: 'sustainable fashion haul', likesCount: 12, url: 'https://instagram.com/p/a' },
    { caption: 'thrifted denim', likesCount: 40, url: 'https://instagram.com/p/b' },
  ];
  assert.deepEqual(extractAuthorHandles(keywordShaped, 'instagram'), []);
});

test('V3: the route condition separates the two cases', () => {
  // posts > 0 && handles === 0 is the only signature that distinguishes
  // "shape changed" from "no reach", and it is what the route reports on.
  const noReach = { posts: [] as unknown[], handles: extractAuthorHandles([], 'instagram') };
  const shapeChanged = {
    posts: [{ caption: 'a' }, { caption: 'b' }],
    handles: extractAuthorHandles([{ caption: 'a' }, { caption: 'b' }], 'instagram'),
  };
  const healthy = {
    posts: [igPost('creatorone')],
    handles: extractAuthorHandles([igPost('creatorone')], 'instagram'),
  };

  const failed = (r: { posts: unknown[]; handles: string[] }) =>
    r.posts.length > 0 && r.handles.length === 0;

  assert.equal(failed(noReach), false, 'no posts is not an extraction failure');
  assert.equal(failed(shapeChanged), true, 'posts without handles IS');
  assert.equal(failed(healthy), false);
});

test('V3: a partial shape change is not flagged — some handles is not zero', () => {
  // One post carries the field, one does not. Not a shape failure; the term
  // simply had a post the scraper could not attribute.
  const mixed = [igPost('creatorone'), { caption: 'no owner' }];
  const handles = extractAuthorHandles(mixed, 'instagram');
  assert.deepEqual(handles, ['creatorone']);
  assert.equal(mixed.length > 0 && handles.length === 0, false);
});
