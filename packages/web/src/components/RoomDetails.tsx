/**
 * What a room says about itself: its keywords, what the picture shows, its
 * story, and - while a search is running - why the ranking put it where it did.
 *
 * THREE consumers, which is the reason this is a component rather than markup
 * inside the card:
 *
 *   - the room card, opened by right-click, long press or Enter;
 *   - every row of the catalog;
 *   - the canvas's own nested fallback content, which is where a touch screen
 *     reader reads a room (accessibility-plan.md §4.2b) and which was the same
 *     story-and-chips markup written a second time.
 *
 * They differ in one thing, and it is a prop: the fallback's chips are
 * `tabIndex={-1}` so the map stays exactly one tab stop, while the card's and
 * the catalog's are ordinary tab stops.
 *
 * The reading order is the card's - keywords, then caption, then story - and
 * the fallback now follows it rather than the reverse order it used to have.
 * One order, so a reader who meets a room both ways meets it the same way.
 */
import type { ReactNode } from 'react';
import { explainRanking } from '../../../map/scoring.ts';
import type { RoomMeta } from '../../../map/metadata.ts';
import type { Description } from '../../../map/describe.ts';
import type { SearchResult, MatchRange, RankingExplanation } from '../../../map/searchResult.ts';
import type { Config } from '../../../config/config.ts';

/**
 * Text with the matched spans marked.
 *
 * `ranges` comes from `keywordMatchRanges` / `storyMatchRanges` and is already
 * sorted, merged and non-overlapping, which is what lets this be a straight
 * walk with no bookkeeping. `<mark>` rather than a styled span on purpose: it
 * carries the meaning natively, so a reader who cannot see the highlight still
 * has some chance of being told about it.
 */
