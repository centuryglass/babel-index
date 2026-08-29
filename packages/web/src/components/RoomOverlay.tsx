/**
 * One room, as large as the display allows: the tile at full size and the whole
 * story, with nothing clipped.
 *
 * The catalog's rows are a fixed height - that is what lets the spacers standing
 * in for unmounted pages be arithmetic rather than estimates, and it is the
 * property the whole sliding window rests on. So a row cannot grow to fit a long
 * story, and the thumbnail in it is a thumbnail. Neither is a reason to send a
 * reader back to the map to find out what a room says.
 *
 * Hence this: ONE affordance answering both. Pressing the tile opens it, and so
 * does the "read the rest" button a clipped story ends with - the alternative
 * was expanding the story in place, which would make row heights vary, and then
 * either the spacers become estimates or every unmounted expansion has to be
 * remembered and measured. The trade is deliberate: rows stay uniform, and the
 * full thing is one press away rather than zero.
 *
 * It is a modal dialog rather than a card placed at the pointer, because unlike
 * `RoomCard` there is no gesture location to anchor to - a row is not a point -
 * and because what it exists to show is "as big as this screen allows", which is
 * the middle of it.
 */
import { useEffect, useRef } from 'react';
import { RoomDetails } from './RoomDetails.tsx';
import type { RoomMeta } from '../../../map/metadata.ts';
import type { Description } from '../../../map/describe.ts';
import type { SearchResult, MatchRange } from '../../../map/searchResult.ts';
import type { Config } from '../../../config/config.ts';

export function RoomOverlay({
  room,
  desc,
  entry,
  file,
  src,
  onClose,
  onKeyword,
  highlight,
  tagLinks,
  result,
  weights,
}: {
  room: { id: number; rank: number };
  desc: Description;
  entry: RoomMeta | null;
  file?: string;
  src?: string | null;
  onClose: () => void;
  onKeyword: (keyword: string) => void;
  highlight?: { keyword: (text: string) => MatchRange[]; story: (text: string) => MatchRange[] } | null;
  tagLinks?: Record<string, string> | null;
  result?: SearchResult | null;
  weights?: Config['search']['weights'] | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Focus in on open and back where it came from on close - the same contract
  // `RoomCard` keeps, and for the same reason: a dialog that leaves focus behind
  // it strands a keyboard reader at the top of the document.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (!opener || opener === document.body || !opener.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !ref.current?.contains(active)) return;
      opener.focus();
    };
    // Mount and unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // A dialog over a scrolling list has to hold focus, or Tab walks into the
      // catalog behind it and the reader is editing a page they cannot see.
      if (e.key !== 'Tab') return;
      const focusable = ref.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="overlay-scrim"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="overlay" ref={ref} role="dialog" aria-modal="true" tabIndex={-1} aria-label={desc.name}>
        <div className="card-head">
          <span className="card-id">
            room {room.id}
            {file ? ` · ${file}` : ''}
          </span>
          <button className="card-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        {/*
          The tile at whatever size the viewport allows, capped so it is never
          upscaled past its own pixels - the same rule the map's opening view
          follows. `alt=""` because the room is named and described by the text
          beside it; a second account of the same image, generated here, is
          exactly what accessibility-plan.md §3.5 rules out.
        */}
        <img className="overlay-tile" src={src ?? ''} alt="" decoding="async" />

        <div className="overlay-body">
          <RoomDetails
            entry={entry}
            desc={desc}
            onKeyword={onKeyword}
            highlight={highlight}
            tagLinks={tagLinks}
            rank={room.rank}
            result={result}
            weights={weights}
          />
        </div>
      </div>
    </div>
  );
}
