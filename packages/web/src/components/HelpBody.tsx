/**
 * The explanatory prose inside `HelpDialog` - what the interface is, how to
 * search, keyboard shortcuts. Pure and stateless (no hooks, no browser
 * calls), which is what lets `packages/server/staticPages.tsx` render this
 * exact markup with `react-dom/server` for the SSR `/help` route - the words
 * live here once rather than as a second copy kept in step by hand.
 *
 * The content-blocking panel is not part of this component: it reflects a
 * reader's own stored choices and the corpus's tags, neither of which the
 * server has, so it stays inline in `HelpDialog.tsx`.
 */
export function HelpBody() {
  return (
    <div className="help-body">
      <p>
        <strong>What this is:</strong> a zoomable, pannable map of library
        rooms, each paired with keywords and a short story. Most rooms are alike,
        but strange variations can be found among them.
      </p>
      <p>
        <strong>Move around:</strong> drag to pan, scroll or pinch to zoom. With a
        keyboard, arrow keys pan the map when no other control has focus.
      </p>
      <p>
        <strong>View a room:</strong> right-click it, long-press it, or focus it and
        press Enter, to see the full image, its story, and its keywords.
      </p>
      <p>
        <strong>Search:</strong> type a word or phrase into the search box at the
        center of the map. The map rearranges so closer matches sit nearer the center;
        an unrelated search leaves rooms mixed evenly with generic ones, which is a
        visible sign of how confident the match is. The books on the center shelf are
        shortcuts: some repeat an earlier search, others try a keyword drawn from the
        collection.
      </p>
      <p>
        <strong>Catalog view:</strong> one of the center shelf's books switches to a
        plain list view of the same collection, better suited to reading result by
        result than scanning a map.
      </p>
      <p>
        <strong>Favorites:</strong> mark a room as a favorite to find it again later and
        to help others discover the most interesting ones. Sort by your favorites to see
        all rooms you've marked, or by most favorited to see which ones other people
        recommend. Favorite counts are anonymized and tied to your browser, not to you.
        It's the only data this site stores on its server.
      </p>
      <p>
        <strong>Keyboard, general:</strong> Tab moves between controls, arrow keys pan
        the map or move shelf/list focus, Enter activates whatever is focused, and
        Escape closes an open dialog.
      </p>
      <div className="help-keys-group">
        <p>
          <strong>Keyboard, on the map:</strong> the shortcuts below apply once the map
          itself has focus (Tab to it, or click it).
        </p>
        <dl className="help-keys">
          <dt>Arrow keys</dt>
          <dd>move one room at a time</dd>
          <dt>Shift + arrow</dt>
          <dd>jump a full screen in that direction</dd>
          <dt>Ctrl/Cmd + arrow</dt>
          <dd>jump to the next unique room in that direction, skipping generic ones</dd>
          <dt>+ / - (or Page Up/Down)</dt>
          <dd>zoom in or out, centered on the current room</dd>
          <dt>Home</dt>
          <dd>return to the center</dd>
          <dt>Ctrl/Cmd + Home</dt>
          <dd>jump to the top search result</dd>
          <dt>Ctrl/Cmd + End</dt>
          <dd>jump to the lowest-ranked search result</dd>
          <dt>Enter / Space</dt>
          <dd>open the current room</dd>
          <dt>/</dt>
          <dd>jump to the search box</dd>
          <dt>?</dt>
          <dd>hear a description of what's nearby</dd>
        </dl>
      </div>
    </div>
  );
}
