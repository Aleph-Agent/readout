import { describe, expect, it } from 'vitest';

import { findingsFrom } from '../src/site/findings.ts';
import type { IndexBundle } from '../src/types/bundles.ts';

/**
 * The page that makes a claim.
 *
 * Everywhere else here a wrong number is a wrong cell in a table. On this page
 * it is a sentence asserting something about named projects, which is a
 * different kind of wrong — so the rules are stricter: every sentence is
 * assembled from the bundle with its figures interpolated, and a finding
 * without the readings behind it does not appear at all rather than appearing
 * softened.
 */

const EMPTY: IndexBundle = {
  strip: [],
  scorecard: { resolved: 0, followed: 0, rate: null, windowDays: 7, pending: 0 },
  today: [],
  watchlist: { total: 0, active: 0, byCategory: {} },
  coverage: [],
  calibration: [],
  adoption: { measured: 0, unread: 0, weekly: 0, weeklyPackages: 0, top: [] },
  models: { available: 0, providers: 0, withdrawn: 0, cheapest: [], dearest: [], moved: [], perContext: [] },
  lifecycle: { products: 0, dated: 0, ended: 0, approaching: 0, soon: [], supported: [] },
  incidents: { windowDays: 90, providers: 0, total: 0, observedDays: 0, byProvider: [], recent: [] },
  hiring: { month: null, sample: 0, previousMonth: null, previousSample: 0, top: [], rising: [], falling: [] },
  staleness: { measured: 0, unread: 0, medianDays: null, overAYear: 0, quietest: [], byRegistry: [] },
  advisories: { registries: 0, total: 0, byRegistry: [] },
  questions: { windowDays: 0, tags: 0, total: 0, medianChange: null, busiest: [], holding: [], fading: [] },
  images: { tags: 0, images: 0, stalestDays: null, heaviest: [], stalest: [] },
  names: { swept: 0, found: 0, byPackage: [] },
  contributors: { measured: 0, singleAuthor: 0, medianBusFactor: null, concentrated: [] },
  trending: { readAt: null, projects: 0, measured: 0, singleAuthor: 0, rising: [] },
  divergence: { compared: 0, median: null, used: [], watched: [] },
  health: { scored: 0, unscored: 0, median: null, advisories: 0, weakest: [] },
  lenses: {
    ships: { status: 'active', count: 0 },
    forks: { status: 'active', count: 0 },
    demand: { status: 'active', count: 0 },
    stack: { status: 'active', count: 0 },
    lineage: { status: 'active', count: 0 },
  },
  disclosure: { watchlistCurated: true, cadenceHours: 4, minBaselineDays: 14 },
};

describe('findings', () => {
  it('claims nothing when nothing has been measured', () => {
    // A quiet instrument states nothing. Manufacturing a finding to fill the
    // page is how the one page here that makes claims stops being believable.
    expect(findingsFrom(EMPTY)).toEqual([]);
  });

  it('states the concentration finding with its worst case and its sample', () => {
    const [finding] = findingsFrom({
      ...EMPTY,
      contributors: {
        measured: 387,
        singleAuthor: 84,
        medianBusFactor: 3,
        concentrated: [
          { repo: 'a/one', busFactor: 1, topShare: 96.4, contributors: 40, commits: 5000, truncated: false },
        ],
      },
    });

    expect(finding?.headline).toBe(
      '84 of 387 widely used projects rest half their history on one person',
    );
    expect(finding?.detail).toContain('a/one');
    expect(finding?.detail).toContain('96%');
    expect(finding?.basis).toContain('387');
    // The caveat travels with the claim rather than living in a footnote.
    expect(finding?.basis).toContain('Commit count is not contribution');
  });

  it('never divides by an ecosystem with nothing measured in it', () => {
    // The advisory comparison is a ratio, and a ratio against zero is how a
    // page ends up publishing Infinity.
    const findings = findingsFrom({
      ...EMPTY,
      advisories: {
        registries: 2,
        total: 10,
        byRegistry: [
          { registry: 'npm', packages: 5, affected: 2, advisories: 10, perAffected: 5, worst: [] },
          { registry: 'crates', packages: 5, affected: 0, advisories: 0, perAffected: null, worst: [] },
        ],
      },
    });

    expect(findings).toEqual([]);
  });

  it('says nothing about question volume when the median tag rose', () => {
    // The finding is that volume is collapsing. If it is not, there is no
    // finding, and the sentence must not survive its own premise.
    const findings = findingsFrom({
      ...EMPTY,
      questions: {
        windowDays: 30,
        tags: 30,
        total: 500,
        medianChange: 4.2,
        busiest: [],
        holding: [],
        fading: [],
      },
    });

    expect(findings).toEqual([]);
  });

  it('gives every finding a sample and somewhere to check it', () => {
    const findings = findingsFrom({
      ...EMPTY,
      contributors: {
        measured: 100,
        singleAuthor: 10,
        medianBusFactor: 2,
        concentrated: [
          { repo: 'a/one', busFactor: 1, topShare: 90, contributors: 5, commits: 500, truncated: false },
        ],
      },
      staleness: {
        measured: 50,
        unread: 0,
        medianDays: 30,
        overAYear: 5,
        quietest: [
          { registry: 'npm', name: 'old', repo: 'a/one', lastPublish: '2020-01-01', days: 2000, version: '1.0.0' },
        ],
        byRegistry: [],
      },
    });

    expect(findings.length).toBeGreaterThan(1);
    for (const finding of findings) {
      expect(finding.basis, `${finding.headline} has no sample`).not.toBe('');
      expect(finding.href, `${finding.headline} links nowhere`).toMatch(/^\//);
      // A figure in the headline, or it is not a finding.
      expect(finding.headline, `${finding.headline} carries no number`).toMatch(/\d/);
    }
  });
});
