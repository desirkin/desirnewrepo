// MARKET LAB / SOCRATES v2 — authority fences in BOTH directions (B08) + import / lifecycle isolation (A12) + the exact
// composition seams (§12). Research may PRODUCE research output; it may never import or call orders, trading controls,
// risk, ledger, cost, Judge, Watch, Tape truth or the RUMOR-2 runtime. The live path (fly.js, tape, ledger, cost, state,
// controls, UI server) reaches the research modules only through the exact allowlisted seams below. Exact allowlists,
// never broad lexical removals. Samples ship disabled with environment variable NAMES only. The doctrine sentence stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { loadPolicy, loadSubjects } from '../market-lab/policy.js';
import { MARKET_RESEARCH_ROOTS } from '../market-lab/identity.js';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tracked = execSync("git ls-files '*.js' '*.mjs' '*.json' '*.md' '*.html'", { cwd: REPO, encoding: 'utf8' }).trim().split('\n');
const read = (f) => readFileSync(path.join(REPO, f), 'utf8');
const code = (f) => read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const imports = (f) => [...code(f).matchAll(/(?:^|\n)\s*(?:import\s[^;]*?from\s*|import\s*\(\s*|export\s[^;]*?from\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
const resolveRel = (f, spec) => (spec.startsWith('.') ? path.normalize(path.join(path.dirname(f), spec)).replace(/\\/g, '/') : spec);
const RESEARCH_FILES = tracked.filter((f) => /^(market-lab|socrates)\/.*\.js$/.test(f) || ['evidence/contract-v2.js', 'evidence/research-builder.js', 'evidence/social-projection.js', 'bin/market-research.js', 'bin/socrates-research.js'].includes(f));
// the LIVE path: everything that runs when fly.js runs, plus the modules that hold trading / control / risk truth
const LIVE_TRUTH_DIRS = ['tape', 'ledger', 'cost', 'state', 'gateway', 'governance', 'persistence', 'childhood', 'memory', 'rumint', 'survey', 'lib'];
const LIVE_FILES = tracked.filter((f) => f === 'fly.js' || f === 'ui/server.js' || LIVE_TRUTH_DIRS.some((d) => f.startsWith(`${d}/`))).filter((f) => f.endsWith('.js'));

test('B08 (research -> live): no research module imports orders, ledger, cost, state, controls, risk, Judge, Watch, the RUMOR-2 runtime or Tape truth; the ONLY crossings are the exact allowlisted pure imports', () => {
  const ALLOWED_CROSSINGS = {
    'market-lab/deep-market-adapter.js': ['rumor2/social-research-market.js'], // the v1 deep-market window CONTRACT (validateDeepMarketWindow), never the strainer / collector
    'evidence/social-projection.js': ['rumor2/social-research-dossier.js', 'rumor2/social-research-composite.js', 'rumor2/social-research-profile.js'], // pure validators / vocabularies of settled Social records
    'market-lab/providers/kraken-spot.js': ['tape/book.js', 'survey/catalog.js'], // the pure L2 book state machine + the Kraken catalog normalizer (no tape runtime)
    'market-lab/providers/coinbase.js': ['tape/book.js'],
  };
  assert.ok(RESEARCH_FILES.length >= 40, `research files ${RESEARCH_FILES.length}`);
  for (const f of RESEARCH_FILES) {
    for (const spec of imports(f)) {
      if (!spec.startsWith('.')) { assert.match(spec, /^node:/, `${f} imports a bare package ${spec}: no new dependencies`); continue; }
      const target = resolveRel(f, spec);
      const inside = /^(market-lab|socrates|evidence|bin)\//.test(target);
      if (!inside) assert.ok((ALLOWED_CROSSINGS[f] ?? []).includes(target), `${f} -> ${target} is not an allowlisted crossing`);
      assert.ok(!/^(ledger|cost|state|controls|orders|risk|judge|watch|execution|rumint|research|persistence|gateway|governance|childhood|memory)\//.test(target), `${f} -> ${target} crosses an authority fence`);
      assert.ok(!/^rumor2\/(collector|journal|checkpoint|social-research-strainer|social-collector)/.test(target), `${f} -> ${target} reaches the RUMOR-2 runtime`);
      assert.ok(!/^tape\/(run|micro|features|heartbeat|integrity)/.test(target), `${f} -> ${target} reaches Tape truth`);
    }
    // code lines (comments dropped) never carry an execution / control verb as an identifier
    assert.ok(!/\b(placeOrder|submitOrder|createOrder|cancelOrder|paperFill|applyFill|setPosture|KILL_SWITCH|startRumor2|runTape|createResearchStrainer)\b/.test(code(f)), `${f} names an execution / control identifier`);
  }
  for (const [f, targets] of Object.entries(ALLOWED_CROSSINGS)) { assert.ok(existsSync(path.join(REPO, f)), f); for (const t of targets) assert.ok(existsSync(path.join(REPO, t)), t); }
  // the pure crossings are pure: none of them imports a runtime
  for (const t of ['rumor2/social-research-market.js', 'rumor2/social-research-dossier.js', 'rumor2/social-research-composite.js', 'rumor2/social-research-profile.js', 'tape/book.js', 'survey/catalog.js']) for (const spec of imports(t)) assert.ok(spec.startsWith('node:') || /^\.\.?\//.test(spec) && !/collector|journal|run\.js|strainer|ledger|cost\/|state\//.test(spec), `${t} -> ${spec}`);
});

test('B08 (live -> research): the live path never imports research/, socrates/ or evidence v2; market-lab is reached ONLY by fly.js (service, commands, deep-market adapter) and the read-only UI server (paths); Tape, ledger, cost, state, gateway, governance never mention the research modules', () => {
  const ALLOWED = { 'fly.js': ['market-lab/deep-market-adapter.js', 'market-lab/service.js', 'market-lab/commands.js', 'market-lab/paths.js'], 'ui/server.js': ['market-lab/paths.js', 'market-lab/time.js'], 'persistence/social-research-export.js': ['research/'] };
  assert.ok(LIVE_FILES.length >= 30, `live files ${LIVE_FILES.length}`);
  for (const f of LIVE_FILES) {
    for (const spec of imports(f)) {
      if (!spec.startsWith('.')) continue; const target = resolveRel(f, spec);
      if (/^(market-lab|socrates|research|bin)\//.test(target) || /^evidence\/(contract-v2|research-builder|social-projection)\.js$/.test(target)) assert.ok((ALLOWED[f] ?? []).some((a) => target === a || target.startsWith(a)), `${f} -> ${target} is not an allowlisted live -> research seam`);
    }
  }
  for (const f of LIVE_FILES.filter((f) => /^(tape|ledger|cost|state|gateway|governance)\//.test(f))) assert.ok(!/market-lab|socrates\/|research-builder|social-projection|createResearchService|createCaseRuntime/.test(code(f)), `${f} mentions the research modules`);
  // ui/server.js: the research routes are file-based reads; no enqueue, no toggle, no write
  const ui = read('ui/server.js'); const a = ui.indexOf('function marketResearchSummary'); const b = ui.indexOf('function marketResearchCase'); const c = ui.indexOf('\n}', b);
  const helpers = ui.slice(a, c); assert.ok(helpers.length > 100); assert.ok(!/writeFile|appendFile|unlink|rename|mkdir|spawn|exec|fetch\(|enqueue|createResearch|process\.env\.\w+\s*=/.test(helpers), 'the UI research helpers only read');
});

test('§12 composition seams are exact: fly.js opt-in guard + deep-market adapter + Tape observer; tape/run.js observer is optional / guarded / after its own truth; rumor2/collector.js exposes the detached read-only projection in BOTH the enabled and the dark return; the config / lockfile carry no research key', () => {
  const fly = read('fly.js');
  assert.ok(fly.includes("if (process.env.MARKET_RESEARCH_ENABLED === 'true') {"), 'the research owner is an explicit env opt-in');
  assert.ok(fly.includes('let marketResearch = null;'), 'default: no research service');
  assert.ok(fly.includes('deepMarketSource: marketResearch ? createDeepMarketSource(marketResearch.owner) : null,'), 'the strainer receives the adapter ONLY when the owner exists');
  assert.ok(fly.includes('await runTape({ executionFeed: judgeRun ? judgeRun.tapeFeed : null, observer: marketResearch ? marketResearch.observer : null })'), 'the Tape observer seam AND the execution feed seam are null by default');
  assert.ok(fly.includes("import { createDeepMarketSource } from './market-lab/deep-market-adapter.js';"));
  assert.ok(!/MARKET_RESEARCH_ENABLED\s*=[^=]|RUMOR2_.*MARKET_RESEARCH|MARKET_RESEARCH.*RUMOR2_/.test(code('fly.js')), 'paid authorization is never inferred from RUMOR-2 flags');
  assert.ok(fly.indexOf('startRumor2(') < fly.indexOf('await runTape(') && fly.indexOf('marketResearch.stop()') > fly.indexOf('await runTape('), 'stop after the tape drained');
  const tape = read('tape/run.js');
  assert.ok(tape.includes('observer = null }'), 'observer defaults to null'); assert.ok(tape.includes('if (!observer) return;'), 'no observer => no call'); assert.ok(/observerErrors \+= 1/.test(tape), 'an observer exception is counted, never thrown into the tape');
  assert.ok(tape.indexOf('micro.onTrade(') < tape.indexOf('observer.onTrade('), 'the tape writes its own truth BEFORE the observer copy'); assert.ok(!/observer\.\w+\([^)]*\)\s*(\.then|await)/.test(tape), 'the observer is never awaited');
  const col = read('rumor2/collector.js'); assert.ok(col.includes('researchProjection: () => null'), 'dark collector: projection null'); assert.ok(col.includes('researchProjection: (coin, { asOfTs'), 'enabled collector: the read-only projection accessor');
  const cfg = read('cobra.config.json'); assert.ok(!/MARKET_RESEARCH|market-lab|socrates|anthropic|ANTHROPIC/i.test(cfg), 'cobra.config.json carries no research / model key (the opt-in is env NAMES only)');
  const lock = existsSync(path.join(REPO, 'package-lock.json')) ? read('package-lock.json') : ''; assert.ok(!/anthropic|ws"|websocket/i.test(lock), 'no new dependency');
  const pkg = JSON.parse(read('package.json')); assert.deepEqual(Object.keys(pkg.dependencies ?? {}).filter((d) => /anthropic|openai|ws$|axios|node-fetch/.test(d)), []);
});

test('A12 import isolation: importing every research module (providers, owner, service, runtime, both CLIs) in a fresh process performs no network, no listen, no write, no timer and no process.exit; the code identity roots are the four composition roots', () => {
  const files = RESEARCH_FILES.filter((f) => !f.endsWith('.test.js'));
  const script = `
    import { createRequire } from 'node:module'; import net from 'node:net'; import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https';
    const hits = []; const trip = (name) => (...a) => { hits.push(name); throw new Error('tripwire ' + name); };
    net.Server.prototype.listen = trip('listen'); http.request = trip('http.request'); https.request = trip('https.request'); http.get = trip('http.get'); https.get = trip('https.get');
    globalThis.fetch = trip('fetch'); globalThis.WebSocket = class { constructor() { hits.push('websocket'); throw new Error('tripwire websocket'); } };
    for (const k of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'renameSync', 'rmSync']) fs[k] = trip('fs.' + k);
    const openSync = fs.openSync; fs.openSync = (p, flags, ...rest) => { if (flags !== undefined && /[wa+]/.test(String(flags))) { hits.push('fs.openSync(write)'); throw new Error('tripwire open for write'); } return openSync(p, flags, ...rest); }; // the module loader itself reads through openSync
    const timers = []; const st = globalThis.setTimeout; globalThis.setTimeout = (...a) => { timers.push('setTimeout'); return st(...a); }; const si = globalThis.setInterval; globalThis.setInterval = (...a) => { timers.push('setInterval'); return si(...a); };
    const exit = process.exit; process.exit = (c) => { hits.push('exit'); throw new Error('tripwire exit'); };
    const files = ${JSON.stringify(files)}; const loaded = [];
    for (const f of files) { await import('${REPO}/' + f); loaded.push(f); }
    process.stdout.write(JSON.stringify({ loaded: loaded.length, hits, timers }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO, encoding: 'utf8', timeout: 60_000 }));
  assert.equal(out.loaded, files.length); assert.deepEqual(out.hits, []); assert.deepEqual(out.timers, []);
  assert.deepEqual([...MARKET_RESEARCH_ROOTS], ['bin/market-research.js', 'bin/socrates-research.js', 'market-lab/deep-market-adapter.js', 'market-lab/service.js']);
});

test('samples ship DISABLED: every provider off, model off, every dollar cap 0, credentials by environment variable NAME only, no value-like strings; both samples load under the real validators; the UI research drawer has no trade / order / paid control', () => {
  const policy = JSON.parse(read('market-lab/samples/policy.sample.json')); const subjects = JSON.parse(read('market-lab/samples/subjects.sample.json'));
  const p = loadPolicy(policy); const s = loadSubjects(subjects); assert.ok(p.providers && s.subjects.length >= 1);
  for (const [id, prov] of Object.entries(policy.providers)) { assert.equal(prov.enabled, false, `${id} enabled in the sample`); if (prov.credentialEnv !== null) assert.match(prov.credentialEnv, /^[A-Z][A-Z0-9_]*$/, `${id} credentialEnv must be a NAME`); assert.ok(!('apiKey' in prov) && !('token' in prov) && !('secret' in prov)); }
  assert.equal(policy.model.enabled, false); for (const cap of ['maxEstimatedUsdPerCase', 'maxEstimatedUsdPerDay', 'maxEstimatedUsdPerMonth', 'totalSmokeMaxEstimatedUsd']) assert.equal(policy.model[cap], 0, cap); assert.match(policy.model.credentialEnv, /^[A-Z][A-Z0-9_]*$/);
  const raw = read('market-lab/samples/policy.sample.json') + read('market-lab/samples/subjects.sample.json'); assert.ok(!/sk-ant|sk_live|Bearer |eyJ[A-Za-z0-9_-]{10,}|api[_-]?key['"]?\s*:\s*['"][A-Za-z0-9]{16,}/i.test(raw), 'no value-like secret');
  assert.ok(!/"approved"\s*:\s*true|"ownerApproval"|"attestation"\s*:\s*"[^"]+"/.test(read('market-lab/samples/policy.sample.json')), 'no owner approval value in shipped defaults');
  const html = read('ui/index.html'); const start = html.indexOf('<div id="research"'); const end = html.indexOf('<div id="demobadge"'); assert.ok(start > 0 && end > start);
  const drawer = html.slice(start, end); assert.ok(!/<button[^>]*>(?:(?!<\/button>).)*\b(buy|sell|order|strike|trade|paid|enable model|approve)\b/is.test(drawer), 'no trade / paid button in the research drawer');
  const js = html.slice(html.indexOf('function showResearch'), html.indexOf("$('#btnResearch')")); assert.ok(js.length > 200); assert.ok(!/method:\s*['"]POST|\/api\/(control|posture|order|trade|kill|cage|veto)/.test(js), 'the research view only reads'); assert.ok(js.includes('/api/market-research'));
});

const IDENTITY_RE = new RegExp(['fa', 'ble', '|my', 'thos'].join(''), 'i'); // assembled so this file never matches itself
test('no assistant / model-identity strings in tracked repository artifacts; the doctrine sentence is intact; the research model id lives ONLY in the policy default and samples', () => {
  for (const f of tracked) { if (f.startsWith('node_modules/') || f.startsWith('data/')) continue; assert.ok(!IDENTITY_RE.test(read(f)), `${f} carries a model-identity string`); }
  const doc = read('doctrine/SOCRATES.md'); assert.ok(doc.includes('**"I interpret evidence. I do not create truth."**')); assert.ok(doc.includes('That sentence is permanent. Every future Socrates ticket inherits it.'));
  const hits = tracked.filter((f) => f.endsWith('.js') && !f.startsWith('test/') && /claude-[a-z]+-\d/.test(code(f))); assert.deepEqual(hits, ['market-lab/policy.js'], 'the pinned research model id is declared once (policy default), never scattered');
});
