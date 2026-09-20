// PUBLISH-FIX-88 (2026-09-20) — the Ask knows the coins the run knows. The owner asked "why didn't you buy brev" and "gst" about
// coins the cockpit was showing him (Wide Eye ripples); the Ask answered "no record for BREV in this run" because a bare word
// only became a coin when the question carried it in UPPER CASE. classify() now resolves a bare word against `knownCoins` first
// (case-insensitive, aliases still first), and ui/server.js hands it the union of the universe, the watch, the senses' attention
// and the Judge's candidates, then grounds the answer in what the senses have SEEN (ui/server.js seenByTheSenses).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, answerQuestion } from '../paper/companion.js';

test('FIX88-1. a lower-case bare word that names a known coin is that coin; unknown bare words still need UPPER CASE; aliases win', () => {
  const known = new Set(['BREV', 'GST', 'AKE']);
  assert.equal(classify('why didn\'t you buy brev', { knownCoins: known }).symbol, 'BREV');
  assert.equal(classify('Why did you skip gst?', { knownCoins: known }).symbol, 'GST');
  assert.equal(classify('why didn\'t you buy brev').symbol, null, 'without a catalog the old rule stands');
  assert.equal(classify('why didn\'t you buy zzzq', { knownCoins: known }).symbol, null, 'a word the run does not know is not a coin');
  assert.equal(classify('how is the weather', { knownCoins: new Set(['THE']) }).symbol, null, 'stop words never become coins');
  assert.equal(classify('why didn\'t you buy bitcoin', { knownCoins: known }).symbol, 'BTC', 'aliases still win');
  assert.equal(classify('why didn\'t you buy brev', { knownCoins: known }).intent, 'WHY_SKIP');
});

test('FIX88-2. answerQuestion threads knownCoins through to the symbol it answers about', async () => {
  const a = await answerQuestion({ question: 'why did you not buy ake', knownCoins: new Set(['AKE']) });
  assert.equal(a.symbol, 'AKE'); assert.equal(a.intent, 'WHY_SKIP');
});

test('FIX88-3. the cockpit server builds the catalog from the universe, the watch, the attention and the candidates, and grounds a coin answer in what the senses saw', () => {
  const src = readFileSync(new URL('../ui/server.js', import.meta.url), 'utf8');
  assert.match(src, /function knownCoinsForAsk\(\)/); assert.match(src, /attentionSymbols\(\)/); assert.match(src, /readCurrentUniverse\(\)/);
  assert.match(src, /answerQuestion\(\{ question, judge, sensors, research, journalPage: askJournalPage, knownCoins \}\)/);
  assert.match(src, /async function seenByTheSenses\(coin\)/); assert.match(src, /Seen by the senses/);
  const av = readFileSync(new URL('../ui/attention-view.js', import.meta.url), 'utf8'); assert.match(av, /export function attentionSymbols/);
});
