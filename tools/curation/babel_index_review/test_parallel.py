"""
Data-loss regression test for ``parallel.SharedTitleSet``.

Per ``AGENTS.md``'s testing policy for this subtree, this is narrowly scoped
to the one place a bug in parallelizing curation would silently corrupt
data: two workers racing to claim the same title. Everything else in
``parallel.py`` is exercised by hand against a real corpus, not covered here.

Run directly: ``python -m babel_index_review.test_parallel`` (or via
``pytest``/``unittest``). Not wired into any CI workflow.
"""

import threading
import unittest

from babel_index_review.parallel import SharedTitleSet


class SharedTitleSetTest(unittest.TestCase):
    def test_seed_titles_are_already_claimed(self):
        shared = SharedTitleSet(["already used"])
        self.assertTrue(shared.contains("already used"))
        self.assertFalse(shared.try_reserve("already used"))

    def test_first_reserve_wins_second_fails(self):
        shared = SharedTitleSet()
        self.assertTrue(shared.try_reserve("a title"))
        self.assertFalse(shared.try_reserve("a title"))
        self.assertTrue(shared.contains("a title"))

    def test_concurrent_reservations_have_exactly_one_winner(self):
        shared = SharedTitleSet()
        results = []
        results_lock = threading.Lock()

        def claim():
            won = shared.try_reserve("contested title")
            with results_lock:
                results.append(won)

        threads = [threading.Thread(target=claim) for _ in range(50)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(results.count(True), 1)
        self.assertEqual(results.count(False), 49)

    def test_distinct_titles_dont_collide(self):
        shared = SharedTitleSet()
        winners = []
        winners_lock = threading.Lock()

        def claim(title):
            if shared.try_reserve(title):
                with winners_lock:
                    winners.append(title)

        titles = [f"title {i}" for i in range(20)]
        threads = [threading.Thread(target=claim, args=(t,)) for t in titles]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(sorted(winners), sorted(titles))


if __name__ == "__main__":
    unittest.main()
