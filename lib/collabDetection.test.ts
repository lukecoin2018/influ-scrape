import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCollabsInBrandPost,
  detectCollabsInTikTokBrandPost,
  applyRepeatMentionConfidence,
  summariseTikTokFieldCoverage,
  SIGNAL_COAUTHOR,
  SIGNAL_TAGGED,
  SIGNAL_MENTIONED,
  SIGNAL_MENTIONED_TIKTOK,
  SIGNAL_REPEATED,
} from './collabDetection.ts';

const handles = (r: { candidates: { handle: string }[] }) => r.candidates.map(c => c.handle);
const byHandle = (r: { candidates: { handle: string; signals: string[]; confidence: string }[] }, h: string) =>
  r.candidates.find(c => c.handle === h);

// ── Instagram: unchanged behaviour, plus the shared caption pattern ───────────

test('instagram: coauthor is high, tag alone medium, caption mention alone low', () => {
  const r = detectCollabsInBrandPost({
    ownerUsername: 'brand',
    caption: 'shot with @photog_one',
    coauthorProducers: [{ username: 'Creator.A' }],
    taggedUsers: [{ username: 'creator_b' }],
  }, 'brand');

  assert.deepEqual(handles(r).sort(), ['creator.a', 'creator_b', 'photog_one']);
  assert.equal(byHandle(r, 'creator.a')?.confidence, 'high');
  assert.deepEqual(byHandle(r, 'creator.a')?.signals, [SIGNAL_COAUTHOR]);
  assert.equal(byHandle(r, 'creator_b')?.confidence, 'medium');
  assert.deepEqual(byHandle(r, 'creator_b')?.signals, [SIGNAL_TAGGED]);
  assert.equal(byHandle(r, 'photog_one')?.confidence, 'low');
  assert.deepEqual(byHandle(r, 'photog_one')?.signals, [SIGNAL_MENTIONED]);
});

test('instagram: tagged AND mentioned is high; brand and owner are dropped', () => {
  const r = detectCollabsInBrandPost({
    ownerUsername: 'brand_official',
    caption: 'with @creator_b and @brand and @brand_official',
    taggedUsers: [{ username: 'creator_b' }, { username: 'brand' }],
  }, 'brand');

  assert.deepEqual(handles(r), ['creator_b']);
  assert.equal(byHandle(r, 'creator_b')?.confidence, 'high');
});

test('instagram caption: "@Huda Beauty" still yields "huda" — a space legally ends a handle', () => {
  // The documented limitation of any caption rule (lib/handles.ts). Asserted
  // so the behaviour is explicit: Instagram autocompletes real handles into
  // captions, so a display name in a caption is rare there. On TikTok it is
  // the norm, which is why the TikTok detector never reads the caption.
  const r = detectCollabsInBrandPost({ caption: 'so good @Huda Beauty' }, 'brand');
  assert.deepEqual(handles(r), ['huda']);
});

test('instagram caption: the shared pattern rejects "@loréal" and "@kiehl\'s" instead of truncating them', () => {
  // The private regex this module carried until now produced "lor" and
  // "kiehl" here — the fragment class the truncation repair removed.
  const r = detectCollabsInBrandPost({
    caption: 'thanks @loréal and @kiehl’s and @coca-cola, plus @real.handle.',
  }, 'brand');
  assert.deepEqual(handles(r), ['real.handle']);
});

test('instagram: actor mentions win over the caption when present', () => {
  const r = detectCollabsInBrandPost({
    caption: '@caption_only',
    mentions: ['actor_mention'],
  }, 'brand');
  assert.deepEqual(handles(r), ['actor_mention']);
});

// ── TikTok: detailedMentions only ─────────────────────────────────────────────

const tiktokPost = (over: Record<string, unknown> = {}) => ({
  id: '7300000000000000001',
  text: 'new drop with @Huda Beauty and @RUFFLES #ad',
  webVideoUrl: 'https://www.tiktok.com/@brand/video/7300000000000000001',
  createTimeISO: '2026-09-01T10:00:00.000Z',
  diggCount: 100,
  commentCount: 5,
  playCount: 9000,
  authorMeta: { name: 'brand' },
  ...over,
});

test('tiktok: "@Huda Beauty" in the caption yields hudabeauty from detailedMentions, never huda', () => {
  const r = detectCollabsInTikTokBrandPost(tiktokPost({
    detailedMentions: [{ name: 'hudabeauty', id: '1' }, { name: 'officialruffles', id: '2' }],
    mentions: ['@Huda Beauty', '@RUFFLES'],
  }), 'brand');

  assert.deepEqual(handles(r), ['hudabeauty', 'officialruffles']);
  assert.equal(byHandle(r, 'hudabeauty')?.confidence, 'medium');
  assert.deepEqual(byHandle(r, 'hudabeauty')?.signals, [SIGNAL_MENTIONED_TIKTOK]);
  assert.equal(r.postType, 'video');
  assert.equal(r.postUrl, 'https://www.tiktok.com/@brand/video/7300000000000000001');
  assert.equal(r.postedAt, '2026-09-01T10:00:00.000Z');
  assert.equal(r.likesCount, 100);
  assert.equal(r.commentsCount, 5);
  assert.equal(r.viewsCount, 9000);
});

