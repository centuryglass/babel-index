/**
 * Everything the corpus IS: the keyword/story sidecar, the embedding blob, and
 * the search index built over them - three things fetched or derived from the
 * manifest and nothing else, so "load the corpus" is one call instead of two
 * fetch effects and a memo scattered through `Library`.
 *
 * `embeddings` stays a ref holding `{ data, dim }` rather than becoming React
 * state - it is a megabyte-scale `Int8Array`, and re-rendering every time it
 * arrives would be paid for nothing anyone reads from it synchronously.
 *
 * `tagLinks` is a flat keyword -> url object, small enough (a few dozen
 * entries at most) to be React state directly.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { joinMetadata, type RoomMeta } from '../../../map/metadata.ts';
import { buildSearchIndex } from '../../../map/scoring.ts';
import type { ManifestResponse } from '../../../map/manifest.ts';

export function useCorpus(manifest: ManifestResponse) {
  const [metadata, setMetadata] = useState<(RoomMeta | null)[] | null>(null);
  const [tagLinks, setTagLinks] = useState<Record<string, string> | null>(null);

  // The embedding blob, fetched once if the corpus has one. Ranking is a few
  // million int8 multiply-adds against it (rankByEmbedding), well under a
  // frame, so a search - and every re-rank off the same vector - stays on the
  // client.
  const embeddings = useRef<{ data: Int8Array; dim: number } | null>(null);
  useEffect(() => {
    if (!manifest.embeddings) return;
    let cancelled = false;
    fetch(manifest.embeddings.url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (!cancelled) embeddings.current = { data: new Int8Array(buf), dim: manifest.embeddings!.dim };
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

  // The keyword -> external-link map: a corpus-specific file, fetched from
  // its own url and absent from any corpus that has not been given one
  // (AGENTS.md, "`tagLinks.json` is a flat keyword -> url map").
  useEffect(() => {
    if (!manifest.tagLinks) return;
    let cancelled = false;
    fetch(manifest.tagLinks.url)
      .then((r) => r.json())
      .then((map) => {
        if (!cancelled) setTagLinks(map);
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

  return { metadata, embeddings, searchIndex, described, tagLinks };
}
