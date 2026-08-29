/**
 * Search: the query box's state, the fetch to `/api/search`, blending the
 * reply into one ranking via `rankHybrid`, and the two highlight
 * range-finders bound to whatever term that ranking is for.
 *
 * Split out of `main.jsx` per `docs/state-architecture-plan.md` §3 step 6,
 * and deliberately last. By the time this ran, `useRearrangement` had already
 * collapsed "the next layout change should animate" and "here is the
 * sentence for it" into one call, `requestAnimation(note)` - so this hook has
 * one way to ask for an animation rather than two. Done first it would have
 * had to reach out and set someone else's `animateNext`/`pendingNote` refs
 * directly, which is the fifteen-parameter failure the plan is trying to
 * avoid.
 *
 * `requestAnimation` arrives through a ref rather than as a plain argument -
 * the one forward reference left in `main.jsx` after the rest were reordered
 * away, because this one is a genuine cycle rather than an ordering accident:
 * `announce` (`main.jsx`) needs this hook's `result` to know what to say,
 * `useRearrangement` needs `announce`, and `useRearrangement` is the thing
 * that returns `requestAnimation` - so this hook has to be called before
 * `useRearrangement` exists, and can only get its `requestAnimation` once
 * `main.jsx` fills the ref in afterwards.
 *
 * `history`/`pushHistory` stay in `main.jsx`: the shelf reads history, the
 * panel's forget button writes it, and it survives a reload - a search is a
 * consumer of history, not its owner.
 */
import { useMemo, useRef, useState } from 'react';
import {
  rankHybrid,
  fold,
  tokenise,
  keywordMatchRanges,
  storyMatchRanges,
} from '../../../map/scoring.js';

/**
 * @param {object} opts
 * @param {number} opts.total                     corpus size
 * @param {object} opts.searchConfig               `config.search`
 * @param {import('../../../map/searchResult.ts').SearchIndex|null} opts.searchIndex
 * @param {{current: {data: Int8Array, dim: number}|null}} opts.embeddings
 * @param {{current: Function}} opts.requestAnimationRef
 *   filled in by `main.jsx` once `useRearrangement` exists - see the file
 *   comment above.
 * @param {(term: string) => void} opts.pushHistory
 * @param {Function} opts.setStatus
 *   the live region, for the one path a search cannot route through
 *   `requestAnimation`'s announcement: a fetch that fails rearranges
 *   nothing, so it has to speak for itself.
 * @returns {{
 *   query: string,
 *   setQuery: Function,
 *   result: import('../../../map/searchResult.ts').SearchResult|null,
 *   search: (term: string) => Promise<void>,
 *   runSearch: (e: Event) => void,
 *   clearSearch: () => void,
 *   highlight: {keyword: Function, story: Function}|null,
 * }}
 */
