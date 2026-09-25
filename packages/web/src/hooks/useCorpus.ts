/**
 * The corpus data derived from the manifest: the keyword/story sidecar, the
 * embedding blob, the tag links, and the search index built over them.
 *
 * `embeddings` is a ref holding `{ data, dim, scale }`, not React state: it is
 * a megabyte-scale `Int8Array` nothing reads during render, so its arrival
 * need not re-render.
 *
 * `tagLinks` is a small keyword -> url object, held as React state.
 *
 * Each fetch the manifest advertises can fail on its own (an interrupted
 * `tools/upload` sync can leave a manifest naming a missing `metadata.json`
 * or `embeddings.bin`). The corpus still renders, with degraded search, and
 * `corpusErrors` names the failed sources for the panel line in
 * `MapView.tsx`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { joinMetadata, type RoomMeta } from '../../../map/metadata.ts';
import { buildSearchIndex } from '../../../map/scoring.ts';
import type { ManifestResponse } from '../../../map/manifest.ts';

/** A fetch the manifest advertised that came back non-ok or threw, named for the HUD line in `MapView.tsx`. */
export type CorpusErrorSource = 'metadata' | 'embeddings' | 'tagLinks';

/** @param minTokenLength config `search.minTokenLength`, which the story index must share with the query side */
export function useCorpus(manifest: ManifestResponse, minTokenLength: number) {
  const [metadata, setMetadata] = useState<(RoomMeta | null)[] | null>(null);
  const [tagLinks, setTagLinks] = useState<Record<string, string> | null>(null);
  const [corpusErrors, setCorpusErrors] = useState<CorpusErrorSource[]>([]);

  const addError = (source: CorpusErrorSource) =>
    setCorpusErrors((prev) => (prev.includes(source) ? prev : [...prev, source]));

  // The embedding blob, fetched once if the corpus has one. Ranking is a few
  // million int8 multiply-adds against it (rankByEmbedding), well under a
  // frame, so a search - and every re-rank off the same vector - stays on the
  // client.
  const embeddings = useRef<{ data: Int8Array; dim: number; scale: number } | null>(null);
  useEffect(() => {
    if (!manifest.embeddings) return;
    let cancelled = false;
    fetch(manifest.embeddings.url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (!cancelled)
          embeddings.current = {
            data: new Int8Array(buf),
            dim: manifest.embeddings!.dim,
            scale: manifest.embeddings!.scale,
          };
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
  // (docs/agents/search.md, "`tagLinks.json` is a flat keyword -> url map").
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
  const searchIndex = useMemo(
    () => (metadata ? buildSearchIndex(metadata, { minLength: minTokenLength }) : null),
    [metadata, minTokenLength]
  );

  return { metadata, embeddings, searchIndex, described, tagLinks, corpusErrors };
}
