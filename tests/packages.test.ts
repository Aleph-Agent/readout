import { describe, expect, it } from 'vitest';

import { packageCandidates, pointsBack } from '../src/lib/packages.ts';

/**
 * The join between a repository and a package.
 *
 * A wrong mapping credits one project's downloads to another, on a public page,
 * with a number that looks entirely plausible. Every case here comes from real
 * data that the first version of this logic got wrong.
 */

describe('does the registry point back at this repository', () => {
  it('accepts the shapes registries actually publish', () => {
    for (const url of [
      'https://github.com/vitejs/vite',
      'git+https://github.com/vitejs/vite.git',
      'https://github.com/vitejs/vite/issues',
      'git://github.com/vitejs/vite#main',
    ]) {
      expect(pointsBack(url, 'vitejs/vite')).toBe(true);
    }
  });

  it('refuses a repository whose name merely prefixes another', () => {
    // The npm package `angular` declares github.com/angular/angular.js — a
    // different, archived project. A substring test matched it and would have
    // credited 692k weekly downloads of dead AngularJS to modern Angular, whose
    // real package is @angular/core at 5.9M.
    expect(pointsBack('git+https://github.com/angular/angular.js.git', 'angular/angular')).toBe(
      false,
    );
    expect(pointsBack('https://github.com/facebook/react-native', 'facebook/react')).toBe(false);
  });

  it('refuses a different owner with the same repository name', () => {
    expect(pointsBack('https://github.com/someone-else/vite', 'vitejs/vite')).toBe(false);
  });

  it('treats a dot in the name as a character, not as any character', () => {
    expect(pointsBack('https://github.com/ggml-org/llama.cpp', 'ggml-org/llama.cpp')).toBe(true);
    expect(pointsBack('https://github.com/ggml-org/llamaxcpp', 'ggml-org/llama.cpp')).toBe(false);
  });

  it('says no when the registry declares nothing', () => {
    expect(pointsBack(null, 'a/one')).toBe(false);
    expect(pointsBack(undefined, 'a/one')).toBe(false);
    expect(pointsBack('', 'a/one')).toBe(false);
  });
});

describe('candidate names', () => {
  it('proposes the foundation-prefixed name', () => {
    // apache/airflow publishes apache-airflow. Without this the whole Apache
    // set goes unmapped.
    expect(packageCandidates('apache/airflow')).toContain('apache-airflow');
  });

  it('proposes both hyphen and underscore, because PyPI folds them', () => {
    const candidates = packageCandidates('owner/some_package');
    expect(candidates).toContain('some_package');
    expect(candidates).toContain('some-package');
  });

  it('proposes the scoped form', () => {
    expect(packageCandidates('a16z/helios')).toContain('@a16z/helios');
  });

  it('never proposes a one-character name', () => {
    expect(packageCandidates('owner/x').every((name) => name.length > 1)).toBe(true);
  });
});
