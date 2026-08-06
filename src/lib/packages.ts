/**
 * Deciding whether a package belongs to a repository.
 *
 * This is the join between what a project builds and what anyone installs, and
 * getting it wrong is the worst error available to this project: a download
 * count attributed to the wrong people, on a public page, with a figure that
 * looks entirely plausible and that nobody would think to check.
 *
 * So it lives here rather than inside the script that uses it, and it is
 * tested. Both of the rules below exist because the first version got them
 * wrong against real data.
 */

/**
 * Candidate package names for a repository.
 *
 * Generous on purpose. Every candidate is verified against the registry's own
 * record afterwards, so a wrong guess costs one request and produces nothing —
 * while a missing candidate silently loses a real mapping.
 */
export function packageCandidates(id: string): string[] {
  const owner = (id.split('/')[0] ?? '').toLowerCase();
  const name = (id.split('/')[1] ?? '').toLowerCase();

  const stripped = name
    .replace(/^(node|py|js|go|rust)-/, '')
    .replace(/[-.]?(js|py|node|rs|go|lang)$/, '');

  return [
    ...new Set([
      name,
      stripped,
      `@${owner}/${name}`,
      name.replace(/-/g, ''),
      // Foundation projects publish under the foundation's name: the Airflow
      // repository is apache/airflow and the package is apache-airflow.
      `${owner}-${name}`,
      // PyPI treats hyphen and underscore as one character; plenty of projects
      // pick whichever their repository does not use.
      name.replace(/_/g, '-'),
      name.replace(/-/g, '_'),
    ]),
  ].filter((candidate) => candidate.length > 1);
}

/**
 * Does a registry's declared repository URL point back at this repository?
 *
 * Matched as a whole path segment, never as a prefix. The first version used a
 * substring test and mapped `angular/angular` to the npm package `angular`,
 * which declares `github.com/angular/angular.js` — a different, archived
 * project that the shorter name happens to prefix. That would have credited
 * 692k weekly downloads of dead AngularJS to modern Angular, whose actual
 * package is `@angular/core` at 5.9M a week.
 */
export function pointsBack(declared: unknown, repo: string): boolean {
  if (typeof declared !== 'string') return false;
  const escaped = repo.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`github\\.com/${escaped}(?:[/#?]|\\.git|$)`, 'i').test(declared);
}
