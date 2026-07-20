// countries.test.ts — the fuzzy country/region resolver.
//
// Exercises every resolution layer (ISO3, ISO2, exact name, alias, conservative
// fuzzy), the documented ambiguity choices (bare "Korea" → KOR, bare "Congo" →
// COG), the aggregate codes, and — critically — the guardrails that keep the
// fuzzy layer from producing surprising matches between similarly-named but
// distinct countries.

import { describe, it, expect } from 'vitest';
import {
  resolveCountry,
  resolveCountryList,
  formatResolutions,
  type MatchKind,
} from './countries';

// Small helper: assert code + matched layer in one line.
function expectResolve(input: string, code: string, matched?: MatchKind) {
  const r = resolveCountry(input);
  expect(r, `expected "${input}" to resolve`).not.toBeNull();
  expect(r!.code).toBe(code);
  if (matched) expect(r!.matched, `"${input}" match layer`).toBe(matched);
}

describe('resolveCountry — exact code layers', () => {
  it('resolves an exact ISO3 code to itself', () => {
    expectResolve('USA', 'USA', 'exact');
    expectResolve('DEU', 'DEU', 'exact');
    expectResolve('gbr', 'GBR', 'exact'); // case-insensitive
  });

  it('maps an ISO2 code to its ISO3 (US → USA, GB → GBR)', () => {
    expectResolve('US', 'USA', 'exact');
    expectResolve('GB', 'GBR', 'exact');
    expectResolve('de', 'DEU', 'exact'); // case-insensitive ISO2
  });
});

describe('resolveCountry — exact name layer', () => {
  it('resolves a canonical WB name, case/punctuation-insensitive', () => {
    expectResolve('Germany', 'DEU', 'exact');
    expectResolve('  france  ', 'FRA', 'exact');
    expectResolve('United States', 'USA', 'exact');
  });

  it('resolves an aggregate by its exact name (World → WLD)', () => {
    expectResolve('World', 'WLD', 'exact');
    expectResolve('European Union', 'EUU', 'exact');
    expectResolve('Euro area', 'EMU', 'exact');
  });
});

describe('resolveCountry — alias layer', () => {
  it('resolves curated country aliases', () => {
    expectResolve('America', 'USA', 'alias');
    expectResolve('the states', 'USA', 'alias');
    expectResolve('UK', 'GBR', 'alias');
    expectResolve('Britain', 'GBR', 'alias');
    expectResolve('Great Britain', 'GBR', 'alias');
    expectResolve('Holland', 'NLD', 'alias');
    expectResolve('Russia', 'RUS', 'alias');
    expectResolve('Ivory Coast', 'CIV', 'alias');
    expectResolve('Burma', 'MMR', 'alias');
    expectResolve('Czech Republic', 'CZE', 'alias');
    expectResolve('Turkey', 'TUR', 'alias');
  });

  it('documented ambiguity: bare "Korea" → KOR (South Korea), never PRK', () => {
    expectResolve('Korea', 'KOR', 'alias');
    expectResolve('South Korea', 'KOR', 'alias');
    // The North must be named explicitly.
    expectResolve('North Korea', 'PRK', 'alias');
    expectResolve('DPRK', 'PRK', 'alias');
    expect(resolveCountry('Korea')!.code).not.toBe('PRK');
  });

  it('documented ambiguity: bare "Congo" → COG (Rep.), DRC named explicitly', () => {
    expectResolve('Congo', 'COG', 'alias');
    expectResolve('DR Congo', 'COD', 'alias');
    expectResolve('DRC', 'COD', 'alias');
    expect(resolveCountry('Congo')!.code).not.toBe('COD');
  });
});

describe('resolveCountry — aggregate / region aliases', () => {
  it('resolves region shorthands to WB aggregate codes', () => {
    expectResolve('EU', 'EUU'); // via ISO2 or alias — either is fine
    expectResolve('world', 'WLD');
    expectResolve('global', 'WLD', 'alias');
    expectResolve('euro area', 'EMU');
    expectResolve('Sub-Saharan Africa', 'SSF');
    expectResolve('Latin America', 'LCN', 'alias');
    expectResolve('Middle East', 'MEA', 'alias');
    expectResolve('South Asia', 'SAS');
    expectResolve('East Asia', 'EAS', 'alias');
  });
});

