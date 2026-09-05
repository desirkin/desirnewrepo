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
const ACCEPTANCE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/;
const FILING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// STRUCTURALLY MALFORMED != UNKNOWN. UNKNOWN is acceptable only where the
// SEC source legitimately provides no value (an empty string in a column);
// a wrong type, a misaligned column, or an unparseable clock is corrupt
// structure and rejects the WHOLE response — corruption is never converted
// into legitimate-looking unknown information. Every column consumed for
// identity-bearing content is a REQUIRED aligned array in the official
// submissions schema.
const EDGAR_REQUIRED_COLUMNS = Object.freeze(['filingDate', 'acceptanceDateTime', 'primaryDocument', 'items']);

// primaryDocument is a SAFE SEC ARCHIVE LOCATOR or empty — never a
// traversal, an absolute URL, a protocol-relative reference, a query or
// fragment payload, a backslash trick, or control characters. Each path
// segment must start alphanumeric (which also excludes '.', '..', and
// empty segments) and stay in a closed safe charset, so the resolved
// document can never escape the filing's own archive directory.
export function safePrimaryDocument(doc) {
  if (typeof doc !== 'string') return null;
  if (doc === '') return ''; // legitimately absent — the accession index is used instead
  if (doc.length > 200) return null;
  for (const seg of doc.split('/')) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(seg)) return null;
  return doc;
}

// Strict fail-closed parse of one submissions document into bounded items
// for the whitelisted forms. A response for the wrong CIK, mismatched
// columnar arrays, or a corrupt selected row rejects the WHOLE response —
// partial trust is not trust. Each item's guid is the SEC-native accession
// number: the same filing re-encountered tomorrow, after a restart, or
// through a reordered response is the SAME source observation; an
// amendment is a different accession and stays a distinct observation.
//
// LOGICAL IDENTITY LAW (B1 closeout): ONE SEC FILING IS ONE LOGICAL SOURCE
// OBSERVATION. Every identity-bearing field of an item (title, summary,
// guid, link, publishedTs) is built ONLY from immutable filing-specific
// facts — CIK, accession, form, filing/acceptance clocks, stated items,
// primary document, and the stable archive link. The issuer's CURRENT
// display name (root.name) is mutable presentation metadata the SEC
// updates in place: it is deliberately excluded, so a company rename can
// never manufacture a "new" filing. The prepared transaction still binds
// all preserved immutable facts through the recomputed source identity, so
// an accession cannot be reused over silently altered filing facts.
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
  const recent = root.filings?.recent;
  if (recent === null || typeof recent !== 'object' || Array.isArray(recent)) return { ok: false, reason: 'filings.recent missing' };
  const acc = recent.accessionNumber;
  const form = recent.form;
  if (!Array.isArray(acc) || !Array.isArray(form) || acc.length !== form.length) return { ok: false, reason: 'filings.recent columnar arrays invalid' };
  // every identity-bearing column is REQUIRED and must align EXACTLY with
  // accessionNumber — a short, missing, or non-array auxiliary column is
  // structural corruption and rejects the whole response, so a partial
  // document can never mint a different identity for the same filing
  for (const name of EDGAR_REQUIRED_COLUMNS)
    if (!Array.isArray(recent[name]) || recent[name].length !== acc.length)
      return { ok: false, reason: `filings.recent.${name} missing or misaligned with accessionNumber` };
  const filingDate = recent.filingDate;
  const acceptance = recent.acceptanceDateTime;
  const primaryDoc = recent.primaryDocument;
  const itemsCol = recent.items;
  const items = [];
  // newest-first in the document; select the newest whitelisted filings,
  // then emit oldest-first so the evidence stream reads chronologically
  for (let i = 0; i < acc.length && items.length < EDGAR_MAX_ITEMS_PER_POLL; i++) {
    if (!formMatches(form[i], forms)) continue; // unlisted form: safely ignored, never guessed at
    const a = acc[i];
    if (typeof a !== 'string' || !ACCESSION_RE.test(a)) return { ok: false, reason: `selected filing carries malformed accession '${String(a).slice(0, 24)}'` };
    // selected-row strictness: wrong JS types and unparseable clocks are
    // corruption; ONLY the empty string is the SEC's legitimate "no value"
    const accepted = acceptance[i];
    if (typeof accepted !== 'string' || accepted.length > 40) return { ok: false, reason: `selected filing acceptanceDateTime wrong type or oversized` };
    if (accepted !== '' && !ACCEPTANCE_RE.test(accepted)) return { ok: false, reason: `selected filing carries malformed acceptanceDateTime '${accepted.slice(0, 32)}'` };
    const filed = filingDate[i];
    if (typeof filed !== 'string' || filed.length > 20) return { ok: false, reason: 'selected filing filingDate wrong type or oversized' };
    if (filed !== '' && !FILING_DATE_RE.test(filed)) return { ok: false, reason: `selected filing carries malformed filingDate '${filed.slice(0, 16)}'` };
    // point-in-time: publishedTs is the SEC's own stated clock (acceptance
    // datetime, else the filing date at UTC midnight); Serpent's knownAtTs
    // is assigned at observation by the collector and is NEVER backdated.
    let publishedTs = null;
    if (accepted !== '') {
      const t = Date.parse(accepted);
      if (!Number.isSafeInteger(t) || t <= 0) return { ok: false, reason: 'selected filing acceptanceDateTime unparseable' };
      publishedTs = t;
    } else if (filed !== '') {
      const t = Date.parse(`${filed}T00:00:00Z`);
      if (!Number.isSafeInteger(t) || t <= 0) return { ok: false, reason: 'selected filing filingDate unparseable' };
      publishedTs = t;
    }
    const doc = safePrimaryDocument(primaryDoc[i]);
    if (doc === null) return { ok: false, reason: `selected filing primaryDocument is not a safe SEC archive locator` };
    const link = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${a.replace(/-/g, '')}/${doc || `${a}-index.htm`}`.slice(0, 500);
    if (typeof itemsCol[i] !== 'string') return { ok: false, reason: 'selected filing items wrong type' };
    const filingItems = itemsCol[i].slice(0, 200);
    items.push({
      // immutable filing facts ONLY — never the issuer's mutable display name
      title: `SEC EDGAR filing ${boundedStr(form[i], 24)} accession ${a} (CIK ${cik})`.slice(0, MAX_TITLE_CHARS),
      summary: [
        `accession=${a}`,
        `form=${boundedStr(form[i], 24)}`,
        `cik=${cik}`,
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
  return { ok: true, items };
}
