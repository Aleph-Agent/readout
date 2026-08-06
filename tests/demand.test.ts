import { describe, expect, it } from 'vitest';

import {
  clusterDemand,
  demandEngagements,
  termsOf,
  type IssueSignal,
} from '../src/lib/demand.ts';
import {
  diffDependencies,
  manifestPathFor,
  parseManifest,
} from '../src/lib/manifests.ts';
import { topByDemandSurface } from '../src/collectors/issues.ts';
import type { LiveStateRow } from '../src/types/state.ts';

function issue(repo: string, title: string, reactions = 20, comments = 10): IssueSignal {
  return { repo, title, reactions, comments, number: 1, url: `https://github.com/${repo}/issues/1` };
}

/** A background of unrelated chatter, so spread can be measured against it. */
function background(repos: number): IssueSignal[] {
  return Array.from({ length: repos }, (_, i) =>
    issue(`bg${i}/repo`, `something unrelated happening here ${i}`, 1, 1),
  );
}

describe('term extraction', () => {
  it('produces word pairs, never single words', () => {
    // A single word is vocabulary. "support" is not a request; "streaming
    // support" is. Single words also accumulate engagement from every context
    // they appear in, so they outrank every specific phrase.
    const terms = termsOf('Add streaming support for responses');
    expect(terms).toContain('streaming support');
    expect(terms.every((t) => t.split(' ').length === 2)).toBe(true);
  });

  it('drops tracker furniture before pairing', () => {
    expect(termsOf('Bug: feature request for the thing')).toEqual([]);
  });
});

describe('what the engagement bar is judging', () => {
  it('reports candidates the bar rejected, not only the ones it passed', () => {
    // The bar is 60. Without the rejected candidates there is no way to tell a
    // week where nothing was asked for from a week where the bar is above
    // anything developers ever produce — both publish nothing.
    const issues: IssueSignal[] = [
      ...background(40),
      issue('a/one', 'streaming support broken', 2, 1),
      issue('b/two', 'streaming support missing', 1, 1),
      issue('c/three', 'streaming support please', 0, 2),
    ];

    expect(clusterDemand(issues).map((c) => c.term)).not.toContain('streaming support');
    expect(demandEngagements(issues)).toContain(7);
  });

  it('measures the same population the bar is applied to', () => {
    // A candidate rejected for being everywhere, or for being one repository's
    // backlog, was never a demand signal — counting it would make the bar look
    // further away than it is.
    const backlog: IssueSignal[] = [
      ...background(40),
      ...Array.from({ length: 5 }, () => issue('a/one', 'streaming support wanted', 50, 50)),
    ];

    // Five hundred engagement, all in one repository. That is a backlog, and
    // it never reaches the engagement bar's gate.
    expect(demandEngagements(backlog)).not.toContain(500);
  });
});

describe('clusterDemand', () => {
  it('refuses a cluster confined to one repository', () => {
    // One project's backlog is not demand, and single-repository concentration
    // is the shape issue brigading takes.
    const issues = [
      ...background(40),
      issue('a/one', 'streaming support missing'),
      issue('a/one', 'streaming support broken'),
      issue('a/one', 'streaming support needed'),
    ];
    expect(clusterDemand(issues).map((c) => c.term)).not.toContain('streaming support');
  });

  it('reports a phrase that spans a few repositories with real engagement', () => {
    const issues = [
      ...background(40),
      issue('a/one', 'streaming support missing'),
      issue('b/two', 'streaming support needed'),
      issue('c/three', 'streaming support please'),
    ];
    const streaming = clusterDemand(issues).find((c) => c.term === 'streaming support');

    expect(streaming?.repos).toEqual(['a/one', 'b/two', 'c/three']);
    expect(streaming?.issues).toBe(3);
    expect(streaming?.engagement).toBe(90);
  });

  it('rejects a phrase that turns up nearly everywhere', () => {
    // The failure the first live run actually produced: "support" appeared in
    // 29 of 80 repositories, carried the highest engagement of anything
    // measured, and was ranked first. Being everywhere is evidence a phrase is
    // common English, not evidence anyone is asking for it.
    const everywhere = Array.from({ length: 25 }, (_, i) =>
      issue(`w${i}/repo`, 'please add support', 20, 20),
    );
    const clusters = clusterDemand([...background(40), ...everywhere]);
    expect(clusters.map((c) => c.term)).not.toContain('add support');
  });

  it('never reports a single word', () => {
    const issues = [
      ...background(40),
      issue('a/one', 'streaming support missing'),
      issue('b/two', 'streaming support needed'),
      issue('c/three', 'streaming support please'),
    ];
    expect(clusterDemand(issues).every((c) => c.term.split(' ').length === 2)).toBe(true);
  });

  it('refuses a phrase nobody actually engaged with', () => {
    const quiet = [
      ...background(40),
      issue('a/one', 'streaming support here', 0, 0),
      issue('b/two', 'streaming support there', 0, 1),
      issue('c/three', 'streaming support now', 1, 0),
    ];
    expect(clusterDemand(quiet).map((c) => c.term)).not.toContain('streaming support');
  });

  it('publishes only the phrase and links, never the issue title', () => {
    // Issue titles are third-party writing. Two words is the short identifying
    // phrase attribution allows; the title itself is not.
    const issues = [
      ...background(40),
      issue('a/one', 'streaming support missing in the new adapter'),
      issue('b/two', 'streaming support needed for long responses'),
      issue('c/three', 'streaming support please it blocks us'),
    ];
    const cluster = clusterDemand(issues).find((c) => c.term === 'streaming support');
    expect(cluster?.term.split(' ')).toHaveLength(2);
    expect(cluster?.topUrl).toContain('github.com');
  });
});

