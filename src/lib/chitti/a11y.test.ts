import { describe, it, expect } from 'vitest';
import {
  chartAriaLabel,
  verificationCueText,
  verificationStampLabel,
  verifierConfidenceLabel,
  focusTrapTarget,
  FOCUSABLE_SELECTOR,
} from './a11y';

describe('chartAriaLabel', () => {
  it('names the chart type and title', () => {
    const label = chartAriaLabel({
      type: 'line',
      title: 'Child mortality since 2000',
      y_axis: 'deaths per 1,000 live births',
      series: [{ name: 'India', data: [] }],
    });
    expect(label).toBe(
      'Line chart: Child mortality since 2000. deaths per 1,000 live births. 1 series: India.'
    );
  });

  it('enumerates multiple series', () => {
    const label = chartAriaLabel({
      type: 'grouped-bar',
      title: 'GDP per capita',
      y_axis: 'current US$',
      series: [
        { name: 'India', data: [] },
        { name: 'China', data: [] },
        { name: 'Brazil', data: [] },
      ],
    });
    expect(label).toBe('Grouped bar chart: GDP per capita. current US$. 3 series: India, China, Brazil.');
  });

  it('caps the series enumeration at six names', () => {
    const series = Array.from({ length: 9 }, (_, i) => ({ name: 'C' + i, data: [] }));
    const label = chartAriaLabel({ type: 'line', title: 'Many', y_axis: '', series });
    expect(label).toBe('Line chart: Many. 9 series: C0, C1, C2, C3, C4, C5, and 3 more.');
  });

  it('omits the unit when there is none', () => {
    const label = chartAriaLabel({ type: 'bar', title: 'Counts', y_axis: '', series: [{ name: 'X', data: [] }] });
    expect(label).toBe('Bar chart: Counts. 1 series: X.');
  });

  it('falls back to a generic name when the title is empty', () => {
    const label = chartAriaLabel({ type: 'scatter', title: '', y_axis: '', series: [] });
    expect(label).toBe('Scatter plot.');
  });

  it('handles a single unnamed series', () => {
    const label = chartAriaLabel({ type: 'line', title: 'T', y_axis: '', series: [{ name: '', data: [] }] });
    expect(label).toBe('Line chart: T. 1 series.');
  });
});

describe('verificationCueText', () => {
  it('returns null for a verified verdict (nothing to announce)', () => {
    expect(verificationCueText({ status: 'verified', issues: [] })).toBeNull();
  });

  it('returns null when there is no verdict', () => {
    expect(verificationCueText(null)).toBeNull();
    expect(verificationCueText(undefined)).toBeNull();
  });

  it('names the first doubt on could-not-verify', () => {
    expect(verificationCueText({ status: 'unverified', issues: ['the 2019 figure is unsourced', 'x'] })).toBe(
      'could not verify — the 2019 figure is unsourced'
    );
  });

  it('has a generic could-not-verify fallback with no issues', () => {
    expect(verificationCueText({ status: 'unverified', issues: [] })).toBe(
      'could not verify — the finding could not be confirmed'
    );
  });

  it('reports a provider error on unavailable', () => {
    expect(verificationCueText({ status: 'unavailable', issues: [] })).toBe(
      'verification unavailable — provider error'
    );
  });

  it('returns null on a skipped (empty-run) verdict — nothing to announce', () => {
    expect(verificationCueText({ status: 'skipped', issues: [] })).toBeNull();
  });
});

describe('verifierConfidenceLabel', () => {
  it('labels the confidence as the VERIFIER\'s, never bare "confidence"', () => {
    // The relabel: 'confidence: X' became 'verifier confidence: X' so it is
    // never read as answer confidence.
    expect(verifierConfidenceLabel('high')).toBe('verifier confidence: high');
    expect(verifierConfidenceLabel('medium')).toBe('verifier confidence: medium');
    expect(verifierConfidenceLabel('low')).toBe('verifier confidence: low');
  });

  it('reads "unknown" (not "none") when confidence is none or absent', () => {
    expect(verifierConfidenceLabel('none')).toBe('verifier confidence: unknown');
    expect(verifierConfidenceLabel(undefined)).toBe('verifier confidence: unknown');
  });
});

describe('verificationStampLabel', () => {
  it('spells out what the amber stamp means', () => {
    expect(verificationStampLabel()).toMatch(/verified/i);
  });
});

describe('focusTrapTarget', () => {
  it('returns null with no focusables', () => {
    expect(focusTrapTarget(0, 0, false)).toBeNull();
    expect(focusTrapTarget(-1, 0, true)).toBeNull();
  });

  it('wraps forward off the last element to the first', () => {
    expect(focusTrapTarget(4, 5, false)).toBe(0);
  });

  it('does not intervene mid-list going forward', () => {
    expect(focusTrapTarget(2, 5, false)).toBeNull();
  });

  it('wraps backward off the first element to the last', () => {
    expect(focusTrapTarget(0, 5, true)).toBe(4);
  });

  it('does not intervene mid-list going backward', () => {
    expect(focusTrapTarget(2, 5, true)).toBeNull();
  });

  it('pulls focus into the trap from outside (index -1)', () => {
    expect(focusTrapTarget(-1, 5, false)).toBe(0);
    expect(focusTrapTarget(-1, 5, true)).toBe(4);
  });
});

describe('FOCUSABLE_SELECTOR', () => {
  it('includes the common interactive elements and excludes tabindex -1', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('textarea:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
});
