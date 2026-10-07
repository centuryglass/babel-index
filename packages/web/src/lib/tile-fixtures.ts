/**
 * A tile shape for tests that need one and don't care which: the 4:3 art the
 * sample collection ships at. A test about shape itself builds its own with
 * `tileShapeFor`.
 */
import { tileShapeFor } from './tileShape.ts';

export const TEST_TILE = tileShapeFor({ w: 1024, h: 768 });
