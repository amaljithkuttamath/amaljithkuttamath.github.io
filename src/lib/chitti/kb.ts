// kb.ts — the agent's knowledge base of what it can fetch, as a navigable tree.
//
// THE PROBLEM. `find_series` matches a user's phrase against indicator NAMES
// with keyword + synonym scoring (`scoring.ts`). Institutional catalogues are
// not written in user vocabulary, so it fails in measurable ways.
//
// Against the curated World Bank shortlist the failure is that nothing
// separates a good match from an impossible one — all three of these score 2:
//
//     "child mortality"  -> Mortality rate, UNDER-5              (correct)
//     "internet users"   -> INDIVIDUALS USING the Internet       (correct)
//     "banana exports"   -> (nothing the catalogue can serve)    (impossible)
//
// That is why the fast path's MIN_MATCH_SCORE sits at 4 and deliberately
// under-fires: with a flat scorer there is no threshold admitting the first two
// while refusing the third.
//
// The app's real search is broader than that shortlist — it also covers the
// shared OWID/IMF/WHO catalogue, whose slugs are often already in user
// vocabulary, so it does resolve some of these. Measured across all connected
// sources it still leaves "internet users" (2), "people with electricity" (3)
// and "women in parliament" (4) at or under the bar, returns nothing at all for
// "cost of living" and "deforestation", and — the case that matters most —
// answers "how long people live" with the CHILD MORTALITY series. Flat scoring
// does not merely miss; it is sometimes confidently wrong, which is why the KB
// is consulted BEFORE it rather than as its fallback.
//
// THE FIX, following PageIndex's vectorless idea: retrieval as NAVIGATION over
// a hierarchy, not similarity against a flat list. Two properties do the work:
//
//   1. INHERITED CONTEXT. A leaf is scored with its ancestors' titles and
//      aliases folded in, so "child mortality" reaches an under-5 series
//      through the group it lives in, without the leaf's own name containing
//      the word "child".
//
//   2. USER VOCABULARY AT EVERY NODE. Nodes carry the words people actually
//      type. These are authored, not fetched — and authoring them is safe in a
//      way that authoring numbers never is: an alias is a claim about
//      language, not about the world. A wrong alias surfaces the wrong series,
//      which the id guard and the citation then make obvious; it cannot invent
//      a value.
//
// Why a tree and not embeddings: Chitti has no backend. A vector index would
// need a server to host it or a multi-megabyte model in the browser, and an
// embedding call per query that BYOK users on free models often cannot make.
// A tree is composed at import time from data already bundled, costs no
// request, and — unlike a similarity score — explains itself: the path IS the
// reason the series was chosen.
import { INDICATORS } from './tools';
import { scoreSeries } from './scoring';
import { resolveSources } from './sources/index';

export interface KbNode {
  // Slash path, e.g. "health/mortality/SH.DYN.MORT". Stable and human-readable
  // so a receipt can show the route taken.
  path: string;
  title: string;
  // The words a person would actually use. Folded into this node's haystack
  // and inherited by everything beneath it.
  aliases: string[];
  // Leaf only: the id to hand to fetch_series, and which database serves it.
  seriesId?: string;
  source?: string;
  children: KbNode[];
}

