/**
 * External links for keyword chips - "what is this, actually" for a reader who
 * doesn't already know what "Frutiger Aero" or "Concrete art" means.
 *
 * A prototype: `tagLinks.json` is a flat keyword -> url map, hand-edited for
 * now (this file's export is the only thing that reads it). It currently
 * ships pre-filled with Google search links for every keyword in
 * `assets/corpus-sample`, generated so the UI has something to point at
 * before better sources (usually Wikipedia) are picked by hand. Once this
 * proves worth keeping, it can grow into something the corpus tooling
 * populates and uploads alongside the rest of a corpus - not wired up yet on
 * purpose (see AGENTS.md).
 */
import tagLinks from './tagLinks.json' with { type: 'json' };

const links: Record<string, string> = tagLinks;

/** The external link for a keyword's exact text, or null if none is recorded. */
export function tagLink(text: string): string | null {
  return links[text] ?? null;
}
