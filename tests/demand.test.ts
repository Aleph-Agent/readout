import { describe, expect, it } from 'vitest';

import { clusterDemand, termsOf, type IssueSignal } from '../src/lib/demand.ts';
import {
  diffDependencies,
  manifestPathFor,
  parseManifest,
} from '../src/lib/manifests.ts';
import { topByDemandSurface } from '../src/collectors/issues.ts';
import type { LiveStateRow } from '../src/types/state.ts';

function issue(repo: string, title: string, reactions = 10, comments = 5): IssueSignal {
  return { repo, title, reactions, comments, number: 1, url: `https://github.com/${repo}/issues/1` };
}

describe('term extraction', () => {
  it('keeps bigrams, which carry the meaning a single word loses', () => {
    expect(termsOf('Add streaming support for responses')).toContain('streaming support');
  });

  it('drops tracker furniture that would cluster everything into one bucket', () => {
    const terms = termsOf('Bug: feature request for the thing');
    expect(terms).not.toContain('bug');
    expect(terms).not.toContain('feature');
    expect(terms).not.toContain('request');
  });
});

describe('clusterDemand', () => {
  it('refuses a cluster confined to one repository', () => {
    // One project's backlog is not demand, and single-repository concentration
    // is the shape issue brigading takes.
    const issues = [
      issue('a/one', 'streaming support missing'),
      issue('a/one', 'streaming support broken'),
      issue('a/one', 'streaming support needed'),
    ];
    expect(clusterDemand(issues)).toEqual([]);
  });

  it('reports a term that spans repositories with real engagement', () => {
    const issues = [
      issue('a/one', 'streaming support missing'),
      issue('b/two', 'streaming support needed'),
      issue('c/three', 'streaming support please'),
    ];
    const clusters = clusterDemand(issues);
    const streaming = clusters.find((c) => c.term === 'streaming support');

    expect(streaming?.repos).toEqual(['a/one', 'b/two', 'c/three']);
    expect(streaming?.issues).toBe(3);
    expect(streaming?.engagement).toBe(45);
  });

  it('refuses a term nobody actually engaged with', () => {
    const quiet = [
      issue('a/one', 'streaming support', 0, 0),
      issue('b/two', 'streaming support', 0, 1),
      issue('c/three', 'streaming support', 1, 0),
    ];
    expect(clusterDemand(quiet)).toEqual([]);
  });

  it('keeps the specific phrase rather than repeating its parts', () => {
    const issues = [
      issue('a/one', 'streaming support missing'),
      issue('b/two', 'streaming support needed'),
      issue('c/three', 'streaming support please'),
    ];
    const terms = clusterDemand(issues).map((c) => c.term);
    expect(terms).toContain('streaming support');
    expect(terms).not.toContain('streaming');
  });

  it('publishes only the term and links, never the issue title', () => {
    // Issue titles are third-party writing. A word or two is the short
    // identifying phrase attribution allows; the title itself is not.
    const issues = [
      issue('a/one', 'streaming support missing in the new adapter'),
      issue('b/two', 'streaming support needed for long responses'),
      issue('c/three', 'streaming support please, it blocks us'),
    ];
    const cluster = clusterDemand(issues)[0];
    expect(cluster?.term.split(' ').length).toBeLessThanOrEqual(2);
    expect(cluster?.topUrl).toContain('github.com');
  });
});

describe('topByDemandSurface', () => {
  const row = (id: string, openIssues: number, active = true): LiveStateRow => ({
    id,
    active,
    forks: 1,
    stars: 1,
    openIssues,
    language: null,
    pushedAt: null,
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
