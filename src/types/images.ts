import type { AssertExhaustive } from './keys.ts';

/** One base image tag, as Docker Hub reports it today. */
export interface ImageRow {
  /** Official library image, e.g. `node`. */
  image: string;
  /** Tag as people write it in a Dockerfile, e.g. `24-alpine`. */
  tag: string;
  /** Compressed size Docker Hub reports for the tag. */
  bytes: number;
  /**
   * When the image behind the tag was last rebuilt.
   *
   * The field that makes this worth recording. A tag is a moving target, and
   * one nobody has rebuilt in six months ships six months of unpatched
   * distribution packages while looking identical to one built this morning.
   */
  updatedAt: string;
  observedAt: string;
}

export const IMAGE_KEYS = [
  'image',
  'tag',
  'bytes',
  'updatedAt',
  'observedAt',
] as const satisfies readonly (keyof ImageRow)[];

export type _ImageKeysExhaustive = AssertExhaustive<
  Exclude<keyof ImageRow, (typeof IMAGE_KEYS)[number]>
>;