describe('resolveCountry — conservative fuzzy layer', () => {
  it('resolves a unique token/prefix match not covered by earlier layers', () => {
    // "Iran" is not the exact WB name ("Iran, Islamic Rep.") and has no alias,
    // so it must come through the fuzzy layer via a unique token match.
    expectResolve('Iran', 'IRN', 'fuzzy');
    expectResolve('Venezuela', 'VEN', 'fuzzy');
    expectResolve('Egypt', 'EGY', 'fuzzy');
  });
});

describe('resolveCountry — no surprising matches', () => {
  it('"Iran" and "Ireland" stay distinct', () => {
    expect(resolveCountry('Iran')!.code).toBe('IRN');
    expect(resolveCountry('Ireland')!.code).toBe('IRL');
  });

  it('"Niger" and "Nigeria" each resolve to themselves', () => {
    expect(resolveCountry('Niger')!.code).toBe('NER');
    expect(resolveCountry('Nigeria')!.code).toBe('NGA');
  });

  it('the four Guineas stay distinct', () => {
    expect(resolveCountry('Guinea')!.code).toBe('GIN');
    expect(resolveCountry('Guinea-Bissau')!.code).toBe('GNB');
    expect(resolveCountry('Equatorial Guinea')!.code).toBe('GNQ');
    expect(resolveCountry('Papua New Guinea')!.code).toBe('PNG');
    const codes = ['Guinea', 'Guinea-Bissau', 'Equatorial Guinea', 'Papua New Guinea'].map(
      (g) => resolveCountry(g)!.code
    );
    expect(new Set(codes).size).toBe(4); // all different
  });
});

describe('resolveCountry — null on unresolvable input', () => {
  it('returns null for garbage', () => {
    expect(resolveCountry('xyzzy')).toBeNull();
    expect(resolveCountry('not a country at all')).toBeNull();
  });

  it('returns null for empty / whitespace / nullish input', () => {
    expect(resolveCountry('')).toBeNull();
    expect(resolveCountry('   ')).toBeNull();
    // @ts-expect-error — defensive against a stray null/undefined at runtime.
    expect(resolveCountry(null)).toBeNull();
    // @ts-expect-error
    expect(resolveCountry(undefined)).toBeNull();
  });

  it('refuses too-short fragments in the fuzzy layer', () => {
    // "ira" (3 chars) must not latch onto "Iran"/"Iraq" — below the length floor.
    expect(resolveCountry('ira')).toBeNull();
  });
});

describe('resolveCountryList — batch resolution + change tracking', () => {
  it('rewrites loose inputs, passes canonical codes and unresolved names through', () => {
    const { codes, changes } = resolveCountryList(['UK', 'USA', 'Holland', 'Freedonia']);
    // Canonical order preserved; UK→GBR, USA stays, Holland→NLD, unknown passes through.
    expect(codes).toEqual(['GBR', 'USA', 'NLD', 'Freedonia']);
    // Only the two rewrites are reported as changes (USA was already canonical).
    expect(changes.map((c) => c.from)).toEqual(['UK', 'Holland']);
    expect(changes.find((c) => c.from === 'UK')?.code).toBe('GBR');
    expect(changes.find((c) => c.from === 'UK')?.name).toBe('United Kingdom');
  });

  it('reports no changes when every input is already canonical', () => {
    const { codes, changes } = resolveCountryList(['USA', 'IND', 'CHN']);
    expect(codes).toEqual(['USA', 'IND', 'CHN']);
    expect(changes).toEqual([]);
  });
});

describe('formatResolutions', () => {
  it('renders a compact receipt note', () => {
    const { changes } = resolveCountryList(['UK', 'Korea']);
    expect(formatResolutions(changes)).toBe(
      'UK → GBR (United Kingdom), Korea → KOR (Korea, Rep.)'
    );
  });

  it('is empty when nothing changed', () => {
    expect(formatResolutions([])).toBe('');
  });
});
