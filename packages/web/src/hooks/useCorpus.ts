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
 *
 * Each of the three fetches the manifest advertises can fail on its own - an
 * interrupted `tools/upload` sync is a plausible way to end up with a
 * manifest naming a `metadata.json` or `embeddings.bin` that 404s - and the
 * corpus still renders in that state, just with degraded search. `corpusErrors`
 * names which of them did, for the HUD line in `MapView.tsx` (`described`'s
 * neighbor) rather than a `.catch(() => {})` a maintainer can only find by
 * opening the network tab.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { joinMetadata, type RoomMeta } from '../../../map/metadata.ts';
import { buildSearchIndex } from '../../../map/scoring.ts';
import type { ManifestResponse } from '../../../map/manifest.ts';

/** A fetch the manifest advertised that came back non-ok or threw, named for the HUD line in `MapView.tsx`. */
export type CorpusErrorSource = 'metadata' | 'embeddings' | 'tagLinks';

export function useCorpus(manifest: ManifestResponse) {
  const [metadata, setMetadata] = useState<(RoomMeta | null)[] | null>(null);
  const [tagLinks, setTagLinks] = useState<Record<string, string> | null>(null);
  const [corpusErrors, setCorpusErrors] = useState<CorpusErrorSource[]>([]);

  const addError = (source: CorpusErrorSource) =>
    setCorpusErrors((prev) => (prev.includes(source) ? prev : [...prev, source]));

  // The embedding blob, fetched once if the corpus has one. Ranking is a few
  // million int8 multiply-adds against it (rankByEmbedding), well under a
  // frame, so a search - and every re-rank off the same vector - stays on the
  // client.
  const embeddings = useRef<{ data: Int8Array; dim: number } | null>(null);
  useEffect(() => {
    if (!manifest.embeddings) return;
    let cancelled = false;
    fetch(manifest.embeddings.url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (!cancelled) embeddings.current = { data: new Int8Array(buf), dim: manifest.embeddings!.dim };
      })
      .catch(() => {
        if (!cancelled) addError('embeddings');
      });
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
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((sidecar) => {
        if (!cancelled) setMetadata(joinMetadata(manifest.rooms, sidecar));
      })
      .catch(() => {
        if (!cancelled) addError('metadata');
      });
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
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((map) => {
        if (!cancelled) setTagLinks(map);
      })
      .catch(() => {
        if (!cancelled) addError('tagLinks');
      });
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  const described = useMemo(() => metadata?.filter(Boolean).length ?? 0, [metadata]);

  // Folded and tokenised once, so a search is set lookups rather than a
  // megabyte of string work.
  const searchIndex = useMemo(() => (metadata ? buildSearchIndex(metadata) : null), [metadata]);

  return { metadata, embeddings, searchIndex, described, tagLinks, corpusErrors };
}