// ── The authored layer ───────────────────────────────────────────────────────
// Sub-groups within each World Bank topic, and the vocabulary people bring to
// them. `indicators.json` gives 9 flat topics; these are the intermediate nodes
// that make navigation meaningful and give leaves something to inherit.
const GROUPS: { topic: string; group: string; aliases: string[]; ids: string[] }[] = [
  { topic: 'Economy', group: 'Output & income', aliases: ['economy size', 'national income', 'how rich', 'wealth', 'living standards', 'gdp'],
    ids: ['NY.GDP.MKTP.CD', 'NY.GDP.MKTP.KD.ZG', 'NY.GDP.PCAP.CD', 'NY.GDP.PCAP.PP.CD'] },
  { topic: 'Economy', group: 'Prices, jobs & debt', aliases: ['cost of living', 'prices', 'jobs', 'joblessness', 'government borrowing', 'public debt'],
    ids: ['FP.CPI.TOTL.ZG', 'SL.UEM.TOTL.ZS', 'GC.DOD.TOTL.GD.ZS'] },
  { topic: 'Economy', group: 'Trade & investment', aliases: ['trade', 'imports and exports', 'foreign investment', 'open economy'],
    ids: ['BX.KLT.DINV.WD.GD.ZS', 'NE.EXP.GNFS.ZS', 'NE.IMP.GNFS.ZS'] },

  { topic: 'Health', group: 'How long people live', aliases: ['lifespan', 'longevity', 'how long people live', 'life expectancy'],
    ids: ['SP.DYN.LE00.IN', 'SP.DYN.LE00.MA.IN', 'SP.DYN.LE00.FE.IN'] },
  { topic: 'Health', group: 'Child & maternal mortality', aliases: ['child mortality', 'child deaths', 'children dying', 'babies dying', 'infant mortality', 'maternal deaths', 'deaths in childbirth', 'under-5 mortality'],
    ids: ['SH.DYN.MORT', 'SP.DYN.IMRT.IN', 'SH.STA.MMRT'] },
  { topic: 'Health', group: 'Health systems & disease', aliases: ['healthcare', 'health spending', 'doctors', 'hospitals', 'vaccination', 'disease burden'],
    ids: ['SH.XPD.CHEX.GD.ZS', 'SH.MED.PHYS.ZS', 'SH.IMM.MEAS', 'SH.HIV.INCD.ZS'] },

  { topic: 'Population & Demographics', group: 'Population size & growth', aliases: ['how many people', 'population', 'headcount', 'migration'],
    ids: ['SP.POP.TOTL', 'SP.POP.GROW', 'SM.POP.NETM'] },
  { topic: 'Population & Demographics', group: 'Age, births & cities', aliases: ['birth rate', 'how many children per woman', 'ageing', 'old people', 'urbanisation', 'city living'],
    ids: ['SP.DYN.TFRT.IN', 'SP.POP.65UP.TO.ZS', 'SP.URB.TOTL.IN.ZS'] },

  { topic: 'Education', group: 'Schooling & literacy', aliases: ['school', 'education', 'reading and writing', 'literacy', 'university', 'college', 'enrolment'],
    ids: ['SE.ADT.LITR.ZS', 'SE.SEC.ENRR', 'SE.TER.ENRR', 'SE.PRM.CMPT.ZS', 'SE.XPD.TOTL.GD.ZS'] },

  { topic: 'Poverty & Inequality', group: 'Poverty & income distribution', aliases: ['poverty', 'extreme poverty', 'poor people', 'inequality', 'income gap', 'rich vs poor'],
    ids: ['SI.POV.DDAY', 'SI.POV.GINI', 'SI.DST.10TH.10', 'SI.DST.FRST.10'] },

  { topic: 'Environment & Climate', group: 'Emissions & energy', aliases: ['carbon', 'carbon emissions', 'co2', 'greenhouse gas', 'climate', 'energy use', 'renewables', 'clean energy'],
    ids: ['EN.GHG.CO2.MT.CE.AR5', 'EN.GHG.CO2.PC.CE.AR5', 'EG.USE.ELEC.KH.PC', 'EG.FEC.RNEW.ZS'] },
  { topic: 'Environment & Climate', group: 'Land & water', aliases: ['forests', 'deforestation', 'trees', 'water', 'freshwater'],
    ids: ['AG.LND.FRST.ZS', 'ER.H2O.FWTL.ZS'] },

  { topic: 'Gender', group: 'Women in work & politics', aliases: ['women', 'gender gap', 'female workforce', 'women in parliament', 'girls in school'],
    ids: ['SL.TLF.CACT.FE.ZS', 'SG.GEN.PARL.ZS', 'SE.ENR.PRSC.FM.ZS'] },

  { topic: 'Trade & Business', group: 'Business & defence', aliases: ['doing business', 'business climate', 'military spending', 'defence budget', 'army'],
    ids: ['IC.BUS.EASE.XQ', 'BX.GSR.TOTL.CD', 'MS.MIL.XPND.GD.ZS'] },

  { topic: 'Technology & Infrastructure', group: 'Connectivity & electricity', aliases: ['internet', 'internet users', 'online', 'being online', 'mobile phones', 'electricity', 'power access'],
    ids: ['IT.NET.USER.ZS', 'IT.CEL.SETS.P2', 'EG.ELC.ACCS.ZS'] },
];

