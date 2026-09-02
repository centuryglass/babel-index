"""
Shared thread-pool runner for the batch curation scripts.

Every batch script (``alt_text.py``, ``sensitive_tags.py``, ``titles.py``,
``tile_process.py``'s story generation) does the same thing: for each target
tile, make one blocking model call, then fold the result into
``metadata.json``. With a remote model (``openrouter:``, a bare Claude id)
those calls are almost entirely spent waiting on the network, so running
several at once is a straightforward wall-clock win. A ``local:`` model hits
a single-model llama-server that can't usefully serve concurrent requests, so
those stay strictly serial.

``run_parallel`` is the one place that fans work out and funnels it back in:
worker threads only ever call ``worker_fn`` (the blocking model call) and
never touch ``index`` or the filesystem; the calling thread is the *only*
place ``apply_fn`` runs and ``metadata.json`` gets written, via
``core.update_index``. That split is what makes this safe to reuse across
every task in this module without each script re-deriving its own locking.
"""

from __future__ import annotations

import os
import sys
import threading
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from typing import Any, Callable, Iterable, Optional

from babel_index_review import core
from tag.describe_image import LOCAL_PREFIX

DEFAULT_WORKERS = 6


def resolve_workers(model: str, requested: int) -> int:
    """Cap concurrency at 1 for a ``local:`` model, whatever was requested."""
    if model.startswith(LOCAL_PREFIX):
        return 1
    return max(1, requested)


def run_parallel(
    tile_dir: str,
    targets: Iterable[tuple[str, dict]],
    *,
    worker_fn: Callable[[str, dict], Any],
    apply_fn: Callable[[dict, str, dict, Any], None],
    workers: int,
    on_error: Optional[Callable[[str, BaseException], None]] = None,
) -> None:
    """Run ``worker_fn`` over every target with up to ``workers`` in flight.

    ``targets`` yields ``(key, entry)`` pairs (as each script's existing
    ``_tiles_to_*`` generator already does). ``worker_fn(image_path, entry)``
    does the blocking model call and returns whatever ``apply_fn`` needs.
    ``apply_fn(index, key, entry, result)`` mutates a freshly re-read
    ``index`` in place; it runs on the calling thread only, once per
    completed tile, inside ``core.update_index`` - so it's always safe to
    write to ``index`` and never safe to do I/O of its own.

    A tile whose ``worker_fn`` raises is reported via ``on_error`` (default:
    print to stderr) and skipped - it never reaches ``apply_fn``, matching
    the existing "skip and keep going" behavior for a bad model reply.

    On KeyboardInterrupt, no new work is submitted and nothing already
    completed is lost - results already finished (or finishing while the
    pool winds down) still get applied - then the interrupt is re-raised so
    each script's existing ``except KeyboardInterrupt`` handler still prints
    its "progress saved" message.
    """
    if on_error is None:

        def on_error(key: str, err: BaseException) -> None:
            print(f"skip {key}: {err}", file=sys.stderr)

    targets = list(targets)
    if not targets:
        return

    def apply_result(key: str, entry: dict, result: Any) -> None:
        def mutate(index: dict) -> dict:
            apply_fn(index, key, entry, result)
            return index

        core.update_index(tile_dir, mutate)

    def collect(future: Future, key: str, entry: dict) -> None:
        try:
            result = future.result()
        except Exception as err:  # noqa: BLE001 - report and move on to the next tile
            on_error(key, err)
            return
        apply_result(key, entry, result)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_to_target: dict[Future, tuple[str, dict]] = {
            pool.submit(worker_fn, os.path.join(tile_dir, key), entry): (key, entry)
            for key, entry in targets
        }
        pending = set(future_to_target)
        try:
            while pending:
                done, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    key, entry = future_to_target[future]
                    collect(future, key, entry)
        except KeyboardInterrupt:
            for future in pending:
                future.cancel()
            # Drain anything that finished in the brief window before cancel.
            for future in pending:
                if future.done() and not future.cancelled():
                    key, entry = future_to_target[future]
                    collect(future, key, entry)
            raise


class SharedTitleSet:
    """A ``used_titles`` set safe for concurrent workers to claim from.

    ``titles.py``'s uniqueness rule only holds if two in-flight proposals can
    never both claim the same free title. ``contains`` is a plain read for
    building retry feedback; ``try_reserve`` is the one atomic check-and-add,
    so a worker that wins the race is the only one who ever sees success for
    that title - a loser just gets treated like a validation failure and
    asks the model to try again.
    """

    def __init__(self, seed: Iterable[str] = ()):
        self._lock = threading.Lock()
        self._titles = set(seed)

    def contains(self, title: str) -> bool:
        with self._lock:
            return title in self._titles

    def try_reserve(self, title: str) -> bool:
        with self._lock:
            if title in self._titles:
                return False
            self._titles.add(title)
            return True
