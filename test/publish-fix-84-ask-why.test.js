// PUBLISH-FIX-84 — the Ask box says in plain words what keeps the free-form answer off (the owner asked "why didn't you buy X" and
// "how is the weather" and was told the box can't answer; the notice above the box was not enough). Names only, never values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { askWhyNotChatText as askWhyNotChat } from '../paper/companion.js';

test('FIX84-ASK1. every off-state names the exact Replit Secret NAME or switch to fix; on-state is null', () => {
  assert.match(askWhyNotChat({ status: { state: 'NOT_CONFIGURED', reason: 'CREDENTIAL_MISSING' } }), /ANTHROPIC_API_KEY/);
  const budget = askWhyNotChat({ status: { state: 'NOT_CONFIGURED', reason: 'BUDGET_NOT_CONFIGURED' } });
  assert.match(budget, /SERPENT_CHAT_MAX_USD_PER_REQUEST/); assert.match(budget, /SERPENT_TALK_DAILY_USD/);
  assert.match(askWhyNotChat({ status: { state: 'NOT_CONFIGURED', reason: 'MODEL_NOT_KNOWN' } }), /SERPENT_CHAT_MODEL/);
  assert.match(askWhyNotChat({ status: { state: 'READY' }, meter: { dormant: true, reason: 'TOGGLE_OFF' } }), /ASK switch/);
  assert.match(askWhyNotChat({ status: { state: 'READY' }, meter: { dormant: true, reason: 'CAP_REACHED', capUsd: 2 } }), /2 USD/);
  assert.match(askWhyNotChat({ status: { state: 'READY' }, meter: { dormant: true, reason: 'CAP_DISABLED' } }), /SERPENT_TALK_DAILY_USD/);
  assert.equal(askWhyNotChat({ status: { state: 'READY' }, meter: { dormant: false } }), null);
  for (const s of [askWhyNotChat({ status: { state: 'NOT_CONFIGURED', reason: 'BUDGET_NOT_CONFIGURED' } })]) assert.ok(!/sk-|password/i.test(s), 'names, never values');
});