export function useSearch({
  total,
  searchConfig,
  searchIndex,
  embeddings,
  requestAnimationRef,
  pushHistory,
  setStatus,
}) {
  const [query, setQuery] = useState('');
  // One piece of state, not two: the ranking and its certainty profile
  // describe the same search, and a frame that paired one search's order with
  // another's densities would put the wrong rooms in the cluster.
  const [result, setResult] = useState(null);

  // Which search is the newest one asked for. `search` awaits the server, and
  // nothing stops a second query being submitted while the first is still in
  // the air - a book on the shelf is one click, and the first request of a
  // session pays for loading the CLIP text tower - so without this the slow
  // early query resolves last and wins, leaving the map ranked by a term the
  // reader has already moved on from. Every write a search makes is gated on
  // still being the newest, so a superseded one lands nowhere.
  const searchSeq = useRef(0);

  // Every query passes through here, whether it came from the box, a keyword
  // chip, a book on the shelf or a catalog row - so this is the one place the
  // length cap has to hold. Scoring is O(tokens x keywords) per room, and a
  // pasted tag list against a full corpus is tens of millions of substring
  // tests on the main thread, which does not degrade, it stops. The input has
  // a `maxLength` too, but that only covers typing: a chip, a book and a
  // restored history entry all reach this without touching the box.
  const search = async (rawTerm) => {
    const term = String(rawTerm ?? '').slice(0, searchConfig.maxQueryLength);
    // Claiming the sequence is what makes this the current search, and it is
    // done before the first await so that a clear - which needs none of what
    // follows - still supersedes a query in flight.
    const seq = ++searchSeq.current;
    if (!term.trim()) {
      // Both branches rearrange the library - clearing the box restores the
      // uniform map, which is as much a rearrangement as finding something is.
      requestAnimationRef.current('');
      setResult(null);
      return;
    }
    // A real search is a history entry, and the frontmost book from now on.
    // Done before the fetch, so a click on that book is remembered even if
    // the ranking that follows is a stub.
    pushHistory(term.trim());

    let res;
    try {
      const response = await fetch(`api/search?q=${encodeURIComponent(term)}`);
      // fetch only rejects on a network failure; a 500 arrives as an ordinary
      // response whose body is not the JSON this expects.
      if (!response.ok) throw new Error(`the library answered ${response.status}`);
      res = await response.json();
    } catch (e) {
      if (seq !== searchSeq.current) return;
      // Nothing rearranged - no `requestAnimation` was ever made for this
      // search - so this is the one path that has to write the live region
      // itself.
      setStatus(`the search could not be run - ${e.message}. The library is unchanged.`);
      return;
    }
    // Past here the reply is this search's to act on, and a newer query has
    // already claimed the map.
    if (seq !== searchSeq.current) return;

    // Three signals, blended into one sort over the whole corpus. Any of them
    // may be missing - no blob, no metadata - and a ranking from the rest is
    // still a real ranking, so the only case that needs the server's stub is
    // having neither. The note says which of the three it actually was, rather
    // than implying more than the corpus can support.
    const blob = res.vector ? embeddings.current : null;
    if (blob || searchIndex) {
      const { order, certainty, breakdown, signals } = rankHybrid({
        query: term,
        count: total,
        weights: searchConfig.weights,
        minTokenLength: searchConfig.minTokenLength,
        embeddings: blob?.data,
        dim: blob?.dim,
        vector: res.vector,
        index: searchIndex,
        clipCertainty: {
          centre: searchConfig.density.clipCentre,
          high: searchConfig.density.clipHigh,
          low: searchConfig.density.clipLow,
        },
      });
      requestAnimationRef.current(describeSignals(signals, Boolean(searchIndex)));
      // `term`, not the live `query`: the box changes on every keystroke and
      // the ranking does not, so anything derived from "what was searched for"
      // - the highlight ranges especially - has to read the submitted term or
      // it would mark text against a query nobody has run yet.
      setResult({ order, certainty, breakdown, signals, term });
    } else {
      // The stub ranking is a hash, so it is not certain of anything and must
      // not pretend to be: no profile, and the map stays evenly scattered.
      requestAnimationRef.current('stub ranking — no embeddings and no keywords in this corpus');
      // No breakdown: a hash-ordered stub has no signals to explain, and an
      // explanation of a ranking nothing decided would be an invented one.
      setResult({ order: res.order, certainty: null, breakdown: null, signals: null, term });
    }
  };

  const runSearch = (e) => {
    e.preventDefault();
    search(query);
  };

  // The clear-x: not just an empty submit, because setQuery is async state -
  // calling search('') directly rather than search(query) after setQuery('')
  // means it does not race the render that clears the box.
  const clearSearch = () => {
    setQuery('');
    search('');
  };

  // The two range finders, bound to the query the CURRENT ranking is for.
  //
  // Bound rather than called with the query at each site: every consumer would
  // otherwise have to remember which of the two rules applies to the text it is
  // holding, and the whole point of `scoring.js` owning them is that the answer
  // is decided once. A keyword matches by substring, a story word by prefix;
  // handing out two functions named for the thing they mark keeps that from
  // being a decision anyone makes twice.
  //
  // Null with no search, which every consumer reads as "mark nothing".
  const highlight = useMemo(() => {
    const term = result?.term?.trim();
    if (!term) return null;
    const foldedQuery = fold(term);
    const tokens = tokenise(term, { minLength: searchConfig.minTokenLength });
    if (!foldedQuery && !tokens.length) return null;
    return {
      keyword: (text) => keywordMatchRanges(text, foldedQuery, tokens),
      story: (text) => storyMatchRanges(text, tokens),
    };
  }, [result, searchConfig]);

  return { query, setQuery, result, search, runSearch, clearSearch, highlight };
}

/**
 * What actually decided this ranking, in the panel's own voice.
 *
 * `signals` reports which of the three found anything for this query, not
 * which were available - a corpus full of keywords that none of them matched
 * should not claim the ranking was keyword-driven.
 *
 * @param {import('../../../map/searchResult.ts').RankSignals} signals
 * @param {boolean} hasText
 */
export function describeSignals({ clip, keyword, story }, hasText) {
  const hits = [keyword && 'keywords', story && 'story', clip && 'CLIP'].filter(Boolean);
  // Nothing matched and no CLIP means every score is zero, so the sort falls
  // back to index order - which is a real rearrangement, not a no-op, and
  // saying "unchanged" while the map visibly moves would be the wrong lie.
  if (!hits.length) return hasText ? 'nothing matched — showing index order' : '';
  // CLIP alone is the ordinary case for most queries and needs no announcement.
  if (hits.length === 1 && clip) return '';
  return `ranked by ${hits.join(' + ')}`;
}