export function Highlight({ text, ranges }: { text: string; ranges?: MatchRange[] | null }): ReactNode {
  if (!ranges?.length) return text;

  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach((r, i) => {
    if (r.start > at) out.push(text.slice(at, r.start));
    out.push(<mark key={i}>{text.slice(r.start, r.end)}</mark>);
    at = r.end;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * A signed certainty as the compact phrase docs/search_rules.md "Reporting"
 * describes - a distinct style for the negative reading so it is never
 * mistaken for a positive, if weaker, match.
 */
function signedCertaintyText(percent: number, subject: string): { mismatch: boolean; text: string } {
  const mismatch = percent < 0;
  const magnitude = Math.abs(percent).toFixed(2);
  return { mismatch, text: `${magnitude}% certain ${subject} ${mismatch ? 'does not match' : 'matches'}` };
}

/** "#4 by tag, 2 matched, 1 partially matched, tied with 3 others" - `null` when nothing on this axis matched. */
function tagLine(tag: RankingExplanation['tag']): string | null {
  if (!tag) return null;
  const parts: string[] = [];
  if (tag.exact > 0) parts.push(`${tag.exact} matched`);
  if (tag.partial > 0) parts.push(`${tag.partial} partially matched`);
  const tie = tag.ties > 0 ? `, tied with ${tag.ties} others` : '';
  return `#${tag.rank} by tag, ${parts.join(', ')}${tie}`;
}

/** "#2 by story, match length 41, tied with 1 other" - `null` when nothing matched the story. */
function storyLine(story: RankingExplanation['story']): string | null {
  if (!story) return null;
  const tie = story.ties > 0 ? `, tied with ${story.ties} others` : '';
  return `#${story.rank} by story, match length ${story.length}${tie}`;
}

/**
 * The clip line, styled: the certainty phrase is set apart (a different
 * color, italic when it reads as a mismatch) so it is never mistaken for a
 * positive, if weaker, match. The raw cosine lives in ITS OWN tooltip
 * (tap-and-hold on mobile) - "reasonably certain" already reads off the
 * calibrated curve on the visible line, and the raw number is for whoever
 * wants to check that calibration, not the main read.
 */
function ClipLine({ clip }: { clip: NonNullable<RankingExplanation['clip']> }) {
  const { mismatch, text } = signedCertaintyText(clip.percent, 'image');
  return (
    <p className="score-line" title={`${clip.cosine.toFixed(3)} cosine between CLIP text and image vectors`}>
      #{clip.rank} by image content, <span className={mismatch ? 'clip-certainty mismatch' : 'clip-certainty'}>{text}</span>
    </p>
  );
}

/**
 * The lines `ScoreBreakdown` shows, identically whether it is a card or a
 * catalog row - only the wrapping element's class differs between the two.
 * One composite line - "#4 of 2048, 73% match certainty" - whose tooltip
 * (tap-and-hold on mobile) breaks that percentage into each signal's SHARE
 * of the total score, greatest first, omitting anything that contributed
 * nothing (docs/search_rules.md "Reporting"). Then one VISIBLE line per axis
 * that actually found something - tag, story, and (whenever the corpus has
 * embeddings at all) CLIP - each carrying that axis's OWN independent
 * rank/tie count (`result.ranks`/`ties`), not the composite's. A tooltip is
 * for something hidden, and only two things are: the composite's per-signal
 * split, and the clip line's raw cosine - the tag/story lines already say
 * everything they have to say.
 */
function ScoreLines({ explanation }: { explanation: RankingExplanation }) {
  const { contributions, tag, story, clip } = explanation;
  const compositeTooltip = contributions.map((c) => `${c.percent}% by ${c.label}`).join(', ');
  const composite = signedCertaintyText(explanation.percent, 'this');
  const compositeText = composite.mismatch
    ? `#${explanation.rank} of ${explanation.total}, ${composite.text}.`
    : `#${explanation.rank} of ${explanation.total}, ${Math.abs(explanation.percent).toFixed(2)}% match certainty.`;
  const tagText = tagLine(tag);
  const storyText = storyLine(story);

  return (
    <>
      <p className="score-composite" title={compositeTooltip}>
        {compositeText}
      </p>
      {tagText && <p className="score-line">{tagText}</p>}
      {storyText && <p className="score-line">{storyText}</p>}
      {clip && <ClipLine clip={clip} />}
    </>
  );
}

/** Why this room ranked where it did - see `ScoreLines`, `explainRanking`. */
function ScoreBreakdown({
  rank,
  result,
  weights,
  layout = 'table',
}: {
  rank: number | null;
  result: SearchResult | null;
  weights: Config['search']['weights'];
  layout?: 'table' | 'strip';
}) {
  if (!result?.breakdown || !result.ranks || !result.ties || rank == null || rank < 0) return null;
  const explanation = explainRanking(rank, {
    breakdown: result.breakdown,
    certainty: result.certainty,
    ranks: result.ranks,
    ties: result.ties,
    weights,
    total: result.order.length,
  });
  if (!explanation) return null;

  return (
    <div className={layout === 'strip' ? 'score-strip' : 'score'}>
      <ScoreLines explanation={explanation} />
    </div>
  );
}

export function RoomDetails({
  entry,
  desc,
  onKeyword,
  tagLinks = null,
  chipTabIndex = 0,
  highlight = null,
  rank = null,
  result = null,
  weights = null,
  scoreLayout = 'table',
}: {
  /** the room's metadata, from `joinMetadata()` */
  entry: RoomMeta | null;
  /** from `describeRoom` / `describeCell` */
  desc: Description | null;
  /** a chip runs this search */
  onKeyword: (keyword: string) => void;
  /** keyword -> external link, from the corpus's optional tagLinks.json (see useCorpus.ts) -
   * a keyword with an entry grows a second "more about this" pill fused to it */
  tagLinks?: Record<string, string> | null;
  /** -1 inside the canvas, 0 everywhere else */
  chipTabIndex?: number;
  /** the two range finders, already bound to the submitted query */
  highlight?: { keyword: (text: string) => MatchRange[]; story: (text: string) => MatchRange[] } | null;
  /** for the score breakdown */
  rank?: number | null;
  /** the current search, for the breakdown */
  result?: SearchResult | null;
  weights?: Config['search']['weights'] | null;
  /** a card has room for the table; a catalog row needs the one-line strip, or it clips */
  scoreLayout?: 'table' | 'strip';
}) {
  return (
    <>
      {entry?.keywords && entry.keywords.length > 0 && (
        <div className="chips">
          {entry.keywords.map((k) => {
            const href = tagLinks?.[k.text] ?? null;
            return (
              <span key={k.text} className={href ? 'chip-group' : undefined}>
                <button
                  className="chip"
                  type="button"
                  tabIndex={chipTabIndex}
                  title={k.type ? `${k.type} — search for this` : 'search for this'}
                  onClick={() => onKeyword(k.text)}
                >
                  <Highlight text={k.text} ranges={highlight?.keyword(k.text)} />
                </button>
                {href && (
                  <a
                    className="chip-link"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    tabIndex={chipTabIndex}
                    title={`more about ${k.text}`}
                    aria-label={`more about ${k.text}, opens in a new tab`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    ↗
                  </a>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/*
        What the picture shows, above what the room is: the sidecar's optional
        `alt` (accessibility-plan.md §3.5). VISIBLE rather than screen-reader
        only, on §3.6's argument that an invisible layer rots - a caption nobody
        sighted ever reads is one nobody notices has drifted from the image it
        describes. Never highlighted: it is a report of the image and was never
        part of the search index, so marking it would claim a match that did not
        happen.
      */}
      {desc?.picture && <p className="picture">{desc.picture}</p>}

      {desc?.description && (
        <p className="story">
          <Highlight text={desc.description} ranges={highlight?.story(desc.description)} />
        </p>
      )}

      {/*
        "No keywords recorded" is a claim about a corpus room's metadata; a
        generic cell has none by definition and already said so above, via
        `desc.description` - repeating it here would read as a second,
        contradictory explanation for the same blank wall.
      */}
      {!entry && desc?.kind !== 'generic' && (
        <p className="story dim">No keywords recorded for this room.</p>
      )}

      {weights && (
        <ScoreBreakdown rank={rank} result={result} weights={weights} layout={scoreLayout} />
      )}
    </>
  );
}
