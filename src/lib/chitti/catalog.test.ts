import { describe, it, expect } from 'vitest';
import { describeCatalog, browseTopic, formatCatalog, formatTopic } from './catalog';
import { INDICATORS } from './tools';

describe('describeCatalog', () => {
  it('describes only the databases the session connected', () => {
    const cat = describeCatalog(['worldbank']);
    expect(cat.sources.map((s) => s.id)).toEqual(['worldbank']);
    // The hard filter matters here as much as anywhere else: a session that
    // switched a database off must not be told it exists.
    expect(formatCatalog(cat)).not.toMatch(/Our World in Data/);
  });

  it('groups the World Bank shortlist by its own topics', () => {
    const wb = describeCatalog(['worldbank']).sources[0];
    expect(wb.shortlistCount).toBe(INDICATORS.length);
    expect(wb.topics.length).toBeGreaterThan(5);
    // Ordered by size, and each topic carries real example ids.
    expect(wb.topics[0].count).toBeGreaterThanOrEqual(wb.topics[wb.topics.length - 1].count);
    expect(wb.topics[0].examples[0].id).toBeTruthy();
  });

  it('reports the country classification the breakdown verb depends on', () => {
    const cat = describeCatalog(['worldbank']);
    expect(cat.countryCount).toBeGreaterThan(200);
    expect(cat.regions.length).toBeGreaterThanOrEqual(7);
    expect(cat.incomeGroups).toContain('High income');
    expect(cat.incomeGroups).toContain('Low income');
    expect(cat.incomeGroups).not.toContain('Aggregates');
  });

  it('covers every connected database when several are on', () => {
    const cat = describeCatalog(['worldbank', 'owid', 'who']);
    expect(cat.sources.map((s) => s.id).sort()).toEqual(['owid', 'who', 'worldbank']);
  });
});

describe('browseTopic', () => {
  it('matches a topic case-insensitively on a substring', () => {
    const hits = browseTopic('health', ['worldbank']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source === 'worldbank')).toBe(true);
    expect(browseTopic('climate', ['worldbank']).length).toBeGreaterThan(0);
  });

  it('respects the connected-database filter', () => {
    const hits = browseTopic('life expectancy', ['owid']);
    expect(hits.every((h) => h.source === 'owid')).toBe(true);
  });

  it('returns nothing for an empty or unmatched topic', () => {
    expect(browseTopic('', ['worldbank'])).toEqual([]);
    expect(browseTopic('quidditch', ['worldbank'])).toEqual([]);
  });
});

describe('what the model is told', () => {
  it('never presents the shortlist as the whole database', () => {
    // The shortlist is ~50 of thousands of World Bank indicators. Saying
    // otherwise would misrepresent the source in the one place a user is
    // deciding what is possible.
    const text = formatCatalog(describeCatalog(['worldbank']));
    expect(text).toMatch(/curated shortlist, NOT the whole database/);
    expect(text).toMatch(/find_series/);
    expect(text).toMatch(/Do not claim this list is the complete catalog/);
  });

  it('points a missed topic at the full-catalog search instead of dead-ending', () => {
    expect(formatTopic('quidditch', [])).toMatch(/find_series/);
  });

  it('advertises the grouping the country metadata makes possible', () => {
    expect(formatCatalog(describeCatalog(['worldbank']))).toMatch(/breakdown\(by:"region"\|"income"\)/);
  });
});
