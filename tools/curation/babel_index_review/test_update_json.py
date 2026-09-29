"""
Data-loss regression test for ``core.update_json``.

Per ``AGENTS.md``'s testing policy for this subtree, this covers only the
race that would silently drop a write: several writers merging into the same
file at once, as parallel keyword explanations (``tag_explainer.record``) or
a batch script beside the GUI do.

Run directly: ``python -m babel_index_review.test_update_json`` (or via
``pytest``/``unittest``). Not wired into any CI workflow.
"""

import os
import tempfile
import threading
import unittest

from babel_index_review import core, tag_explainer


class UpdateJsonTest(unittest.TestCase):
    def test_concurrent_writers_all_land(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "data.json")
            barrier = threading.Barrier(16)

            def write(n: int):
                barrier.wait()
                for i in range(10):
                    core.update_json(path, lambda data, k=f"{n}-{i}": {**data, k: True})

            threads = [threading.Thread(target=write, args=(n,)) for n in range(16)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(len(core.load_json(path, strict=True)), 160)

    def test_record_keeps_other_models_explanations(self):
        with tempfile.TemporaryDirectory() as tmp:
            tag_explainer.record(tmp, "Funk art", "model-a", "first")
            tag_explainer.record(tmp, "Funk art", "model-b", "second")
            tag_explainer.record(tmp, "Funk art", "model-a", "replaced")
            store = tag_explainer.load(tmp, strict=True)
            self.assertEqual(store["Funk art"]["model-a"]["text"], "replaced")
            self.assertEqual(store["Funk art"]["model-b"]["text"], "second")


if __name__ == "__main__":
    unittest.main()
