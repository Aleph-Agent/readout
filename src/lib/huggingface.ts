/**
 * Hugging Face model metadata.
 *
 * Only what the lineage lens needs: which models declare a given model as the
 * one they were built from. That relation is public, unauthenticated, and
 * self-declared by the uploader, which is worth remembering — this measures
 * what people say they built on, not what they demonstrably did.
 */

const API_ROOT = 'https://huggingface.co/api';

export interface Descendant {
  /** `owner/model`. */
  id: string;
  /** ISO 8601. Absent on a few older records. */
  createdAt: string | null;
  downloads: number;
  likes: number;
}

export interface HuggingFaceClient {
  /**
   * Models declaring `baseModel` as their base, newest first.
   *
   * Stops as soon as it reaches something at or older than `since`, so an
   * ordinary week costs one page. There is no total-count header, so counting
   * every descendant would mean paginating through thousands of records to
   * learn a number that says less than the new ones do.
   */
  descendantsSince(baseModel: string, since: string | null, cap?: number): Promise<Descendant[]>;
  requests(): number;
}

interface ModelRecord {
  id?: string;
  modelId?: string;
  createdAt?: string;
  downloads?: number;
  likes?: number;
}

export interface HuggingFaceOptions {
  fetchImpl?: typeof fetch;
  /** Optional token. Public model metadata does not require one. */
  token?: string;
  sleep?: (ms: number) => Promise<void>;
}

export function createHuggingFaceClient(options: HuggingFaceOptions = {}): HuggingFaceClient {
  const {
    fetchImpl = fetch,
    token = '',
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  let requests = 0;

  return {
    requests: () => requests,

    async descendantsSince(baseModel, since, cap = 300): Promise<Descendant[]> {
      const found: Descendant[] = [];
      const perPage = 100;

      for (let page = 0; page * perPage < cap; page += 1) {
        const url =
          `${API_ROOT}/models?filter=${encodeURIComponent(`base_model:${baseModel}`)}` +
          `&sort=createdAt&direction=-1&limit=${perPage}&skip=${page * perPage}`;

        const headers: Record<string, string> = { accept: 'application/json' };
        if (token !== '') headers['authorization'] = `Bearer ${token}`;

        requests += 1;
        const response = await fetchImpl(url, { headers });

        if (!response.ok) {
          throw new Error(`Hugging Face ${response.status} for ${baseModel}`);
        }

        const batch = (await response.json()) as ModelRecord[];
        if (batch.length === 0) return found;

        for (const record of batch) {
          const id = record.id ?? record.modelId;
          if (id === undefined) continue;

          const createdAt = record.createdAt ?? null;
          // Everything from here down is older than the watermark, and the
          // list is sorted, so there is nothing left worth reading.
          if (since !== null && createdAt !== null && createdAt <= since) return found;

          found.push({
            id,
            createdAt,
            downloads: record.downloads ?? 0,
            likes: record.likes ?? 0,
          });
        }

        if (batch.length < perPage) return found;
        // Spacing: this is an unauthenticated public endpoint and the weekly
        // job is in no hurry.
        await sleep(1200);
      }

      return found;
    },
  };
}