// Per-series vocabulary, where the catalogue name is furthest from what people
// say. Only the ones that need it — an entry is a fix for a real miss, not
// decoration.
const SERIES_ALIASES: Record<string, string[]> = {
  'SH.DYN.MORT': ['child mortality', 'under-5 mortality', 'child death rate', 'children dying before five'],
  'SP.DYN.IMRT.IN': ['infant mortality', 'baby deaths', 'deaths before age one'],
  'SH.STA.MMRT': ['maternal mortality', 'mothers dying in childbirth'],
  'IT.NET.USER.ZS': ['internet users', 'internet access', 'internet penetration', 'share of people online'],
  'IT.CEL.SETS.P2': ['mobile phones', 'cell phones', 'phone subscriptions'],
  'EG.ELC.ACCS.ZS': ['electricity access', 'people with electricity', 'electrification'],
  'SP.DYN.LE00.IN': ['life expectancy', 'lifespan', 'how long people live'],
  'FP.CPI.TOTL.ZG': ['inflation', 'rising prices', 'cost of living increase'],
  'SL.UEM.TOTL.ZS': ['unemployment', 'unemployment rate', 'jobless rate', 'out of work'],
  'NY.GDP.PCAP.CD': ['gdp per capita', 'income per person', 'average income'],
  'NY.GDP.PCAP.PP.CD': ['gdp per capita ppp', 'purchasing power', 'ppp income'],
  'SI.POV.DDAY': ['extreme poverty', 'people living in poverty', 'poverty rate'],
  'SI.POV.GINI': ['inequality', 'gini', 'income inequality'],
  'EN.GHG.CO2.PC.CE.AR5': ['co2 per capita', 'carbon emissions per person', 'emissions per head'],
  'EN.GHG.CO2.MT.CE.AR5': ['total co2 emissions', 'carbon emissions', 'national emissions'],
  'SE.ADT.LITR.ZS': ['literacy', 'literacy rate', 'can read and write'],
  'SP.POP.TOTL': ['population', 'how many people live'],
  'SP.DYN.TFRT.IN': ['fertility rate', 'birth rate', 'children per woman'],
  'AG.LND.FRST.ZS': ['forest cover', 'deforestation', 'forest area'],
  'EG.FEC.RNEW.ZS': ['renewable energy', 'clean energy share'],
  'SH.XPD.CHEX.GD.ZS': ['health spending', 'healthcare expenditure'],
  'SH.MED.PHYS.ZS': ['doctors per person', 'physicians'],
  'MS.MIL.XPND.GD.ZS': ['military spending', 'defence spending'],
};

// ── Tree construction ────────────────────────────────────────────────────────
// Composed at import time from bundled data — no request, no data file.
function buildWorldBank(): KbNode {
  const byId = new Map(INDICATORS.map((i) => [i.id, i]));
  const topics = new Map<string, KbNode>();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  for (const g of GROUPS) {
    let topicNode = topics.get(g.topic);
    if (!topicNode) {
      topicNode = { path: `worldbank/${slug(g.topic)}`, title: g.topic, aliases: [], children: [] };
      topics.set(g.topic, topicNode);
    }
    const groupNode: KbNode = {
      path: `${topicNode.path}/${slug(g.group)}`,
      title: g.group,
      aliases: g.aliases,
      children: [],
    };
    for (const id of g.ids) {
      const ind = byId.get(id);
      if (!ind) continue; // the shortlist changed under us — skip, never invent
      groupNode.children.push({
        path: `${groupNode.path}/${id}`,
        title: ind.name,
        aliases: SERIES_ALIASES[id] ?? [],
        seriesId: id,
        source: 'worldbank',
        children: [],
      });
    }
    if (groupNode.children.length) topicNode.children.push(groupNode);
  }
  // A topic's vocabulary is the union of its groups'. Authored once at the
  // group level and rolled up, so the top level a model sees first is
  // navigable without a second authored table to keep in sync.
  for (const t of topics.values()) {
    t.aliases = [...new Set(t.children.flatMap((g) => g.aliases))].slice(0, 12);
  }
  return {
    path: 'worldbank',
    title: 'World Bank Open Data',
    aliases: ['world bank', 'development indicators'],
    children: [...topics.values()],
  };
}

// The catalogue sources (OWID/IMF/WHO) keep their curated lists as one group
// each: they are small enough that a deeper hierarchy would add nothing.
function buildCatalogSource(id: string, label: string, curated: { id: string; name: string }[]): KbNode {
  return {
    path: id,
    title: label,
    aliases: [label.toLowerCase()],
    children: curated.map((c) => ({
      path: `${id}/${c.id}`,
      title: c.name,
      aliases: SERIES_ALIASES[c.id] ?? [],
      seriesId: c.id,
      source: id,
      children: [],
    })),
  };
}

export function buildKb(sourceIds?: string[]): KbNode {
  const active = resolveSources(sourceIds);
  const children: KbNode[] = [];
  for (const s of active) {
    if (s.id === 'worldbank') children.push(buildWorldBank());
    else if (s.curated.length) children.push(buildCatalogSource(s.id, s.label, s.curated));
  }
  return { path: '', title: 'Knowledge base', aliases: [], children };
}

// ── Navigation ───────────────────────────────────────────────────────────────

