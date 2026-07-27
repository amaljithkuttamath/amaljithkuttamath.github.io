// catalog.ts — "what is actually in the database I connected?"
//
// Chitti could always SEARCH a connected database, but never let you BROWSE it.
// That is a real gap for understanding rather than looking something up: search
// only rewards you for already knowing the words. Someone who has just
// connected World Bank has no way to ask what is in there, which topics exist,
// or what the coverage looks like — so they ask the one question they arrived
// with and leave. These verbs answer "what can I explore here?".
//
// Pure and local: the topic taxonomy, the indicator shortlists and the country
// classification are all bundled with the app, so browsing costs no request and
// works offline.
//
// HONESTY: World Bank publishes thousands of indicators; `indicators.json` is a
// hand-picked shortlist of the ~50 most useful. Browsing therefore shows a
// curated view, and every rendering below says so and points at find_series for
// the full live catalog. Presenting 50 as "the dataset" would misrepresent it.
import { COUNTRIES, INDICATORS } from './tools';
import { resolveSources } from './sources/index';

export interface TopicSummary {
  topic: string;
  count: number;
  examples: { id: string; name: string }[];
}

export interface SourceSummary {
  id: string;
  label: string;
  blurb: string;
  // Curated entries we can show. For World Bank this is the topic-keyed
  // shortlist; for the catalog sources it is their curated list.
  shortlistCount: number;
  // True when the source's live catalog is far larger than the shortlist, so a
  // reader knows browsing is not the whole story.
  hasLargerLiveCatalog: boolean;
  topics: TopicSummary[];
}

export interface CatalogSummary {
  sources: SourceSummary[];
  countryCount: number;
  regions: string[];
  incomeGroups: string[];
}

const realCountries = () => COUNTRIES.filter((c) => c.region && c.region !== 'Aggregates');

function worldbankTopics(): TopicSummary[] {
  const byTopic = new Map<string, { id: string; name: string }[]>();
  for (const i of INDICATORS) {
    const list = byTopic.get(i.topic) || [];
    list.push({ id: i.id, name: i.name });
    byTopic.set(i.topic, list);
  }
  return [...byTopic.entries()]
    .map(([topic, list]) => ({ topic, count: list.length, examples: list.slice(0, 3) }))
    .sort((a, b) => b.count - a.count);
}

// Describe every connected database. `sourceIds` is the session's active
// selection, so a hard-filtered session never gets told about a database it
// cannot use — the same discipline the system prompt follows.
export function describeCatalog(sourceIds?: string[]): CatalogSummary {
  const sources = resolveSources(sourceIds).map((s): SourceSummary => {
    if (s.id === 'worldbank') {
      const topics = worldbankTopics();
      return {
        id: s.id,
        label: s.label,
        blurb: s.blurb,
        shortlistCount: INDICATORS.length,
        hasLargerLiveCatalog: true,
        topics,
      };
    }
    return {
      id: s.id,
      label: s.label,
      blurb: s.blurb,
      shortlistCount: s.curated.length,
      // The catalog sources also expose a live catalog search beyond their
      // curated list.
      hasLargerLiveCatalog: !!s.liveCatalogSearch,
      topics: s.curated.length
        ? [{ topic: s.label, count: s.curated.length, examples: s.curated.slice(0, 3) }]
        : [],
    };
  });
  const rc = realCountries();
  return {
    sources,
    countryCount: rc.length,
    regions: [...new Set(rc.map((c) => c.region))].sort(),
    incomeGroups: [...new Set(rc.map((c) => c.income))].filter(Boolean).sort(),
  };
}

// The indicators under one topic (World Bank) or one database's curated list.
// Matched case-insensitively on a substring, so "health" finds "Health" and
// "climate" finds "Environment & Climate".
export function browseTopic(
  topic: string,
  sourceIds?: string[]
): { id: string; name: string; source: string }[] {
  const q = String(topic ?? '').trim().toLowerCase();
  if (!q) return [];
  const active = resolveSources(sourceIds);
  const out: { id: string; name: string; source: string }[] = [];
  if (active.some((s) => s.id === 'worldbank')) {
    for (const i of INDICATORS) {
      if (i.topic.toLowerCase().includes(q)) out.push({ id: i.id, name: i.name, source: 'worldbank' });
    }
  }
  for (const s of active) {
    if (s.id === 'worldbank') continue;
    // A catalog source's whole curated list is one "topic" named for the source,
    // so match on the label or on entry names.
    const labelHit = s.label.toLowerCase().includes(q);
    for (const c of s.curated) {
      if (labelHit || c.name.toLowerCase().includes(q)) out.push({ id: c.id, name: c.name, source: s.id });
    }
  }
  return out.slice(0, 40);
}

// ── Model-facing rendering ───────────────────────────────────────────────────

export function formatCatalog(cat: CatalogSummary): string {
  const lines: string[] = [];
  const names = cat.sources.map((s) => s.label).join(', ');
  lines.push(`CONNECTED DATABASE${cat.sources.length === 1 ? '' : 'S'}: ${names}.`);
  lines.push(
    `Country coverage: ${cat.countryCount} countries, classified into ${cat.regions.length} World Bank ` +
      `regions and ${cat.incomeGroups.length} income groups — so any fetched series can be grouped with ` +
      `breakdown(by:"region"|"income") at no extra fetch.`
  );
  for (const s of cat.sources) {
    lines.push(`\n${s.label} — ${s.blurb}`);
    if (s.topics.length) {
      for (const t of s.topics) {
        lines.push(
          `  • ${t.topic} (${t.count}): ` + t.examples.map((e) => `${e.name} [${e.id}]`).join('; ')
        );
      }
    }
    if (s.hasLargerLiveCatalog) {
      lines.push(
        `  (These ${s.shortlistCount} are a curated shortlist, NOT the whole database — ` +
          `${s.label} publishes far more. Use find_series for anything not listed.)`
      );
    }
  }
  lines.push(
    '\nTell the user what is available in their own words and suggest 2-3 specific questions they ' +
      'could ask of it. Do not claim this list is the complete catalog.'
  );
  return lines.join('\n');
}

export function formatTopic(topic: string, hits: { id: string; name: string; source: string }[]): string {
  if (!hits.length) {
    return (
      `No shortlisted indicators matched "${topic}". The shortlist is small — use find_series, ` +
      `which searches the databases' full live catalogs.`
    );
  }
  return (
    `Shortlisted indicators under "${topic}" (${hits.length}):\n` +
    hits.map((h) => `- ${h.name} [${h.id}] (${h.source})`).join('\n') +
    `\n(Curated shortlist only — find_series reaches the full catalog.)`
  );
}
