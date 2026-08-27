/**
 * Everything the corpus IS: the keyword/story sidecar, the embedding blob, and
 * the search index built over them - three things fetched or derived from the
 * manifest and nothing else.
 *
 * Split out of `main.jsx` per `docs/state-architecture-plan.md` §3 step 4.
 * Small and obvious on its own; worth doing mostly so "load the corpus" is one
 * call instead of two fetch effects and a memo scattered through `Library`.
 *
 * `embeddings` stays a ref holding `{ data, dim }` rather than becoming React
 * state - it is a megabyte-scale `Int8Array`, and re-rendering `Library` every
 * time it arrives would be paid for nothing anyone reads from it synchronously.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { joinMetadata } from '../../map/metadata.js';
import { buildSearchIndex } from '../../map/scoring.js';

/**
 * @param {object} manifest  the loaded `/api/manifest` response
 * @returns {{
 *   metadata: (import('../../map/metadata.js').RoomMeta|null)[] | null,
 *   embeddings: {current: {data: Int8Array, dim: number} | null},
 *   searchIndex: ReturnType<typeof buildSearchIndex> | null,
 *   described: number,
 * }}
 */
export function useCorpus(manifest) {
  const [metadata, setMetadata] = useState(null);

  // The embedding blob, fetched once if the corpus has one. Ranking is a few
  // million int8 multiply-adds against it (rankByEmbedding), well under a
  // frame, so a search - and every re-rank off the same vector - stays on the
  // client.
  const embeddings = useRef(null);
  useEffect(() => {
    if (!manifest.embeddings) return;
    let cancelled = false;
    fetch(manifest.embeddings.url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (!cancelled) embeddings.current = { data: new Int8Array(buf), dim: manifest.embeddings.dim };
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  // The keyword/story sidecar, fetched alongside the blob rather than inlined
  // into the manifest: at a full corpus it is megabytes, and the manifest is
  // on the path to the first frame. Joined by filename into an array indexed
  // by room id, which is what search and the overlay will both want.
  useEffect(() => {
    if (!manifest.metadata) return;
    let cancelled = false;
    fetch(manifest.metadata.url)
      .then((r) => r.json())
      .then((sidecar) => {
        if (!cancelled) setMetadata(joinMetadata(manifest.rooms, sidecar));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  const described = useMemo(() => metadata?.filter(Boolean).length ?? 0, [metadata]);

  // Folded and tokenised once, so a search is set lookups rather than a
  // megabyte of string work.
  const searchIndex = useMemo(() => (metadata ? buildSearchIndex(metadata) : null), [metadata]);

  return { metadata, embeddings, searchIndex, described };
}
