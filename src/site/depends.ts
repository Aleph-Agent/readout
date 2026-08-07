import { band, esc, layout } from './render.ts';
import type { IndexBundle } from '../types/bundles.ts';
import type { ManifestRow } from '../types/manifests.ts';
import type { MetaRecord } from '../types/meta.ts';

/**
 * Who depends on what, read backwards.
 *
 * Registries answer "what does this package need". Almost nothing answers the
 * question that decides whether a package matters: who needs *it*. npm shows a
 * dependents count with no list behind it, and the count is dominated by
 * abandoned scaffolding.
 *
 * This is a small, honest version of the missing answer. Not the registry's
 * count — the actual list, across a few hundred prominent projects whose
 * manifests are read here every day. "Four hundred projects" is a survey of
 * nothing, but "eleven of the four hundred most prominent projects in this
 * corpus import this" is a statement somebody can act on, provided the corpus
 * is named every time the number is.
 */

/** Packages listed. Beyond this the page is a dictionary nobody reads. */
export const LIMIT = 60;

/** Dependents needed before a package is worth a row. One is not a finding. */
export const MIN_DEPENDENTS = 2;

export interface DependencyReading {
  name: string;
  dependents: string[];
}

/**
 * Fold a package name the way the rest of the project does.
 *
 * `PyYAML` and `pyyaml` are one package. Counting them separately has already
 * happened here once, and it produced two JSON keys differing only by case.
 */
export function foldName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, '-');
}

export function reverseIndex(manifests: readonly ManifestRow[]): DependencyReading[] {
  const dependents = new Map<string, Set<string>>();

  for (const row of manifests) {
    for (const raw of Object.keys(row.deps)) {
      const name = foldName(raw);
      if (name === '') continue;
      const held = dependents.get(name);
      if (held) held.add(row.id);
      else dependents.set(name, new Set([row.id]));
    }
  }

  return [...dependents.entries()]
    .filter(([, repos]) => repos.size >= MIN_DEPENDENTS)
    .map(([name, repos]) => ({ name, dependents: [...repos].sort() }))
    .sort((a, b) => b.dependents.length - a.dependents.length || a.name.localeCompare(b.name));
}

export function renderDepends(
  readings: readonly DependencyReading[],
  index: IndexBundle,
  meta: MetaRecord,
): string {
  const shown = readings.slice(0, LIMIT);

  const table =
    shown.length === 0
      ? `<p class="notice">No package is imported by more than one watched project yet. Manifests
      are read once a day; this fills in as they are.</p>`
      : `<div class="wrap"><table class="readout">
  <caption class="label">Most depended upon, within this corpus</caption>
  <thead><tr>
    <th scope="col">Package</th>
    <th scope="col" class="n">Projects here that import it</th>
    <th scope="col">Which</th>
  </tr></thead>
  <tbody>${shown
    .map(
      (row) => `<tr>
      <td class="num">${esc(row.name)}</td>
      <td class="n"><span class="big num">${row.dependents.length}</span></td>
      <td class="dim">${row.dependents
        .slice(0, 6)
        .map((repo) => `<a href="/repo/${esc(repo)}">${esc(repo)}</a>`)
        .join(', ')}${row.dependents.length > 6 ? ` and ${row.dependents.length - 6} more` : ''}</td>
    </tr>`,
    )
    .join('')}</tbody>
</table></div>`;

  return layout({
    title: 'Depended upon — who imports what',
    description:
      'Which packages the most prominent open-source projects actually import, read backwards from their manifests rather than from a registry counter.',
    current: '/depends',
    path: '/depends',
    index,
    meta,
    body: `<section class="hero">
  <h1 class="hero-thesis">Read the dependency graph backwards.</h1>
  <p class="hero-sub">
    Registries answer what a package needs. Almost nothing answers who needs it — npm publishes a
    dependents count with no list behind it, and the count is dominated by abandoned scaffolding.
    These are the manifests of ${index.watchlist.active} prominent projects, read every day and
    turned around.
  </p>
  <div class="hero-figures">
    <div class="figure"><span class="figure-value num">${readings.length}</span><span class="label">Packages imported more than once</span></div>
    <div class="figure"><span class="figure-value num">${index.watchlist.active}</span><span class="label">Manifests read</span></div>
  </div>
</section>

${band(
  'Most depended upon',
  table,
  `Counted across the manifests of ${index.watchlist.active} repositories chosen by hand for this watchlist. It is not a survey of any registry and the number is not npm’s dependents count — it is how many of these particular projects import the package, which is a smaller and more specific claim. Packages imported by only one project are left out; one is not a finding.`,
)}`,
  });
}
