import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBrandsInPost, detectGermanDisclosure } from './brandDetection.ts';

// Shaped like lib/brandAggregation.ts redetectFromStoredPost, which is what
// rewrites is_sponsored on stored posts.
const detect = (caption: string, extra: { hashtags?: string[]; taggedAccounts?: string[] } = {}) =>
  detectBrandsInPost({
    ownerUsername: '',
    caption,
    hashtags: extra.hashtags ?? [],
    taggedAccounts: extra.taggedAccounts ?? [],
    url: '',
    type: 'unknown',
  });

// ── Label positions ─────────────────────────────────────────────────────────

test('a leading "Anzeige" or "Werbung" is a sponsorship label', () => {
  // Real caption shapes from the 2026-10-11 dry run.
  for (const caption of [
    'Anzeige | Manche Dinge muss man einfach haben',
    'werbung| SHEIN SS26 Try on',
    'anzeige* some days you just want one pair of glasses',
    '[anzeige/ad] Ich war wieder für euch unterwegs',
    '*Anzeige | Meine Supplements sind von @oildemde',
    '🦎🦎 Anzeige @fashionnova new in',
    'Anzeige. Busy days.',
  ]) {
    const d = detect(caption);
    assert.equal(d.isSponsoredContent, true, caption);
  }
  assert.deepEqual(detect('Anzeige | x').detectionSignals, ['label:anzeige']);
  assert.deepEqual(detect('Werbung - shoppe bei uns').detectionSignals, ['label:werbung']);
});

test('after * | [ ( or before a colon, the label counts anywhere in the caption', () => {
  for (const caption of [
    'Meine bessere Hälfte 💞 | Anzeige',
    'Protein Popcorn Slices🍿*anzeige | Code: Dafina',
    'Folge mir für mehr\n*werbung/ad',
    'Neues Parfum (Werbung) von @brand',
    'Der Herbst ist da [Anzeige]',
    'Mein Lieblingsduft. Werbung: @brand',
  ]) {
    assert.equal(detect(caption).isSponsoredContent, true, caption);
  }
});

test('the word in running text is not a label', () => {
  for (const caption of [
    'Ich habe heute über Werbung im Fernsehen nachgedacht',
    'Werbungskosten absetzen – so geht es',   // compound: "Werbung" + more letters
    'Anzeigetafel am Bahnhof kaputt 😂',
    'just a piece of fabric and a cut // Anzeige', // "//" is not in the rule
    '501 🤍 Anzeige',                              // preceded by an emoji, not leading
  ]) {
    assert.equal(detect(caption).isSponsoredContent, false, caption);
  }
});

test('# and @ in front are not label positions', () => {
  // "#werbung" is a hashtag signal and comes from the hashtags array, not the
  // label rule; "@werbung_agentur" is a handle.
  assert.deepEqual(detectGermanDisclosure('#werbung neuer Look').labels, []);
  assert.deepEqual(detectGermanDisclosure('@werbung_agentur hat gepostet').labels, []);
  assert.equal(detect('#werbung neuer Look', { hashtags: ['werbung'] }).isSponsoredContent, true);
});

// ── "bezahlte Partnerschaft mit" ────────────────────────────────────────────

test('"bezahlte Partnerschaft mit" is a strong phrase', () => {
  const d = detect('Bezahlte Partnerschaft mit @brand – mein neuer Duft');
  assert.equal(d.isSponsoredContent, true);
  assert.ok(d.detectionSignals.includes('bezahlte partnerschaft mit'));
});

test('"unbezahlte Partnerschaft mit" does not contain a paid match', () => {
  assert.equal(detectGermanDisclosure('unbezahlte Partnerschaft mit dem Café').paidPhrase, false);
  assert.equal(detect('unbezahlte Partnerschaft mit dem Café').isSponsoredContent, false);
});

// ── Unpaid labels ───────────────────────────────────────────────────────────

test('unpaid labels are not sponsorship', () => {
  for (const caption of [
    'Beginnen wir jetzt eine neue Jagd? 👀 | unbezahlte Werbung #fyp',
    'Jeansgirl 💙 in blue denim Werbung durch Markennennung #levis',
    'Werbung wegen Markennennung: Jeans von Levis',
    'Anzeige unbezahlt | Bin so verliebt in diese Lampe',
    'meine eigenen Nageldesigns 🐱 keine Werbung, alles selber gekauft',
    'Werbung - selbst gekauft, ich liebe es',
    'Unbeauftragte Werbung | Schuhe von Birkenstock',
  ]) {
    assert.equal(detect(caption).isSponsoredContent, false, caption);
  }
});

test('an unpaid label switches off #werbung and the collab word beside a mention', () => {
  // Both were flagged before this change: #werbung as a hashtag signal, and
  // "@LUSH | unbezahlte Werbung" as a mention + collab word.
  assert.equal(detect('unbezahlte Werbung #werbung', { hashtags: ['werbung'] }).isSponsoredContent, false);
  assert.equal(detect('Ich bin schockiert 😭✨@LUSH | unbezahlte Werbung').isSponsoredContent, false);
});

test('an unpaid label does not switch off other signals', () => {
  const d = detect('unbezahlte Werbung für die Schuhe, #ad für die Tasche', { hashtags: ['ad'] });
  assert.equal(d.isSponsoredContent, true);
  assert.deepEqual(d.detectionSignals, ['#ad']);
  assert.equal(detect('In Kooperation mit @brand – Schuhe: unbezahlte Werbung').isSponsoredContent, true);
});

// ── Confidence ──────────────────────────────────────────────────────────────

test('a label scores like a sponsorship hashtag', () => {
  // Alone: medium, as #anzeige alone is.
  assert.equal(detect('Anzeige | neuer Look').detectionConfidence, 'medium');
  assert.equal(detect('neuer Look', { hashtags: ['anzeige'] }).detectionConfidence, 'medium');
  // With a tagged brand: high, as #anzeige with a tag is.
  assert.equal(detect('Anzeige | neuer Look', { taggedAccounts: ['zalando'] }).detectionConfidence, 'high');
});
