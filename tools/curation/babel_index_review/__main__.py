"""Entry point: ``python -m babel_index_review DIR``."""

import argparse
import os
import sys

from PySide6.QtWidgets import QApplication

from babel_index_review.gui import ReviewWindow


def main() -> int:
    parser = argparse.ArgumentParser(description="Review babel-index tile stories.")
    parser.add_argument("dir", help="Tile directory (holds NNNNN.webp + metadata.json).")
    parser.add_argument(
        "--content-review",
        choices=("flagged", "unflagged"),
        default=None,
        help=(
            "Show only tiles with ('flagged') or without ('unflagged') "
            "sensitive_content_tags. A one-time display filter -- metadata.json "
            "is loaded and saved in full either way."
        ),
    )
    parser.add_argument(
        "--sample-update",
        action="store_true",
        help=(
            "Add a 'Save to samples' button that copies the selected tile and "
            "its metadata into assets/corpus-sample, for picking a representative "
            "demo corpus by hand."
        ),
    )
    args = parser.parse_args()

    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found")
        return 1

    app = QApplication(sys.argv)
    window = ReviewWindow(args.dir, content_review=args.content_review, sample_update=args.sample_update)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
