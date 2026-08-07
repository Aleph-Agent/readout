import type { ImageRow } from '../types/images.ts';
import type { TyposquatRow } from '../types/typosquat.ts';

/**
 * Base images and near-miss package names, summarised for a page.
 *
 * Both datasets were being collected and published as JSON while the page
 * showed neither. Data nobody can see is data nobody has.
 */

export interface ImageReading {
  image: string;
  tag: string;
  bytes: number;
  /** Days since the image behind the tag was last rebuilt. */
  staleDays: number;
  /** Megabytes over the lightest tag of the same image. Null when it is that one. */
  overLightest: number | null;
}

export interface ImageSummary {
  /** Tags with a reading. */
  tags: number;
  images: number;
  /** Days since the least recently rebuilt tag was rebuilt. */
  stalestDays: number | null;
  /** Heaviest first, one row per tag. Bounded — see `IMAGE_LIMIT`. */
  heaviest: ImageReading[];
  /** Longest since a rebuild first. The reading nobody else surfaces. */
  stalest: ImageReading[];
}

export interface NameReading {
  canonical: string;
  /** Names one edit away that exist on the registry. */
  neighbours: { name: string; lastPublish: string }[];
}

export interface NameSummary {
  /** Packages swept this run. */
  swept: number;
  /** Neighbouring names found across them. */
  found: number;
  /** Most neighbours first. Bounded — see `NAME_LIMIT`. */
  byPackage: NameReading[];
}

export const IMAGE_LIMIT = 10;
export const NAME_LIMIT = 8;

/** Past this, a tag has missed a round of distribution security patches. */
export const STALE_DAYS = 30;

export function summariseImages(rows: readonly ImageRow[], today: string): ImageSummary {
  if (rows.length === 0) {
    return { tags: 0, images: 0, stalestDays: null, heaviest: [], stalest: [] };
  }

  const now = Date.parse(`${today}T00:00:00Z`);

  // The lightest tag of each image is the comparison that makes a size mean
  // something. "409 MB" is a number; "349 MB more than the alpine tag of the
  // same image" is a decision.
  const lightest = new Map<string, number>();
  for (const row of rows) {
    const held = lightest.get(row.image);
    if (held === undefined || row.bytes < held) lightest.set(row.image, row.bytes);
  }

  const readings: ImageReading[] = rows.map((row) => {
    const floor = lightest.get(row.image) as number;
    return {
      image: row.image,
      tag: row.tag,
      bytes: row.bytes,
      staleDays: Math.max(0, Math.round((now - Date.parse(row.updatedAt)) / 86_400_000)),
      overLightest: row.bytes === floor ? null : Math.round((row.bytes - floor) / 1e6),
    };
  });

  return {
    tags: readings.length,
    images: lightest.size,
    stalestDays: Math.max(...readings.map((reading) => reading.staleDays)),
    heaviest: [...readings].sort((a, b) => b.bytes - a.bytes).slice(0, IMAGE_LIMIT),
    stalest: [...readings]
      .sort((a, b) => b.staleDays - a.staleDays || a.image.localeCompare(b.image))
      .slice(0, IMAGE_LIMIT),
  };
}

export function summariseNames(rows: readonly TyposquatRow[]): NameSummary {
  const byCanonical = new Map<string, { name: string; lastPublish: string }[]>();

  for (const row of rows) {
    const list = byCanonical.get(row.canonical);
    const entry = { name: row.name, lastPublish: row.lastPublish };
    if (list) list.push(entry);
    else byCanonical.set(row.canonical, [entry]);
  }

  const byPackage: NameReading[] = [...byCanonical.entries()]
    .map(([canonical, neighbours]) => ({
      canonical,
      neighbours: [...neighbours].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort(
      (a, b) => b.neighbours.length - a.neighbours.length || a.canonical.localeCompare(b.canonical),
    );

  return {
    swept: byCanonical.size,
    found: rows.length,
    byPackage: byPackage.slice(0, NAME_LIMIT),
  };
}