// The bar a KB hit must clear to be acted on. Set from the measured spread, not
// picked: across the eval set every correct match scores 22 or above, while the
// queries the catalogue genuinely cannot serve ("banana exports", "olympic
// medals") score 6 and 0. Anything in that gap is the threshold; 12 sits in the
// middle with margin on both sides.
//
// Note this is a DIFFERENT scale from `fastpath.MIN_MATCH_SCORE` (4): the leaf
// weighting multiplies scores, so the two numbers are not comparable and the
// flat threshold must not be reused here. The gap is what matters — with flat
// scoring there was none, which is the whole reason for this module.
export const KB_MIN_SCORE = 12;

export interface KbHit {
  seriesId: string;
  name: string;
  source: string;
  score: number;
  // The route that found it — the explanation a similarity score cannot give.
  path: string[];
}

// Everything a node inherits from its ancestors, joined into one haystack. This
// is the mechanism: a leaf named "Mortality rate, under-5" is searchable by
// "child mortality" because its GROUP says so.
function haystack(trail: KbNode[]): string {
  const parts: string[] = [];
  for (const n of trail) {
    parts.push(n.title);
    if (n.aliases.length) parts.push(n.aliases.join(' '));
  }
  return parts.join(' ');
}

// How much a leaf's OWN wording counts relative to what it inherits.
//
// Inheritance is what makes the tree work, but it lifts every sibling in a
// group equally — so on its own it cannot choose BETWEEN them. The eval caught
// this: "women in parliament" scored all three Gender series identically
// through their shared group aliases, and the tie broke toward female labour
// force participation. Weighting the leaf's own name and aliases above the
// inherited context restores the distinction: the group gets you to the right
// shelf, the leaf's own words pick the book.
const LEAF_WEIGHT = 2;

// Score every leaf with its inherited context and return the best matches.
// Deterministic — no model, so this runs on the fast path too.
export function searchKb(query: string, sourceIds?: string[], limit = 8): KbHit[] {
  const root = buildKb(sourceIds);
  const hits: KbHit[] = [];
  const walk = (node: KbNode, trail: KbNode[]) => {
    const next = [...trail, node];
    if (node.seriesId) {
      // The scorer is the existing tested one, applied twice: once to the leaf's
      // own wording (weighted) and once to what it inherits. Empty id on the
      // context pass so an exact-id match is not counted in both halves.
      const own = scoreSeries(query, node.seriesId, `${node.title} ${node.aliases.join(' ')}`);
      const inherited = scoreSeries(query, '', haystack(trail));
      hits.push({
        seriesId: node.seriesId,
        name: node.title,
        source: node.source || '',
        score: own * LEAF_WEIGHT + inherited,
        path: next.filter((n) => n.title !== 'Knowledge base').map((n) => n.title),
      });
      return;
    }
    for (const c of node.children) walk(c, next);
  };
  for (const c of root.children) walk(c, []);
  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Model-facing tree search (the escalation) ────────────────────────────────
// When even the enriched scorer is unsure, the model walks the tree itself:
// shown one level at a time, it picks a branch, and we descend. Small contexts,
// a traceable route, and no embeddings anywhere.

export function formatChoices(node: KbNode): string {
  const kids = node.children.map((c, i) => {
    const what = c.seriesId ? `[${c.seriesId}]` : `(${c.children.length} inside)`;
    const alias = c.aliases.length ? ` — covers: ${c.aliases.slice(0, 5).join(', ')}` : '';
    return `${i + 1}. ${c.title} ${what}${alias}`;
  });
  return `Where would this live? Reply with ONE number, or 0 if none fit.\n${kids.join('\n')}`;
}

// `choose` is the model call, injected so the walk is testable without one.
// It receives the rendered choices and returns a 1-based index (0 = none fit).
export async function navigateKb(
  query: string,
  choose: (prompt: string, node: KbNode) => Promise<number>,
  sourceIds?: string[],
  maxDepth = 4
): Promise<KbHit | null> {
  let node = buildKb(sourceIds);
  const trail: string[] = [];
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!node.children.length) break;
    // A level with one option is not a decision. Descend without asking —
    // otherwise a session with a single connected database spends its first
    // model call choosing that database.
    if (node.children.length === 1) {
      node = node.children[0];
      trail.push(node.title);
      if (node.seriesId) break;
      continue;
    }
    const pick = await choose(`Question: ${query}\n\n${formatChoices(node)}`, node);
    // 0, or anything out of range, means the model declined — stop rather than
    // descend into a branch it did not choose.
    if (!Number.isInteger(pick) || pick < 1 || pick > node.children.length) return null;
    node = node.children[pick - 1];
    trail.push(node.title);
    if (node.seriesId) break;
  }
  if (!node.seriesId) return null;
  return {
    seriesId: node.seriesId,
    name: node.title,
    source: node.source || '',
    score: scoreSeries(query, node.seriesId, `${node.title} ${node.aliases.join(' ')}`),
    path: trail,
  };
}
