/**
 * What a room says about itself: its keywords, its story, and - while a search
 * is running - why the ranking put it where it did.
 *
 * Three consumers render this, which is the reason it is a component rather
 * than markup inside one dialog:
 *
 *   - `RoomOverlay`, the one modal reached from right-click, long press or
 *     Enter on the map, choosing a ranked result, or expanding a catalog row;
 *   - every row of the catalog;
 *   - the canvas's own nested fallback content, which is where a touch
 *     screen reader reads a room.
 *
 * They differ in two props. The fallback's chips are `tabIndex={-1}` so the
 * map stays exactly one tab stop, while the other two are ordinary tab stops.
 * And the fallback alone sets `showPicture`: the sidecar's optional `alt` is
 * real `<img alt>` text wherever a room's tile is an actual `<img>`
 * (`RoomOverlay`, the catalog thumbnail), so this component only ever renders
 * it as a paragraph for the one consumer with no `<img>` to put it on - see
 * `showPicture`'s doc comment below.
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
 * `ranges` comes from `keywordMatchRanges` / `storyMatchRanges` and is
 * already sorted, merged and non-overlapping, which is what lets this be a
 * straight walk with no bookkeeping. `<mark>` carries the meaning natively,
 * so a reader who cannot see the highlight still has some chance of being
 * told about it.
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
 * The composite line's phrase, both signs, as docs/search_rules.md
 * "Reporting" describes it.
 *
 * The negative reading says "does not match" outright rather than leaving a
 * minus sign to interpret, and is worded as a confidence claim because that
 * is what it is: only CLIP reaches the negative half, off its calibrated
 * band. The positive reading is match strength, which is not a confidence
 * claim and does not borrow the word.
 */
function compositeStrengthText(percent: number): { mismatch: boolean; text: string } {
  const magnitude = Math.abs(percent).toFixed(2);
  return percent < 0
    ? { mismatch: true, text: `${magnitude}% certain this does not match` }
    : { mismatch: false, text: `${magnitude}% match strength` };
}

/**
 * The trailing "also tied on this axis" clause, shared by every detail line -
 * "tied with 3" for three other rooms at this exact rank, empty for none. Kept
 * terse ("tied with N", not "tied with N others"): the score strip's columns
 * are tight and the meaning survives the cut.
 */
function tieClause(ties: number): string {
  return ties > 0 ? `, tied with ${ties}` : '';
}

/** "#4 by tag: 2 exact, 1 partial, tied with 3" - `null` when nothing on this axis matched. */
function tagLine(tag: RankingExplanation['tag']): string | null {
  if (!tag) return null;
  const parts: string[] = [];
  if (tag.exact > 0) parts.push(`${tag.exact} exact`);
  if (tag.partial > 0) parts.push(`${tag.partial} partial`);
  return `#${tag.rank} by tag: ${parts.join(', ')}${tieClause(tag.ties)}`;
}

/** "#3 by title: exact, tied with 1" or "...partial..." - `null` when the title didn't match. */
function titleLine(title: RankingExplanation['title']): string | null {
  if (!title) return null;
  return `#${title.rank} by title: ${title.exact ? 'exact' : 'partial'}${tieClause(title.ties)}`;
}

/** "#2 by story: length 41, tied with 1" - `null` when nothing matched the story. */
function storyLine(story: RankingExplanation['story']): string | null {
  if (!story) return null;
  return `#${story.rank} by story: length ${story.length}${tieClause(story.ties)}`;
}

/**
 * The clip line, styled per docs/search_rules.md "Reporting": a negative
 * reading is set apart (different color, italic) rather than carrying a
 * bare minus sign, so it cannot be misread as a weaker positive. The raw
 * cosine lives in its own tooltip (tap-and-hold on mobile): the visible
 * percentage already reads off the calibrated curve, and the raw number is
 * for whoever wants to check that calibration, not the main read.
 */
function ClipLine({ clip }: { clip: NonNullable<RankingExplanation['clip']> }) {
  const mismatch = clip.percent < 0;
  const pct = Math.abs(clip.percent).toFixed(2);
  return (
    <p className="score-line" title={`${clip.cosine.toFixed(3)} cosine between CLIP text and image vectors`}>
      #{clip.rank} by image:{' '}
      <span className={mismatch ? 'clip-certainty mismatch' : 'clip-certainty'}>
        {pct}% {mismatch ? 'mismatch' : 'match'}
      </span>
    </p>
  );
}

/**
 * The lines `ScoreBreakdown` shows, identically whether it is a card or a
 * catalog row - only the wrapping element's class differs between the two.
 *
 * One composite line - "#4 of 2048, 73% match strength" - whose tooltip
 * breaks the percentage into each signal's share of the total score,
 * greatest first, omitting anything that contributed nothing
 * (`contributions`, docs/search_rules.md "Reporting"). Then one visible
 * line per axis that actually found something - tag, title, story, and
 * (whenever the corpus has embeddings at all) CLIP - each carrying that
 * axis's own independent rank and tie count (`result.ranks`/`ties`), not
 * the composite's.
 *
 * A tooltip is for something hidden, and only two things are: the
 * composite's per-signal split, and the clip line's raw cosine. The
 * tag/title/story lines already say everything they have to say.
 */
