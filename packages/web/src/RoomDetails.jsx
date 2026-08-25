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
import { explainScore } from '../../map/scoring.js';

/**
 * Text with the matched spans marked.
 *
 * `ranges` comes from `keywordMatchRanges` / `storyMatchRanges` and is already
 * sorted, merged and non-overlapping, which is what lets this be a straight
 * walk with no bookkeeping. `<mark>` rather than a styled span on purpose: it
 * carries the meaning natively, so a reader who cannot see the highlight still
 * has some chance of being told about it.
 */
export function Highlight({ text, ranges }) {
  if (!ranges?.length) return text;

  const out = [];
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
 * Why this room ranked where it did.
 *
 * Shown only under a search, and only for a room the search actually ranked.
 * The CLIP row prints its raw cosine beside the relative score, and certainty
 * gets its own line, because `breakdown.clip` is min-maxed across the corpus
 * for this query - some room scores 1.00 for `cghjj` too, and a bare 1.00 would
 * tell a reader the library was certain about a wall it has nothing to say
 * about. See `explainScore`.
 */
function ScoreBreakdown({ rank, result, weights, layout = 'table' }) {
  if (!result?.breakdown || rank == null || rank < 0) return null;
  const { rows, total, certainty } = explainScore(rank, {
    breakdown: result.breakdown,
    certainty: result.certainty,
    weights,
  });
  if (!rows.length) return null;

  // Two presentations of ONE computation. A card has the room to itself and can
  // afford a table; a catalog row is one line in a list of hundreds, and the
  // table there was 108px tall in a 202px row and clipped its own last line.
  // The numbers still come from a single `explainScore`, so the two layouts can
  // disagree about shape and never about the score.
  //
  // The strip is one line high whatever the query found: it never wraps, and
  // scrolls sideways in its own box if it has to, so every row in the catalog
  // stays exactly as tall as every other. That uniformity is what the sliding
  // window's spacer arithmetic rests on.
  if (layout === 'strip') {
    return (
      <ul className="score-strip">
        {rows.map((r) => (
          <li key={r.key} title={r.note ?? undefined}>
            {r.label} <b>{r.weighted.toFixed(3)}</b> <span>{r.raw.toFixed(2)}</span>
          </li>
        ))}
        <li className="total">
          total <b>{total.toFixed(3)}</b>
        </li>
        <li className="sure">
          certainty <b>{certainty.toFixed(2)}</b>
        </li>
      </ul>
    );
  }

  return (
    <div className="score">
      <table>
        <caption>why this ranked {rank + 1}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td className="num">{r.weighted.toFixed(3)}</td>
              <td className="raw" title={r.note ?? undefined}>
                {r.raw.toFixed(2)}
              </td>
            </tr>
          ))}
          <tr className="total">
            <th scope="row">total</th>
            <td className="num">{total.toFixed(3)}</td>
            <td className="raw" />
          </tr>
          <tr className="sure">
            {/*
              Not part of the sum, and set apart so it cannot be read as one of
              its terms: every row above is relative to this query's corpus,
              this one is measured against absolute bounds.
            */}
            <th scope="row">certainty</th>
            <td className="num">{certainty.toFixed(2)}</td>
            <td className="raw">absolute</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object|null} props.entry the room's metadata, from `joinMetadata()`
 * @param {object|null} props.desc from `describeRoom` / `describeCell`
 * @param {(text: string) => void} props.onKeyword a chip runs this search
 * @param {number} [props.chipTabIndex] -1 inside the canvas, 0 everywhere else
 * @param {{keyword: (text: string) => object[], story: (text: string) => object[]}|null} [props.highlight]
 *   the two range finders, already bound to the submitted query
 * @param {number|null} [props.rank] for the score breakdown
 * @param {object|null} [props.result] the current search, for the breakdown
 * @param {object} [props.weights]
 * @param {'table'|'strip'} [props.scoreLayout] a card has room for the table; a
 *   catalog row needs the one-line strip, or it clips
 */
export function RoomDetails({
  entry,
  desc,
  onKeyword,
  chipTabIndex = 0,
  highlight = null,
  rank = null,
  result = null,
  weights = null,
  scoreLayout = 'table',
}) {
  return (
    <>
      {entry?.keywords?.length > 0 && (
        <div className="chips">
          {entry.keywords.map((k) => (
            <button
              key={k.text}
              className="chip"
              type="button"
              tabIndex={chipTabIndex}
              title={k.type ? `${k.type} — search for this` : 'search for this'}
              onClick={() => onKeyword(k.text)}
            >
              <Highlight text={k.text} ranges={highlight?.keyword(k.text)} />
            </button>
          ))}
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
