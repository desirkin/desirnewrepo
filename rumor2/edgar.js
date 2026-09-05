// RUMOR-2B1 — bounded fail-closed parsing of SEC EDGAR submissions
// documents (data.sec.gov/submissions/CIK##########.json) into provider
// items for the EXISTING RUMOR-2 evidence pipeline. Fetching is separate
// from believing: an HTTP 200 does not make contents valid, and everything
// this module accepts still passes the one authoritative prepared-
// transaction trust gate before it may become dark research truth.
//
// The universe is deliberately bounded: a configured CIK whitelist and a
// configured form whitelist (RUMOR2_EDGAR_CIKS / RUMOR2_EDGAR_FORMS), one
// CIK polled per cycle. Serpent never scans all of EDGAR, and a form type
// is evidence metadata — never a conclusion, never a coin, never a market
// implication.
import { MAX_TITLE_CHARS, MAX_SUMMARY_CHARS } from './truth.js';

export const EDGAR_MAX_ITEMS_PER_POLL = 16; // newest whitelisted filings per response
export const EDGAR_MAX_CIKS = 32; // bounded whitelist — never a market-wide scan

// The initial form scope this ear can observe. A configured entry matches a
// form exactly, or that form's SEC-distinguished amendment ("8-K" also
// admits "8-K/A" — the amendment stays a DISTINCT filing with its own
// accession identity and its verbatim form string); an entry ending in '*'
// is an explicit family prefix (424B* admits 424B2..424B5 and their
// amendments). Nothing else matches — an unlisted form is safely ignored.
export const EDGAR_DEFAULT_FORMS = Object.freeze(['8-K', '6-K', 'S-1', 'S-3', '424B*', 'SC 13D', 'SC 13G']);

export const edgarSubmissionsUrl = (cik) => `https://data.sec.gov/submissions/CIK${cik}.json`;

// Strict configuration parsing — fail closed, never silently drop entries:
// one bad token unconfigures the ear with a truthful reason instead of
// quietly narrowing the whitelist.
export function parseEdgarConfig(ciksRaw, formsRaw) {
  const ciks = [];
  for (const tok of String(ciksRaw ?? '').split(',')) {
    const t = tok.trim();
    if (t === '') continue;
    if (!/^\d{1,10}$/.test(t)) return { ok: false, reason: `invalid CIK entry '${t.slice(0, 20)}'` };
    const padded = t.padStart(10, '0');
    if (!ciks.includes(padded)) ciks.push(padded);
  }
  if (ciks.length > EDGAR_MAX_CIKS) return { ok: false, reason: `CIK whitelist exceeds bound ${EDGAR_MAX_CIKS}` };
  const forms = [];
  for (const tok of String(formsRaw ?? '').split(',')) {
    const t = tok.trim().toUpperCase();
    if (t === '') continue;
    if (!/^[A-Z0-9 /-]{1,20}\*?$/.test(t)) return { ok: false, reason: `invalid form entry '${t.slice(0, 24)}'` };
    if (!forms.includes(t)) forms.push(t);
  }
  return { ok: true, ciks, forms: forms.length > 0 ? forms : [...EDGAR_DEFAULT_FORMS] };
}

export function formMatches(form, whitelist) {
  if (typeof form !== 'string' || form.length === 0) return false;
  const f = form.toUpperCase();
  for (const w of whitelist) {
    if (w.endsWith('*')) {
      if (f.startsWith(w.slice(0, -1))) return true;
    } else if (f === w || f === `${w}/A`) return true;
  }
  return false;
}

const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;
const boundedStr = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// Strict fail-closed parse of one submissions document into bounded items
// for the whitelisted forms. A response for the wrong CIK, mismatched
// columnar arrays, or a corrupt selected row rejects the WHOLE response —
// partial trust is not trust. Each item's guid is the SEC-native accession
// number: the same filing re-encountered tomorrow, after a restart, or
// through a reordered response is the SAME source observation; an
// amendment is a different accession and stays a distinct observation.
export function parseEdgarSubmissions(text, { cik, forms }) {
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable submissions JSON' };
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return { ok: false, reason: 'submissions root not an object' };
  const gotCik = String(root.cik ?? '').padStart(10, '0');
  if (gotCik !== cik) return { ok: false, reason: `submissions CIK ${gotCik.slice(0, 12)} disagrees with requested ${cik}` };
  const entity = boundedStr(root.name, 200) || `CIK ${cik}`;
  const recent = root.filings?.recent;
  if (recent === null || typeof recent !== 'object' || Array.isArray(recent)) return { ok: false, reason: 'filings.recent missing' };
  const acc = recent.accessionNumber;
  const form = recent.form;
  if (!Array.isArray(acc) || !Array.isArray(form) || acc.length !== form.length) return { ok: false, reason: 'filings.recent columnar arrays invalid' };
  const col = (name) => (Array.isArray(recent[name]) && recent[name].length === acc.length ? recent[name] : null);
  const filingDate = col('filingDate');
  const acceptance = col('acceptanceDateTime');
  const primaryDoc = col('primaryDocument');
  const itemsCol = col('items');
  const items = [];
  // newest-first in the document; select the newest whitelisted filings,
  // then emit oldest-first so the evidence stream reads chronologically
  for (let i = 0; i < acc.length && items.length < EDGAR_MAX_ITEMS_PER_POLL; i++) {
    if (!formMatches(form[i], forms)) continue; // unlisted form: safely ignored, never guessed at
    const a = acc[i];
    if (typeof a !== 'string' || !ACCESSION_RE.test(a)) return { ok: false, reason: `selected filing carries malformed accession '${String(a).slice(0, 24)}'` };
    const accepted = boundedStr(acceptance?.[i], 40);
    const filed = boundedStr(filingDate?.[i], 20);
    // point-in-time: publishedTs is the SEC's own stated clock (acceptance
    // datetime, else the filing date at UTC midnight); Serpent's knownAtTs
    // is assigned at observation by the collector and is NEVER backdated.
    let publishedTs = null;
    if (accepted && /^\d{4}-\d{2}-\d{2}T/.test(accepted)) {
      const t = Date.parse(accepted);
      if (Number.isSafeInteger(t) && t > 0) publishedTs = t;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(filed)) {
      const t = Date.parse(`${filed}T00:00:00Z`);
      if (Number.isSafeInteger(t) && t > 0) publishedTs = t;
    }
    const doc = boundedStr(primaryDoc?.[i], 200);
    const link = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${a.replace(/-/g, '')}/${doc || `${a}-index.htm`}`.slice(0, 500);
    const filingItems = boundedStr(itemsCol?.[i], 200);
    items.push({
      title: `SEC EDGAR filing ${boundedStr(form[i], 24)}: ${entity} (CIK ${cik})`.slice(0, MAX_TITLE_CHARS),
      summary: [
        `accession=${a}`,
        `form=${boundedStr(form[i], 24)}`,
        `cik=${cik}`,
        `entity=${entity}`,
        `filed=${filed || 'UNKNOWN'}`,
        `accepted=${accepted || 'UNKNOWN'}`,
        `items=${filingItems || 'NONE_STATED'}`,
        `primaryDocument=${doc || 'NONE_STATED'}`,
      ]
        .join('; ')
        .slice(0, MAX_SUMMARY_CHARS),
      link,
      guid: a, // SEC-native immutable filing identity — the accession number
      publishedTs,
    });
  }
  items.reverse();
  return { ok: true, items, entity };
}
