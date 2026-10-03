/**
 * A `manifest.overlays` for tests: every overlay the planners draw, with
 * `assets/overlays.json`'s anchors and scales. Tests that assert where an
 * overlay lands use this, not the repo's file, which is art and free to
 * change.
 */
import type { Overlays } from '../../../map/overlays.ts';

const LEVEL0 = [{ level: 0, dir: null }];

export const TEST_OVERLAYS: Overlays = {
  'favorite-badge': {
    anchor: 'top-right', scale: 'pyramid', faces: { on: 'fav_on.png', off: 'fav_off.png' }, levels: LEVEL0,
  },
  'favorite-switch': {
    anchor: 'top-left', scale: 'tile',
    faces: { base: 'fav_center_switch_base.png', mine: 'fav_mine_on.png', count: 'fav_count_on.png' },
    levels: LEVEL0,
  },
  'distill-toggle': {
    anchor: 'bottom-right', scale: 'tile', faces: { off: 'distill_off.png', on: 'distill_on.png' }, levels: LEVEL0,
  },
  'clear-history-book': {
    anchor: 'bottom-right', scale: 'tile', faces: { black: 'clear_history_book.png' }, levels: LEVEL0,
  },
};
