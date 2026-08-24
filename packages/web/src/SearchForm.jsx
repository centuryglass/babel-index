/**
 * The search box, in whichever of its two homes is on screen.
 *
 * On the map it is positioned imperatively over the center tile by the render
 * loop; in the catalog it sits in the pinned bar. Both are the same controlled
 * input over the same submit, because "what does Enter do" is one question and
 * two answers to it would drift the first time one of them changed.
 *
 * Deliberately takes NO style prop. The map's copy is positioned by writing to
 * `.style` from the render loop every frame, and a React re-render - which every
 * keystroke causes, since `query` is controlled - would reapply a declared style
 * and fight that positioning. The class is the only styling hook.
 */
export function SearchForm({
  query,
  setQuery,
  onSubmit,
  className,
  formRef = null,
  label = 'search the library',
  maxLength,
}) {
  return (
    <form ref={formRef} onSubmit={onSubmit} className={className} role="search">
      <input
        type="search"
        aria-label={label}
        placeholder="search the library…"
        value={query}
        // Stops typing and pasting past the cap. It is not the enforcement -
        // `search()` clamps, because a chip, a book and a restored history
        // entry all reach it without passing through this box - but it is what
        // makes the limit visible at the moment someone hits it.
        maxLength={maxLength}
        onChange={(e) => setQuery(e.target.value)}
      />
    </form>
  );
}