describe('topByDemandSurface', () => {
  const row = (id: string, openIssues: number, active = true): LiveStateRow => ({
    id,
    fullName: id,
    active,
    forks: 1,
    stars: 1,
    openIssues,
    language: null,
    pushedAt: null,
    license: null,
    archived: false,
    latestReleaseTag: null,
    latestReleaseAt: null,
    etag: null,
    releaseEtag: null,
  });

  it('ranks by open-issue surface, not popularity', () => {
    const picked = topByDemandSurface([row('a/one', 5), row('b/two', 50)], 2);
    expect(picked.map((r) => r.id)).toEqual(['b/two', 'a/one']);
  });

  it('skips repositories that are no longer reachable', () => {
    const picked = topByDemandSurface([row('a/one', 5), row('b/two', 90, false)], 2);
    expect(picked.map((r) => r.id)).toEqual(['a/one']);
  });

  it('honours the budget cap', () => {
    const many = Array.from({ length: 200 }, (_, i) => row(`r${i}/x`, i));
    expect(topByDemandSurface(many, 80)).toHaveLength(80);
  });
});

describe('manifest selection', () => {
  it('picks one file from the language GitHub already reported', () => {
    // Probing five candidate names per repository would cost 2,000 requests.
    expect(manifestPathFor('TypeScript')).toBe('package.json');
    expect(manifestPathFor('Rust')).toBe('Cargo.toml');
    expect(manifestPathFor('Go')).toBe('go.mod');
    expect(manifestPathFor('Python')).toBe('pyproject.toml');
  });

  it('returns null rather than guessing for a language it cannot parse', () => {
    expect(manifestPathFor('COBOL')).toBeNull();
    expect(manifestPathFor(null)).toBeNull();
  });
});

describe('manifest parsing', () => {
  it('reads runtime dependencies from package.json, not devDependencies', () => {
    // Dev tooling churns with fashion; what a project ships with is the claim.
    const deps = parseManifest(
      'package.json',
      JSON.stringify({ dependencies: { react: '^19.0.0' }, devDependencies: { vitest: '^4' } }),
    );
    expect(deps).toEqual({ react: '^19.0.0' });
  });

  it('survives a malformed manifest without throwing', () => {
    expect(parseManifest('package.json', '{ not json')).toEqual({});
  });

  it('reads Cargo dependencies in both bare and table form', () => {
    const deps = parseManifest(
      'Cargo.toml',
      '[package]\nname = "x"\n\n[dependencies]\nserde = "1.0"\ntokio = { version = "1.40", features = ["full"] }\n\n[dev-dependencies]\ncriterion = "0.5"\n',
    );
    expect(deps).toEqual({ serde: '1.0', tokio: '1.40' });
    expect(deps['criterion']).toBeUndefined();
  });

  it('reads a go.mod require block', () => {
    const deps = parseManifest(
      'go.mod',
      'module x\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgolang.org/x/sync v0.8.0\n)\n',
    );
    expect(deps['github.com/gin-gonic/gin']).toBe('v1.10.0');
  });

  it('reads PEP 621 dependencies', () => {
    const deps = parseManifest(
      'pyproject.toml',
      '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27",\n  "pydantic",\n]\n',
    );
    expect(deps['httpx']).toBe('>=0.27');
    expect(deps['pydantic']).toBe('*');
  });
});

describe('diffDependencies', () => {
  it('reports additions and removals', () => {
    const diff = diffDependencies({ a: '1.0', b: '2.0' }, { a: '1.0', c: '3.0' });
    expect(diff.added).toEqual(['c']);
    expect(diff.removed).toEqual(['b']);
  });

  it('counts a major move but ignores patch churn', () => {
    // A patch bump is maintenance. A major bump is a migration decision.
    const diff = diffDependencies({ react: '^18.2.0', vite: '^5.0.1' }, { react: '^19.0.0', vite: '^5.0.4' });
    expect(diff.bumped.map((b) => b.name)).toEqual(['react']);
  });

  it('reports nothing when nothing moved', () => {
    const diff = diffDependencies({ a: '^1.0' }, { a: '^1.0' });
    expect(diff).toEqual({ added: [], removed: [], bumped: [] });
  });
});
