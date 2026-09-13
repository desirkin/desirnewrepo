// SOCIAL-5B §7b — THE RETAINED RELATIONAL LAWS OF A PROJECTION, WRITTEN ONCE.
//
// A projection copies structures whose MEANING lives in the law that produced them. Copying the nodes and edges of a
// dependency manifest while checking only that each member has the right keys keeps the shape and loses the graph:
// a duplicate node identity, an edge naming a node that is not there, a self-dependency, a repeated edge, a derived
// node dated before its parent, or a cycle all survived projection even though the originating
// `validateDependencyManifest` refuses every one of them. Those relationships are the reason the graph can be used
// for transitive grouping at all, so they must survive the copy.
//
// This module states those retained relationships ONCE, for generation, snapshot reopening, feature reopening and
// evaluation alike. It mirrors the upstream law over the PROJECTED representation; it never re-derives a dossier,
// invents a raw field or edits the upstream authority. Where the projection deliberately omits something the upstream
// validator needs, the omission is respected: a truncated manifest keeps its truncation disclosure and its
// DESCRIPTIVE_ONLY consequence rather than being completed with fabricated nodes.
import { fail, isPlainObject, isTs, isoOf } from './contracts.js';

// THE retained dependency-graph law. `derivationTs` is the clock the nodes fed (a dossier's own asOfTs upstream, the
// projected featureAsOfTs here); pass null only where no derivation clock is in scope for the record being checked.
export function dependencyGraphError(nodes, edges, { derivationTs = null, where = 'record' } = {}) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return `${where}: dependency nodes / edges malformed`;
  const byId = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (!isPlainObject(n)) return `${where}: dependency node ${i + 1} malformed`;
    if (typeof n.id !== 'string' || n.id.length === 0) return `${where}: dependency node ${i + 1} carries no identity`;
    // the upstream contract requires a clock on every node — it is not an optional field
    if (!isTs(n.knownAtTs)) return `${where}: dependency node ${i + 1} carries no knowledge clock`;
    if (derivationTs !== null && n.knownAtTs > derivationTs) return `${where}: dependency node ${i + 1} is known after the derivation it fed (${isoOf(derivationTs)})`;
    if (byId.has(n.id)) return `${where}: dependency node ${i + 1} repeats the identity of node ${byId.get(n.id).at + 1}`;
    byId.set(n.id, { at: i, node: n });
  }
  const out = new Map(); const indeg = new Map(); const seen = new Set();
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i];
    if (!isPlainObject(e) || typeof e.from !== 'string' || typeof e.to !== 'string') return `${where}: dependency edge ${i + 1} malformed`;
    const a = byId.get(e.from); const b = byId.get(e.to);
    if (!a || !b) return `${where}: dependency edge ${i + 1} names a node this projection does not carry`;
    if (e.from === e.to) return `${where}: dependency edge ${i + 1} is a self-dependency`;
    const key = `${e.from}>${e.to}>${e.relation}`;
    if (seen.has(key)) return `${where}: dependency edge ${i + 1} repeats an earlier edge`; seen.add(key);
    // a derived node can never be known BEFORE the parent it derives from
    if (a.node.knownAtTs > b.node.knownAtTs) return `${where}: dependency edge ${i + 1} derives a node known before its parent`;
    if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  // acyclic (Kahn) — equal clocks are lawful, a cycle among them is not
  const q = [...byId.keys()].filter((id) => !indeg.has(id)); let visited = 0; const deg = new Map(indeg);
  while (q.length) { const id = q.shift(); visited += 1; for (const t of out.get(id) ?? []) { deg.set(t, deg.get(t) - 1); if (deg.get(t) === 0) q.push(t); } }
  if (visited !== byId.size) return `${where}: the retained dependency graph contains a cycle`;
  return null;
}
export const assertDependencyGraph = (nodes, edges, opts) => { const e = dependencyGraphError(nodes, edges, opts); if (e) fail('VALIDATION_FAILURE', e); };
