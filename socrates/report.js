// SOCRATES V2 — deterministic readable report (§10.1). The renderer adds NO opinion and NO recommendation: every
// paragraph is rebuilt from the validated JSON report and its packet, with the evidence ids each statement cites made
// inspectable. Eight required sections; a presentation target of roughly 500-900 words that never truncates a required
// reference. The same input bytes render the same Markdown.
import { canonicalJson } from '../evidence/contract-v2.js';

export const REPORT_RENDERER_VERSION = 'socrates-report-2.1';
const refs = (o) => { const all = [...(o?.evidenceRefs ?? []), ...(o?.claimRefs ?? []), ...(o?.sourceRefs ?? [])]; return all.length ? ` [refs: ${[...new Set(all)].sort().map((r) => r.slice(0, 16)).join(', ')}]` : ''; };
const line = (s) => String(s).replace(/\s+/g, ' ').trim();
const iso = (ms) => (Number.isSafeInteger(ms) ? new Date(ms).toISOString() : 'unknown');
const fam = (packet) => { const items = packet.evidence.filter((e) => e.sense === 'MARKET' && e.value && e.value.fields); const summary = items.find((e) => e.kind === 'MARKET_CONTEXT_SUMMARY'); return { items, summary }; };

export function renderReport({ analysis, packet, requests = [], runtime = {} }) {
  const out = []; const { items, summary } = fam(packet); const byId = new Map(packet.evidence.map((e) => [e.evidenceId, e]));
  const state = analysis.analysisState;
  out.push(`# Socrates research report — ${packet.subject.canonicalCoin} — as of ${iso(packet.asOfTs)}`);
  out.push('');
  out.push(`Analysis ${analysis.analysisId} over packet ${packet.packetId}. State: ${state}. Revision: ${analysis.revision.state}${analysis.revision.previousAnalysisId ? ` (previous ${analysis.revision.previousAnalysisId})` : ''}. Calibration: ${analysis.calibration.assessedAs}, calibrated=${analysis.calibration.calibrated}. Authority: NONE. Purpose: RESEARCH_ONLY.`);
  const pathLabel = runtime.path ?? 'NONE';
  const pathNote = pathLabel === 'RECORDED_RESPONSE' ? ' This analysis came from a RECORDED_RESPONSE (replay / test path): no live model judgement was made here.' : pathLabel === 'REUSED' ? ' This analysis was REUSED from an identical earlier request (no new model call).' : pathLabel === 'MODEL_REEVALUATION_NOW' ? ' This is a labelled MODEL_REEVALUATION_NOW over a replayed packet, not a point-in-time judgement.' : '';
  out.push(`Runtime: ${runtime.mode ?? 'UNKNOWN'} · path ${pathLabel} · model ${runtime.model ?? 'none'} · latency ${runtime.latencyMs ?? 'n/a'} ms · tokens in/out ${runtime.usage?.inputTokens ?? 'n/a'}/${runtime.usage?.outputTokens ?? 'n/a'} · estimated cost USD ${runtime.estimatedUsd ?? 'n/a'} (estimate).${pathNote}`);
  out.push('');
  // 1 observed
  out.push('## 1. What is observed, over which windows, with which coverage');
  const rc = packet.researchContext;
  out.push(`Mode ${rc.mode}; entrances ${rc.entrances.join(', ')}; coverage limitations: ${rc.coverageLimitations.length ? rc.coverageLimitations.join(', ') : 'none declared'}.`);
  if (summary) out.push(`Market context ${summary.value.fields.contextId} (recipe set ${summary.value.fields.recipeSetVersion}) with family states: ${Object.entries(summary.value.fields.familyStates).map(([f, s]) => `${f}=${s}`).join(', ')}. [refs: ${summary.evidenceId.slice(0, 16)}]`);
  for (const it of items.filter((e) => e.kind !== 'MARKET_CONTEXT_SUMMARY')) { const v = it.value; out.push(`- ${it.kind} (${it.state}; window ${v.windowStartTs === null ? 'point' : `${iso(v.windowStartTs)}..${iso(v.windowEndTs)}`}; known ${iso(v.knownAtTs)}; support ${v.support.state}${v.support.reasons.length ? ` — ${v.support.reasons.join(', ')}` : ''}) [refs: ${it.evidenceId.slice(0, 16)}]`); }
  for (const s of analysis.support.filter((x) => x.kind === 'FACT_REFERENCE')) out.push(`- FACT: ${line(s.text)}${refs(s)}`);
  out.push('');
  out.push('## 2. Mechanism that could explain the move; horizon and transmission path');
  if (state === 'ANALYZED') { out.push(`Thesis: ${line(analysis.thesis.text)}${refs(analysis.thesis)}`); out.push(`Mechanism: ${line(analysis.mechanism.description)}${refs(analysis.mechanism)}`); out.push(`Market implication (hypothesis, not a trade): direction ${analysis.marketImplication.direction}, horizon ${analysis.marketImplication.horizon}${refs(analysis.marketImplication)}`); out.push(`Stage (model hypothesis, uncalibrated): general ${analysis.stage.general}, pump stage ${analysis.stage.pumpStage}.`); }
  else out.push(`No mechanism is asserted: analysis state is ${state}.`);
  for (const h of analysis.hypotheses) out.push(`- ${h.hypothesisKey}: ${line(h.mechanism)}${refs(h)} supporting ${h.supportingEvidenceRefs.map((r) => r.slice(0, 16)).join(', ') || 'none'}; opposing ${h.opposingEvidenceRefs.map((r) => r.slice(0, 16)).join(', ') || 'none'}${h.unknowns.length ? `; unknowns: ${h.unknowns.map(line).join(' | ')}` : ''}`);
  for (const s of analysis.support.filter((x) => x.kind === 'INFERENCE')) out.push(`- INFERENCE: ${line(s.text)}${refs(s)}`);
  out.push('');
  out.push('## 3. Strongest competing explanation and contradictory evidence');
  out.push(`Alternative consideration: ${analysis.alternativeConsideration.state} — ${line(analysis.alternativeConsideration.explanation)}`);
  for (const c of analysis.contradictions) out.push(`- Contradiction: ${line(c.text)}${refs(c)}`);
  for (const c of packet.contradictions) out.push(`- Packet contradiction: ${line(c.description)} [refs: ${[...c.claimRefs, ...c.sourceRefs, ...c.evidenceRefs].map((r) => r.slice(0, 16)).join(', ')}]`);
  if (!analysis.contradictions.length && !packet.contradictions.length) out.push('No contradiction is recorded in the report or the packet.');
  out.push('');
  out.push('## 4. Participation/pressure, relative movement, liquidity/exit-capacity context');
  const pick = (kind) => items.filter((e) => e.kind === kind);
  for (const e of pick('MARKET_PRESSURE_RESPONSE_CHANGE')) { const f = e.value.fields; out.push(`- Pressure/response (${f.venue}): signed ${f.previousSigned} -> ${f.currentSigned} ${f.quote}; response ${f.previousResponseBps} -> ${f.currentResponseBps} bps; efficiency ${f.previousEfficiency} -> ${f.currentEfficiency} bps per million ${f.quote} (change ${f.efficiencyChange}); support ${e.value.support.state}. [refs: ${e.evidenceId.slice(0, 16)}]`); }
  for (const e of pick('MARKET_PEER_RELATIVE_MOVE')) { const f = e.value.fields; out.push(`- Peer-relative move: target ${f.targetReturnBps} bps vs median peer ${f.medianPeerReturnBps} bps; residual ${f.residualBps} bps; MAD ${f.madBps}; n=${f.n}; positive peers ${f.positivePeers}; support ${e.value.support.state}. [refs: ${e.evidenceId.slice(0, 16)}]`); }
  for (const e of pick('MARKET_DISPLAYED_EXIT_LIQUIDITY_CHANGE')) { const f = e.value.fields; out.push(`- Displayed exit capacity (${f.venue}, notional ${f.quoteNotional}): round-trip loss ${f.previousLossBps} -> ${f.currentLossBps} bps (change ${f.lossChangeBps}); coverage ${f.currentCoverage}; pre-fee ${f.preFee}. [refs: ${e.evidenceId.slice(0, 16)}]`); }
  for (const e of pick('MARKET_BOOK_CONTEXT')) { const f = e.value.fields; out.push(`- Book (${f.venue}): mid ${f.mid}, spread ${f.spreadBps} bps, microprice ${f.microprice}, age ${f.bookAgeMs} ms, synchronized ${f.synchronized}. [refs: ${e.evidenceId.slice(0, 16)}]`); }
  for (const e of pick('MARKET_CHART_WINDOW')) { const f = e.value.fields; out.push(`- Chart window (${f.venue}, ${f.windowMs} ms): close ${f.close}, log return ${f.logReturn}, notional ${f.quoteNotional}, count ${f.count}, relative notional ${f.relativeNotional}. [refs: ${e.evidenceId.slice(0, 16)}]`); }
  if (!items.some((e) => ['MARKET_PRESSURE_RESPONSE_CHANGE', 'MARKET_PEER_RELATIVE_MOVE', 'MARKET_DISPLAYED_EXIT_LIQUIDITY_CHANGE', 'MARKET_BOOK_CONTEXT', 'MARKET_CHART_WINDOW'].includes(e.kind))) out.push('No participation, relative-move or liquidity context is present in the packet.');
  out.push('');
  out.push('## 5. Slower supply/leverage/on-chain/macro context with its actual time scale');
  for (const e of items.filter((x) => ['MARKET_DERIVATIVES_CONTEXT', 'MARKET_LIQUIDATIONS_CONTEXT', 'MARKET_OPTIONS_CONTEXT', 'MARKET_SUPPLY_UNLOCKS', 'MARKET_DEX_DEFI_CONTEXT', 'MARKET_ONCHAIN_CONTEXT', 'MARKET_NETWORK_CONTEXT', 'MARKET_STABLECOIN_CONTEXT', 'MARKET_ETF_CONTEXT', 'MARKET_MACRO_CONTEXT', 'MARKET_CROSS_ASSET_CONTEXT'].includes(x.kind))) { const v = e.value; const age = Number.isSafeInteger(packet.asOfTs) && Number.isSafeInteger(v.knownAtTs) ? packet.asOfTs - v.knownAtTs : null; out.push(`- ${e.kind}: known ${iso(v.knownAtTs)} (age ${age} ms); ${v.windowStartTs === null ? 'point-in-time' : `window ${iso(v.windowStartTs)}..${iso(v.windowEndTs)}`}; support ${v.support.state}; ${line(canonicalJson(v.fields)).slice(0, 400)} [refs: ${e.evidenceId.slice(0, 16)}]`); }
  if (!items.some((x) => x.kind.startsWith('MARKET_') && !['MARKET_CONTEXT_SUMMARY', 'MARKET_PRESSURE_RESPONSE_CHANGE', 'MARKET_PEER_RELATIVE_MOVE', 'MARKET_DISPLAYED_EXIT_LIQUIDITY_CHANGE', 'MARKET_BOOK_CONTEXT', 'MARKET_CHART_WINDOW', 'MARKET_MICRO_CONTEXT', 'MARKET_MULTI_VENUE_CONTEXT', 'MARKET_EVENT_CONTEXT', 'MARKET_INFRA_CONTEXT'].includes(x.kind))) out.push('No slower-context family is present in the packet.');
  out.push('');
  out.push('## 6. What would disprove or materially change this interpretation');
  for (const f of analysis.falsifiers) out.push(`- If ${line(f.condition)} — why it matters: ${line(f.whyItMatters)} — watch: ${line(f.evidenceToWatch)}`);
  for (const h of analysis.hypotheses) for (const d of h.discriminators) out.push(`- Discriminator for ${h.hypothesisKey}: ${line(d.observable)}${d.requestKey ? ` (request ${d.requestKey})` : ''}${refs(d)}`);
  if (!analysis.falsifiers.length && !analysis.hypotheses.some((h) => h.discriminators.length)) out.push('No falsifier is stated (state is not ANALYZED).');
  out.push('');
  out.push('## 7. What specific additional observation is worth obtaining, and why');
  for (const r of analysis.dataRequests) { const res = requests.find((x) => x.requestKey === r.requestKey); out.push(`- ${r.requestKey} ${r.requestKind} ${r.family} [${r.metricIds.join(', ')}] on ${r.subjectRef}${r.windowStartTs !== null ? ` ${iso(r.windowStartTs)}..${iso(r.windowEndTs)}` : ''}${r.requestedMaxAgeMs !== null ? ` max age ${r.requestedMaxAgeMs} ms` : ''}${r.hypothesisRefs.length ? ` for ${r.hypothesisRefs.join('/')}` : ''}: ${line(r.question)} If supported: ${line(r.interpretationIfSupported)} If contradicted: ${line(r.interpretationIfContradicted)}${res ? ` — broker: ${res.state}${res.reason ? ` (${res.reason})` : ''}${res.requestId ? ` [${res.requestId.slice(0, 20)}]` : ''}` : ''}`); }
  for (const w of analysis.watchNext) out.push(`- Watch next: ${line(w.watch)}${refs(w)}`);
  if (!analysis.dataRequests.length && !analysis.watchNext.length) out.push('No additional observation is requested.');
  out.push('');
  out.push('## 8. Missing/partial data and whether it actually limits the conclusion');
  for (const m of analysis.missingEvidence) out.push(`- Missing (report): ${line(m.text)}`);
  for (const m of packet.missingEvidence) out.push(`- Missing (packet): ${m.kind} — ${line(m.description)}`);
  for (const u of analysis.unknowns) out.push(`- Unknown: ${line(u)}`);
  for (const l of analysis.limitations) out.push(`- Limitation: ${line(l)}`);
  for (const pc of packet.providerCoverage) out.push(`- Provider coverage (diagnostic, not evidence): ${pc.provider} ${pc.state}${pc.detail ? ` — ${line(pc.detail)}` : ''}`);
  out.push(`Security: untrusted text seen ${analysis.security.untrustedTextSeen}; prompt injection suspected ${analysis.security.promptInjectionSuspected}.${analysis.securityNotes.length ? ` Notes: ${analysis.securityNotes.map(line).join(' | ')}` : ''}`);
  out.push('');
  out.push(`_Rendered deterministically by ${REPORT_RENDERER_VERSION}; the renderer adds no opinion or recommendation. Cited ids resolve into packet ${packet.packetId}; ${byId.size} evidence items available._`);
  return `${out.join('\n')}\n`;
}
export const wordCount = (md) => md.split(/\s+/).filter(Boolean).length;