function ScoreLines({ explanation }: { explanation: RankingExplanation }) {
  const { contributions, tag, title, story, clip } = explanation;
  const compositeTooltip = contributions.map((c) => `${c.percent}% by ${c.label}`).join(', ');
  const composite = compositeStrengthText(explanation.percent);
  const compositeText = `#${explanation.rank} of ${explanation.total}, ${composite.text}.`;
  const tagText = tagLine(tag);
  const titleText = titleLine(title);
  const storyText = storyLine(story);

  return (
    <>
      <p className="score-composite" title={compositeTooltip}>
        {compositeText}
      </p>
      {/*
        The per-axis lines are wrapped so they can flow into columns
        (`.score-details` in style.css) while the composite "match
        strength" line above stays full width. The catalog row picks a
        column count from its width (`--score-cols`, `scoreLayoutFor`);
        the overlay's stacked layout takes two, and its side-by-side
        split keeps one, where there is no room for more (both rules live
        under `.overlay-columns` in style.css).
      */}
      <div className="score-details">
        {tagText && <p className="score-line">{tagText}</p>}
        {titleText && <p className="score-line">{titleText}</p>}
        {storyText && <p className="score-line">{storyText}</p>}
        {clip && <ClipLine clip={clip} />}
      </div>
    </>
  );
}

/**
 * Why this room ranked where it did - see `ScoreLines`, `explainRanking`.
 *
 * Exported because the catalog row renders it outside `RoomDetails` (which
 * it calls with `weights={null}` so it renders no score): the row's score
 * strip sits in normal flow beneath a fixed-height flow area, not inside
 * it, so its top rule lands below the tile rather than beside it. The card
 * and the overlay still let `RoomDetails` render it inline, since neither
 * has that split.
 */
export function ScoreBreakdown({
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
    strength: result.strength,
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

/**
 * The favorite control and the room's global count, as one line.
 *
 * `aria-pressed` says which state the toggle is in natively, and the count
 * sits inside the accessible name because it is the thing the press changes:
 * a reader who cannot see the number beside the star still hears it move.
 *
 * Callers render nothing when there is no `FavoriteControl` - the
 * deployment records no counts, or the cell is a generic one with no file
 * to favorite - and `RoomDetails` guards its own use the same way.
 */
export function FavoriteToggle({ favorite, tabIndex = 0 }: { favorite: FavoriteControl; tabIndex?: number }) {
  const { on, count, toggle } = favorite;
  const plural = count === 1 ? 'favorite' : 'favorites';
  return (
    <div className="favorite">
      <button
        type="button"
        className={on ? 'favorite-toggle on' : 'favorite-toggle'}
        aria-pressed={on}
        tabIndex={tabIndex}
        title={on ? 'remove from your favorites' : 'add to your favorites'}
        aria-label={`${on ? 'remove from your favorites' : 'add to your favorites'}, ${count} ${plural}`}
        onClick={(e) => {
          // The catalog row and the card both have their own click handlers
          // above this one - a favorite is not also a "show me this room".
          e.stopPropagation();
          toggle();
        }}
      >
        <span aria-hidden="true">{on ? '\u2605' : '\u2606'}</span>
        <span className="favorite-count" aria-hidden="true">{count}</span>
      </button>
    </div>
  );
}

/** What a room's favorite state looks like to this component - see `useFavorites`. */
export interface FavoriteControl {
  /** whether this reader has favorited the room */
  on: boolean;
  /** how many readers have, globally */
  count: number;
  toggle: () => void;
}

export function RoomDetails({
  entry,
  desc,
  onKeyword,
  favorite = null,
  tagLinks = null,
  chipTabIndex = 0,
  highlight = null,
  rank = null,
  result = null,
  weights = null,
  scoreLayout = 'table',
  showPicture = false,
  chipOverflow = null,
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
  /** this room's favorite state, or null where the deployment records none */
  favorite?: FavoriteControl | null;
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
  /**
   * Render the sidecar's optional `alt` as visible text (`desc.picture`).
   * Everywhere a room's tile is a real `<img>` (`RoomOverlay`, the catalog
   * thumbnail), that text belongs on the `alt` attribute instead - false is
   * right there. The one caller that sets it is the map's canvas fallback
   * content (`MapView`): the tile is canvas-painted, so there is no `alt`
   * to carry it, and fallback content is never painted to the screen - a
   * sighted reader was not going to see this paragraph either way.
   */
  showPicture?: boolean;
  /**
   * How many keywords this consumer could not show, and what to do about it.
   *
   * Only the catalog's rows pass it: a row is a fixed height, so a room
   * with more keywords than fit has to lose some, and no reserve can
   * promise otherwise at an arbitrary width with arbitrary keyword lengths
   * (see `chipLines` in `packages/web/src/lib/catalog.ts`). Saying "+2" and
   * opening the room is the honest version of that; cutting them silently
   * is not. The card and the overlay pass nothing, because neither has to
   * cut anything.
   */
  chipOverflow?: { count: number; onClick: () => void } | null;
}) {
  return (
    <>
      {favorite && <FavoriteToggle favorite={favorite} tabIndex={chipTabIndex} />}

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
          {chipOverflow && (
            <button
              type="button"
              className="chip chip-more"
              tabIndex={chipTabIndex}
              title="open the room to see every keyword"
              aria-label={`${chipOverflow.count} more ${chipOverflow.count === 1 ? 'keyword' : 'keywords'}, open the room`}
              onClick={(e) => {
                e.stopPropagation();
                chipOverflow.onClick();
              }}
            >
              +{chipOverflow.count}
            </button>
          )}
        </div>
      )}

      {/*
        `desc.picture` as text - the case `showPicture`'s doc describes.
        Never highlighted: it is a report of the image and was never part
        of the search index, so marking it would claim a match that did not
        happen.
      */}
      {showPicture && desc?.picture && <p className="picture">{desc.picture}</p>}

      {desc?.description && (
        <p className="story">
          <Highlight text={desc.description} ranges={highlight?.story(desc.description)} />
        </p>
      )}

      {/*
        "No keywords recorded" is a claim about a corpus room's metadata. A
        generic cell has none by definition and has already said so through
        `desc.description` - repeating it here would read as a second,
        contradictory explanation for the same shelf.
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