test('tiktok: an EMPTY detailedMentions yields nothing — the actor said "no mentions"', () => {
  const r = detectCollabsInTikTokBrandPost(tiktokPost({
    detailedMentions: [],
    mentions: ['@Huda Beauty'],
  }), 'brand');
  assert.deepEqual(handles(r), []);
});

test('tiktok: an ABSENT detailedMentions yields nothing — no mentions[] fallback, no caption regex', () => {
  const r = detectCollabsInTikTokBrandPost(tiktokPost({
    mentions: ['@Huda Beauty', '@RUFFLES'],
  }), 'brand');
  assert.deepEqual(handles(r), []);
});

test('tiktok: the brand, the post author and duplicates are dropped', () => {
  const r = detectCollabsInTikTokBrandPost(tiktokPost({
    authorMeta: { name: 'brand_official' },
    detailedMentions: [
      { name: 'brand' }, { name: 'brand_official' },
      { name: 'creator_a' }, { name: 'Creator_A' },
    ],
  }), 'brand');
  assert.deepEqual(handles(r), ['creator_a']);
});

test('tiktok: post url falls back to author + id, and createTime (seconds) to ISO', () => {
  const r = detectCollabsInTikTokBrandPost({
    id: '42',
    authorMeta: { name: 'brand' },
    createTime: 1_756_720_800,
    detailedMentions: [{ name: 'creator_a' }],
  }, 'brand');
  assert.equal(r.postUrl, 'https://www.tiktok.com/@brand/video/42');
  assert.equal(r.postedAt, '2025-09-01T10:00:00.000Z');
  assert.equal(r.viewsCount, null);
});

test('tiktok: no url when the actor gave neither webVideoUrl nor an author+id', () => {
  const r = detectCollabsInTikTokBrandPost({ detailedMentions: [{ name: 'creator_a' }] }, 'brand');
  assert.equal(r.postUrl, '');
});

// ── Cross-post corroboration ──────────────────────────────────────────────────

test('a handle mentioned in two posts is lifted to high with the repeat signal; one post stays medium', () => {
  const posts = [
    detectCollabsInTikTokBrandPost(tiktokPost({ id: '1', detailedMentions: [{ name: 'twice' }, { name: 'once' }] }), 'brand'),
    detectCollabsInTikTokBrandPost(tiktokPost({ id: '2', detailedMentions: [{ name: 'twice' }] }), 'brand'),
  ];
  const lifted = applyRepeatMentionConfidence(posts);

  assert.equal(byHandle(lifted[0], 'twice')?.confidence, 'high');
  assert.deepEqual(byHandle(lifted[0], 'twice')?.signals, [SIGNAL_MENTIONED_TIKTOK, SIGNAL_REPEATED]);
  assert.equal(byHandle(lifted[1], 'twice')?.confidence, 'high');
  assert.equal(byHandle(lifted[0], 'once')?.confidence, 'medium');
  assert.deepEqual(byHandle(lifted[0], 'once')?.signals, [SIGNAL_MENTIONED_TIKTOK]);

  // The input is not mutated.
  assert.equal(byHandle(posts[0], 'twice')?.confidence, 'medium');
});

test('repeat lift is idempotent and never lowers', () => {
  const posts = [
    detectCollabsInTikTokBrandPost(tiktokPost({ id: '1', detailedMentions: [{ name: 'twice' }] }), 'brand'),
    detectCollabsInTikTokBrandPost(tiktokPost({ id: '2', detailedMentions: [{ name: 'twice' }] }), 'brand'),
  ];
  const once = applyRepeatMentionConfidence(posts);
  const again = applyRepeatMentionConfidence(once);
  assert.deepEqual(again, once);
});

// ── Coverage ──────────────────────────────────────────────────────────────────

test('tiktok coverage separates "field returned" from "field non-empty"', () => {
  const c = summariseTikTokFieldCoverage([
    tiktokPost({ detailedMentions: [{ name: 'a' }] }),
    tiktokPost({ detailedMentions: [] }),
    tiktokPost({ mentions: ['@Display Name'] }),
    tiktokPost({ text: '' }),
  ]);
  assert.deepEqual(c, {
    posts: 4,
    withDetailedMentionsField: 2,
    withDetailedMentions: 1,
    withMentions: 1,
    withCaption: 3,
  });
});
