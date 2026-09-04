"""
Qt story-review interface for the babel-index tiles.

Left panel: a scrolling grid of every tile in ``metadata.json``.
  - Green outline: story reviewed and finalized.
  - No outline:    story present but not reviewed.
  - Red outline:   story absent.
  - Grey "missing": the webp is gone from disk.
Clicking a tile selects it; the selected tile gets a thicker highlighted border.

Right panel: story editing for the selected tile.
  - Top    -- initial prompt. Resets to the keyword-seeded default on every
              selection. Editable (used for the next Generate call).
  - Middle -- current story. Editable; edits autosave to metadata.json.
  - Bottom -- revision request. Editable; cleared on selection.
  - Alt text -- accessibility description, editable with its own autosave and
    "Generate alt" button (uses the model dropdown, ``core.default_alt_prompt``,
    stored as "alt" on the tile's metadata entry).
  - Title -- short evocative title, editable with its own autosave, stored as
    "title" on the tile's metadata entry (see ``babel_index_review.titles``
    for the batch generator).
  - Below that -- sensitive content tag checkboxes (gore, body-horror, horror,
    death, insects/arthropods, trypophobia), stored as an optional
    "sensitive_content_tags" list on the tile's metadata entry (omitted when
    empty).

Far bottom:
  - "Final" toggle: marks/unmarks the story finalized (green). Finalizing
    advances the selection to the next un-finalized tile.
  - Generate / Revise button (state-dependent, see ``_update_action_button``).
  - "Delete": confirms, then wipes the tile from disk, grid, and metadata.

Story generation runs on a background thread so the UI stays responsive.

``ReviewWindow(tile_dir, content_review=...)`` accepts an optional one-time
display filter: "flagged" shows only tiles with a non-empty
``sensitive_content_tags``, "unflagged" shows only tiles without one. This
never touches ``metadata.json`` -- it just narrows which keys the grid and
navigation ever see; every entry stays loaded and intact on disk.
"""

from __future__ import annotations

import json
import os
import sys

from PySide6.QtCore import (
    Qt,
    QFileSystemWatcher,
    QObject,
    QPoint,
    QRect,
    QRunnable,
    QThreadPool,
    QTimer,
    Signal,
)
from PySide6.QtGui import QGuiApplication, QKeySequence, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from babel_index_review import core
from tag.describe_image import MODELS, DEFAULT_MODEL, LOCAL_PREFIX, available_models

THUMB = 128           # thumbnail edge, px
CELL = THUMB + 22     # cell footprint incl. border/margins, for column math

SENSITIVE_TAGS = core.SENSITIVE_TAGS

# Tile outline colours by state.
COLOR_FINAL = "#2ecc71"      # green: finalized
COLOR_UNREVIEWED = "#555a63"  # subtle: story present, not reviewed
COLOR_MISSING_STORY = "#e74c3c"  # red: no story
COLOR_MISSING_IMAGE = "#7f8c8d"  # grey: webp gone
COLOR_SELECTED = "#3498db"   # blue highlight ring on the selected tile


def tile_state(entry: dict, exists: bool) -> str:
    """Classify a tile for outline colouring."""
    if not exists:
        return "missing_image"
    if entry.get("final"):
        return "final"
    if entry.get("story"):
        return "unreviewed"
    return "missing_story"


_STATE_COLOR = {
    "final": COLOR_FINAL,
    "unreviewed": COLOR_UNREVIEWED,
    "missing_story": COLOR_MISSING_STORY,
    "missing_image": COLOR_MISSING_IMAGE,
}


def _print_progress(done: int, total: int, width: int = 30):
    """Overwrite one console line with a ``[####----] done/total`` bar.

    Only ``_populate_grid`` calls this -- it's the one step slow enough on a
    big tile directory (thumbnail decode per tile) to be worth feedback
    before the window ever appears on screen.
    """
    if total == 0 or not sys.stdout.isatty():
        return
    filled = width * done // total
    bar = "#" * filled + "-" * (width - filled)
    end = "\n" if done == total else ""
    print(f"\rLoading tiles [{bar}] {done}/{total}", end=end, flush=True)


# ---------------------------------------------------------------------------
# Background Claude calls
# ---------------------------------------------------------------------------
class _WorkerSignals(QObject):
    done = Signal(str, str)  # (key, text) -- key travels in the payload so the
    error = Signal(str, str)  # slot can be a bound method (queued, main thread)


class _CallWorker(QRunnable):
    """Run a blocking callable off the GUI thread, reporting via signals.

    The result signals are connected to bound methods of the (main-thread)
    window, which gives them a receiver context and so a queued connection --
    the slots run on the GUI thread. A bare lambda would have no receiver
    context and default to a DirectConnection, running the slot on this worker
    thread and crashing the moment it touched a Qt widget.
    """

    def __init__(self, key, fn, *args):
        super().__init__()
        self._key = key
        self._fn = fn
        self._args = args
        self.signals = _WorkerSignals()

    def run(self):
        try:
            self.signals.done.emit(self._key, self._fn(*self._args))
        except Exception as err:  # surfaced to the user, never crashes the thread
            self.signals.error.emit(self._key, str(err))


class _ModelLoaderSignals(QObject):
    done = Signal(object)  # emits the {label: model_id} dict


class _ModelLoader(QRunnable):
    """Fetch the model list off the GUI thread (the API query hits the network)."""

    def __init__(self, fn):
        super().__init__()
        self._fn = fn
        self.signals = _ModelLoaderSignals()

    def run(self):
        # `fn` already swallows its own errors and returns a fallback list.
        self.signals.done.emit(self._fn())


# ---------------------------------------------------------------------------
# Grid tile
# ---------------------------------------------------------------------------
class TileButton(QFrame):
    """One clickable thumbnail in the grid, coloured by review state."""

    clicked = Signal(str)   # emits the tile key
    entered = Signal(str)   # cursor entered the tile
    left = Signal(str)      # cursor left the tile

    def __init__(self, key: str, pixmap: QPixmap | None):
        super().__init__()
        self.key = key
        self._selected = False
        self._state = "missing_story"

        # Room for the 4px selected border + 4px layout margin on each side.
        self.setFixedSize(THUMB + 16, THUMB + 16)
        self.setCursor(Qt.PointingHandCursor)

        label = QLabel(self)
        label.setAlignment(Qt.AlignCenter)
        if pixmap is not None and not pixmap.isNull():
            label.setPixmap(pixmap)
        else:
            label.setText("missing")
            label.setStyleSheet("color: #bbb;")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.addWidget(label)

    def set_state(self, state: str):
        self._state = state
        self._apply_style()

    def set_selected(self, selected: bool):
        self._selected = selected
        self._apply_style()

    def _apply_style(self):
        if self._selected:
            color, width, bg = COLOR_SELECTED, 4, "rgba(52,152,219,0.18)"
        else:
            color, width, bg = _STATE_COLOR[self._state], 3, "transparent"
        self.setStyleSheet(
            f"TileButton {{ border: {width}px solid {color};"
            f" border-radius: 5px; background: {bg}; }}"
        )

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.clicked.emit(self.key)
        super().mousePressEvent(event)

    def enterEvent(self, event):
        self.entered.emit(self.key)
        super().enterEvent(event)

    def leaveEvent(self, event):
        self.left.emit(self.key)
        super().leaveEvent(event)


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------
class ReviewWindow(QMainWindow):
    def __init__(self, tile_dir: str, content_review: str | None = None):
        super().__init__()
        self.tile_dir = tile_dir
        self.content_review = content_review
        self.index = core.load_index(tile_dir)

        # A one-time display filter: which keys the grid/navigation ever see.
        # `self.index` always keeps every entry loaded from disk untouched --
        # this only narrows what's shown, never what's saved.
        all_keys = sorted(self.index)
        if content_review == "flagged":
            all_keys = [k for k in all_keys if self.index[k].get("sensitive_content_tags")]
        elif content_review == "unflagged":
            all_keys = [k for k in all_keys if not self.index[k].get("sensitive_content_tags")]
        self.keys: list[str] = all_keys
        self.tiles: dict[str, TileButton] = {}
        self.current_key: str | None = None
        self._loading = False       # suppress autosave while populating fields
        self._busy = False          # a Claude call is in flight
        self._alt_busy = False      # an alt-text call is in flight
        self._columns = 0
        self._hovered_key: str | None = None  # tile under the cursor, if any

        self.pool = QThreadPool.globalInstance()
        self._workers: set[_CallWorker] = set()  # keep workers alive until they
        # finish, so their signals object survives cross-thread delivery
        self._save_timer = QTimer(self, singleShot=True, interval=600)
        self._save_timer.timeout.connect(self._flush_story)
        self._alt_save_timer = QTimer(self, singleShot=True, interval=600)
        self._alt_save_timer.timeout.connect(self._flush_alt)
        self._title_save_timer = QTimer(self, singleShot=True, interval=600)
        self._title_save_timer.timeout.connect(self._flush_title)

        # Pick up edits another process (a batch script, or a second GUI)
        # makes to metadata.json while this window is open. Re-added on every
        # fire because some writers replace-via-rename, which drops a
        # QFileSystemWatcher's inode-based watch.
        self._metadata_path = core.index_path(tile_dir)
        self._fs_watcher = QFileSystemWatcher(self)
        if os.path.exists(self._metadata_path):
            self._fs_watcher.addPath(self._metadata_path)
        self._fs_watcher.fileChanged.connect(self._on_metadata_changed)

        self.setWindowTitle(f"babel-index review — {os.path.basename(os.path.abspath(tile_dir))}")
        self.resize(1200, 800)
        self._build_ui()
        self._build_overlay()
        self._install_shortcuts()
        self._populate_grid()
        self._refresh_models()  # replace the static list with the live one

        # Qt only reports a held modifier when some *other* event happens to
        # carry it, so key-press/release alone is unreliable (and never fires
        # while the cursor sits still over a tile). Poll the real hardware
        # modifier state instead, and react whenever Ctrl/Shift changes.
        self._last_mods = Qt.NoModifier
        self._mod_timer = QTimer(self, interval=100)
        self._mod_timer.timeout.connect(self._poll_modifiers)
        self._mod_timer.start()

        if self.keys:
            self.select_tile(self.keys[0])
        self._update_action_button()

    # -- UI construction ----------------------------------------------------
    def _build_ui(self):
        splitter = QSplitter(Qt.Horizontal)

        # Left: scrolling grid.
        self.grid_host = QWidget()
        self.grid = QGridLayout(self.grid_host)
        self.grid.setContentsMargins(8, 8, 8, 8)
        self.grid.setSpacing(6)
        self.grid.setAlignment(Qt.AlignTop | Qt.AlignLeft)

        self.scroll_area = QScrollArea()
        self.scroll_area.setWidgetResizable(True)
        self.scroll_area.setWidget(self.grid_host)
        self.scroll_area.setMinimumWidth(CELL * 2 + 40)
        splitter.addWidget(self.scroll_area)

        # Right: editor.
        splitter.addWidget(self._build_editor())
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([720, 480])

        # Wrap the splitter so a slim top bar can hold the zoom-lock toggle in
        # the upper-right corner.
        container = QWidget()
        outer = QVBoxLayout(container)
        outer.setContentsMargins(6, 4, 6, 0)
        outer.setSpacing(4)
        topbar = QHBoxLayout()
        nav_buttons = (
            ("<<", "Previous non-final tile", lambda: self._navigate_skip_final(-1)),
            ("<", "Previous tile", lambda: self._navigate(-1)),
            (">", "Next tile", lambda: self._navigate(1)),
            (">>", "Next non-final tile", lambda: self._navigate_skip_final(1)),
        )
        for label, tooltip, handler in nav_buttons:
            button = QPushButton(label)
            button.setToolTip(tooltip)
            button.setMaximumWidth(32)
            button.clicked.connect(handler)
            topbar.addWidget(button)
        topbar.addStretch(1)
        self.zoom_lock_check = QCheckBox("Zoom active tile")
        self.zoom_lock_check.setToolTip(
            "Keep the selected tile zoomed in the grid pane (same framing as "
            "holding Shift). Use the arrow keys to move between tiles."
        )
        self.zoom_lock_check.toggled.connect(self._on_zoom_lock_toggled)
        topbar.addWidget(self.zoom_lock_check)
        outer.addLayout(topbar)
        outer.addWidget(splitter)
        self.setCentralWidget(container)

    def _build_editor(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)

        self.keyword_label = QLabel()
        self.keyword_label.setWordWrap(True)
        self.keyword_label.setStyleSheet("color: #888;")
        layout.addWidget(self.keyword_label)

        layout.addWidget(QLabel("Title"))
        self.title_edit = QLineEdit()
        self.title_edit.textChanged.connect(self._on_title_changed)
        layout.addWidget(self.title_edit)

        layout.addWidget(QLabel("Initial prompt"))
        self.prompt_edit = QPlainTextEdit()
        self.prompt_edit.setMaximumHeight(150)
        self.prompt_edit.textChanged.connect(self._update_action_button)
        layout.addWidget(self.prompt_edit)

        layout.addWidget(QLabel("Story"))
        self.story_edit = QPlainTextEdit()
        self.story_edit.textChanged.connect(self._on_story_changed)
        layout.addWidget(self.story_edit, stretch=1)

        layout.addWidget(QLabel("Revision request"))
        self.revision_edit = QPlainTextEdit()
        self.revision_edit.setMaximumHeight(120)
        self.revision_edit.textChanged.connect(self._update_action_button)
        layout.addWidget(self.revision_edit)

        layout.addWidget(QLabel("Alt text"))
        alt_row = QHBoxLayout()
        self.alt_edit = QPlainTextEdit()
        self.alt_edit.setMaximumHeight(70)
        self.alt_edit.textChanged.connect(self._on_alt_changed)
        alt_row.addWidget(self.alt_edit, stretch=1)
        self.alt_generate_button = QPushButton("Generate alt")
        self.alt_generate_button.setMaximumWidth(90)
        self.alt_generate_button.clicked.connect(self._on_generate_alt)
        alt_row.addWidget(self.alt_generate_button)
        layout.addLayout(alt_row)

        sensitive_row = QHBoxLayout()
        sensitive_row.addWidget(QLabel("Sensitive content:"))
        self.sensitive_checks: dict[str, QCheckBox] = {}
        for tag in SENSITIVE_TAGS:
            check = QCheckBox(tag)
            check.toggled.connect(self._on_sensitive_toggled)
            sensitive_row.addWidget(check)
            self.sensitive_checks[tag] = check
        sensitive_row.addStretch(1)
        layout.addLayout(sensitive_row)

        sortbar = QHBoxLayout()

        self.final_check = QCheckBox("Final")
        self.final_check.toggled.connect(self._on_final_toggled)
        sortbar.addWidget(self.final_check)

        self.inpaint_check = QCheckBox("Needs inpainting")
        self.inpaint_check.toggled.connect(self._on_inpaint_toggled)
        sortbar.addWidget(self.inpaint_check)

        # Live tally of tile review states, left-aligned next to the toggle.
        self.counts_label = QLabel()
        self.counts_label.setStyleSheet("color: #888;")
        sortbar.addWidget(self.counts_label)
        sortbar.addStretch(1)
        layout.addLayout(sortbar)


        # Text-generation model selector. Opus 5 is the default; the others are
        # here for experimentation, including a free local-server option when a
        # local server is running. Populated from the static MODELS list up
        # front, then refreshed live from the API + local server (_refresh_models).
        controls = QHBoxLayout()
        controls.addWidget(QLabel("Model"))
        self.model_combo = QComboBox()
        self._set_models(MODELS)
        controls.addWidget(self.model_combo)
        controls.addStretch(1)

        self.action_button = QPushButton("Generate")
        self.action_button.clicked.connect(self._on_action)
        controls.addWidget(self.action_button)

        self.clear_button = QPushButton("Clear")
        self.clear_button.setMaximumWidth(80)
        self.clear_button.clicked.connect(self._on_clear)
        controls.addWidget(self.clear_button)

        self.delete_button = QPushButton("Delete")
        self.delete_button.setMaximumWidth(80)
        self.delete_button.clicked.connect(self._on_delete)
        controls.addWidget(self.delete_button)

        layout.addLayout(controls)
        return panel

    # -- Hover preview overlay ----------------------------------------------
    def _build_overlay(self):
        """A large tile preview shown while Ctrl/Shift is held over a tile.

        Ctrl expands the tile over the whole window; Shift limits it to the
        grid pane so the story text stays visible. The label is transparent to
        the mouse so the tile beneath keeps receiving hover events (no flicker).
        """
        self.overlay = QLabel(self)
        self.overlay.setAlignment(Qt.AlignCenter)
        self.overlay.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        self.overlay.setStyleSheet(
            "background: rgba(20,20,24,0.92); border: 2px solid #3498db;"
        )
        self.overlay.hide()
        self._overlay_key: str | None = None
        self._overlay_source: QPixmap | None = None

    def _on_tile_entered(self, key: str):
        self._hovered_key = key
        self._update_overlay()

    def _on_tile_left(self, key: str):
        if self._hovered_key == key:
            self._hovered_key = None
            self._update_overlay()

    def _on_zoom_lock_toggled(self, _checked: bool):
        self._update_overlay()

    def _install_shortcuts(self):
        """Ctrl+Left/Right step through tiles from anywhere in the window.

        A WindowContext shortcut fires no matter which child widget holds focus,
        so navigation works while the cursor is in a text box or on the model
        combo -- no focus juggling, and no clash with the plain arrow keys those
        widgets use for editing/selection.
        """
        for keys, delta in (
            (QKeySequence("Ctrl+Left"), -1),
            (QKeySequence("Ctrl+Right"), 1),
        ):
            shortcut = QShortcut(keys, self)
            shortcut.setContext(Qt.WindowShortcut)
            shortcut.activated.connect(lambda d=delta: self._navigate(d))

    def _navigate(self, delta: int):
        """Select the tile `delta` steps from the current one (wrapping)."""
        if not self.keys or self.current_key not in self.keys:
            return
        idx = (self.keys.index(self.current_key) + delta) % len(self.keys)
        self.select_tile(self.keys[idx])

    def _navigate_skip_final(self, delta: int):
        """Select the next/previous non-finalized tile (wrapping)."""
        if not self.keys or self.current_key not in self.keys:
            return
        idx = self.keys.index(self.current_key)
        for step in range(1, len(self.keys) + 1):
            key = self.keys[(idx + delta * step) % len(self.keys)]
            if not self.index[key].get("final"):
                self.select_tile(key)
                return

    def _poll_modifiers(self):
        # queryKeyboardModifiers() reads the live hardware state, unlike
        # keyboardModifiers() which only reflects the last delivered event.
        mods = QGuiApplication.queryKeyboardModifiers() & (
            Qt.ControlModifier | Qt.ShiftModifier
        )
        if mods != self._last_mods:
            self._last_mods = mods
            self._update_overlay()

    def _preview_rect(self, whole: bool) -> QRect:
        """Target rect (window coords): the full central area, or just the grid."""
        if whole:
            return self.centralWidget().geometry()
        top_left = self.scroll_area.mapTo(self, QPoint(0, 0))
        return QRect(top_left, self.scroll_area.size())

    def _update_overlay(self):
        mods = QGuiApplication.queryKeyboardModifiers()
        # Ctrl takes priority over Shift when both are held.
        whole = bool(mods & Qt.ControlModifier)
        limited = bool(mods & Qt.ShiftModifier)
        key = self._hovered_key

        # A manual Ctrl/Shift hover preview wins when present. Otherwise, if the
        # zoom-lock toggle is on, keep the active (selected) tile zoomed in the
        # grid pane -- the same framing Shift gives.
        if key is not None and (whole or limited):
            pass
        elif self.zoom_lock_check.isChecked() and self.current_key is not None:
            key, whole, limited = self.current_key, False, True
        else:
            key = None

        if key is None or not (whole or limited) or not self._exists(key):
            self.overlay.hide()
            self._overlay_key = None
            self._overlay_source = None
            return

        # Cache the full-resolution pixmap so a modifier toggle or resize does
        # not reload it from disk each time.
        if key != self._overlay_key:
            self._overlay_source = QPixmap(os.path.join(self.tile_dir, key))
            self._overlay_key = key
        if self._overlay_source is None or self._overlay_source.isNull():
            self.overlay.hide()
            return

        rect = self._preview_rect(whole)
        self.overlay.setGeometry(rect)
        self.overlay.setPixmap(
            self._overlay_source.scaled(
                rect.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation
            )
        )
        self.overlay.show()
        self.overlay.raise_()

    # -- Model selector -----------------------------------------------------
    def _set_models(self, models: dict):
        """Repopulate the model dropdown, preserving the current selection.

        Sorted alphabetically (case-insensitive) by label, except local-server
        entries (model id starts with `local:`), which always sort first.
        """
        if not models:
            return
        current = self.model_combo.currentData()
        self.model_combo.blockSignals(True)
        self.model_combo.clear()
        ordered = sorted(
            models.items(),
            key=lambda item: (not item[1].startswith(LOCAL_PREFIX), item[0].casefold()),
        )
        for label, model_id in ordered:
            self.model_combo.addItem(label, model_id)
        # Keep the prior pick if it survived the refresh, else fall back to the
        # default model, else the first entry.
        index = self.model_combo.findData(current) if current else -1
        if index < 0:
            index = self.model_combo.findData(DEFAULT_MODEL)
        self.model_combo.setCurrentIndex(max(index, 0))
        self.model_combo.blockSignals(False)

    def _refresh_models(self):
        """Kick off a background query for the live model list."""
        loader = _ModelLoader(available_models)
        loader.signals.done.connect(self._set_models)
        self.pool.start(loader)

    # -- Grid ---------------------------------------------------------------
    def _thumb(self, key: str) -> QPixmap | None:
        path = os.path.join(self.tile_dir, key)
        if not os.path.exists(path):
            return None
        pix = QPixmap(path)
        if pix.isNull():
            return None
        return pix.scaled(THUMB, THUMB, Qt.KeepAspectRatio, Qt.SmoothTransformation)

    def _populate_grid(self):
        total = len(self.keys)
        for i, key in enumerate(self.keys):
            tile = TileButton(key, self._thumb(key))
            tile.set_state(tile_state(self.index[key], self._exists(key)))
            tile.clicked.connect(self.select_tile)
            tile.entered.connect(self._on_tile_entered)
            tile.left.connect(self._on_tile_left)
            self.tiles[key] = tile
            _print_progress(i + 1, total)
        self._reflow(force=True)
        self._update_counts()

    def _reflow(self, force: bool = False):
        """Lay tiles out in as many columns as the viewport allows."""
        width = self.scroll_area.viewport().width()
        columns = max(1, (width - 16) // CELL)
        if columns == self._columns and not force:
            return
        self._columns = columns
        while self.grid.count():
            self.grid.takeAt(0)
        for i, key in enumerate(self.keys):
            self.grid.addWidget(self.tiles[key], i // columns, i % columns)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._reflow()
        overlay = getattr(self, "overlay", None)
        if overlay is not None and overlay.isVisible():
            self._update_overlay()

    def _refresh_tile(self, key: str):
        if key in self.tiles:
            self.tiles[key].set_state(tile_state(self.index[key], self._exists(key)))
        self._update_counts()

    def _update_counts(self):
        """Refresh the final/unreviewed/empty/total tally label."""
        final = unreviewed = empty = 0
        for key in self.keys:
            entry = self.index[key]
            if entry.get("final"):
                final += 1
            elif entry.get("story"):
                unreviewed += 1
            else:
                empty += 1
        self.counts_label.setText(
            f"final {final} · unreviewed {unreviewed} · "
            f"empty {empty} · total {len(self.keys)}"
        )

    def _exists(self, key: str) -> bool:
        return os.path.exists(os.path.join(self.tile_dir, key))

    # -- Selection ----------------------------------------------------------
    def select_tile(self, key: str):
        if key not in self.index:
            return
        if self.current_key == key:
            return
        self._flush_story()  # persist any pending edit on the outgoing tile
        self._flush_alt()
        self._flush_title()

        if self.current_key in self.tiles:
            self.tiles[self.current_key].set_selected(False)
        self.current_key = key
        self.tiles[key].set_selected(True)
        self._ensure_visible(key)

        entry = self.index[key]
        self._loading = True
        idx = self.keys.index(key)
        self.keyword_label.setText(
            f"#{key}  Keywords: " + ", ".join(
                f"{kw['text']} ({kw['type']})" for kw in entry.get("keywords", [])
            )
        )
        self.title_edit.setText(entry.get("title") or "")
        self.prompt_edit.setPlainText(core.default_prompt(core.keyword_texts(entry)))
        self.story_edit.setPlainText(entry.get("story") or "")
        self.revision_edit.setPlainText("")
        self.alt_edit.setPlainText(entry.get("alt") or "")
        self.final_check.setChecked(bool(entry.get("final")))
        self.inpaint_check.setChecked(bool(entry.get("needs_inpainting")))
        tags = set(entry.get("sensitive_content_tags") or [])
        for tag, check in self.sensitive_checks.items():
            check.setChecked(tag in tags)
        self._loading = False

        self._update_action_button()
        if self.zoom_lock_check.isChecked():
            self._update_overlay()  # keep the locked zoom on the new tile

    def _ensure_visible(self, key: str):
        self.scroll_area.ensureWidgetVisible(self.tiles[key])

    def _advance_to_next_unfinal(self):
        """Select the next non-finalized tile after the current one (wrapping)."""
        if not self.keys:
            return
        start = self.keys.index(self.current_key) if self.current_key in self.keys else -1
        ordered = self.keys[start + 1:] + self.keys[: start + 1]
        for key in ordered:
            if not self.index[key].get("final"):
                self.select_tile(key)
                return

    def _advance_to_next_reviewable(self):
        """Select the next tile that is neither empty nor final (wrapping)."""
        if not self.keys:
            return
        start = self.keys.index(self.current_key) if self.current_key in self.keys else -1
        ordered = self.keys[start + 1:] + self.keys[: start + 1]
        for key in ordered:
            entry = self.index[key]
            if entry.get("story") and not entry.get("final"):
                self.select_tile(key)
                return

    # -- Merge-safe persistence ----------------------------------------------
    def _save_index_entry(self, key: str, entry: dict | None) -> None:
        """Persist ``entry`` as ``key``'s metadata, merging with disk.

        Goes through ``core.update_index`` rather than a plain
        ``core.save_index(self.index)``: that re-reads metadata.json under
        lock first, so a change an external process (a batch script, or a
        second GUI) made to some OTHER tile since our last load is kept
        rather than clobbered by writing back our whole in-memory snapshot.
        Only ``key`` itself is overwritten with what's in memory here.
        ``entry=None`` deletes the key. Updates ``self.index`` to the merged
        result so it reflects whatever else was just picked up from disk.
        """
        def mutate(fresh: dict) -> dict:
            if entry is None:
                fresh.pop(key, None)
            else:
                fresh[key] = entry
            return fresh

        self.index = core.update_index(self.tile_dir, mutate)

    # -- External changes (another process editing metadata.json) -----------
    def _on_metadata_changed(self, _path: str):
        if self._metadata_path not in self._fs_watcher.files() and os.path.exists(
            self._metadata_path
        ):
            self._fs_watcher.addPath(self._metadata_path)  # re-add after replace-via-rename

        # A malformed read means we caught the file mid-write (or it's genuinely
        # corrupt); either way an empty {} here would reconcile as "every tile
        # removed" and tear the whole grid down. Skip this event and wait for
        # the next fire once the writer has finished rather than acting on it.
        try:
            fresh = core.load_index(self.tile_dir, strict=True)
        except json.JSONDecodeError:
            return

        # The tile mid-edit keeps its in-memory value authoritative -- its
        # pending autosave (debounced up to 600ms) hasn't reached disk yet,
        # and overwriting it here would lose keystrokes. It gets folded into
        # the merge the next time anything on it saves.
        if self.current_key is not None and self.current_key in self.index:
            fresh[self.current_key] = self.index[self.current_key]

        added = [key for key in fresh if key not in self.index]
        removed = [key for key in self.index if key not in fresh]
        changed = [
            key for key in fresh
            if key != self.current_key and key in self.index and fresh[key] != self.index[key]
        ]
        if not added and not removed and not changed:
            self.index = fresh
            return

        self.index = fresh
        filtered_out = set()
        if self.content_review == "flagged":
            filtered_out = {k for k in added if not (fresh[k] or {}).get("sensitive_content_tags")}
        elif self.content_review == "unflagged":
            filtered_out = {k for k in added if (fresh[k] or {}).get("sensitive_content_tags")}

        for key in removed:
            if key == self.current_key:
                continue  # don't rip the open tile out from under the editor
            self._remove_tile(key)
        for key in added:
            if key in filtered_out:
                continue
            self._add_tile(key)
        if added or removed:
            self.keys.sort()
            self._reflow(force=True)
        for key in changed:
            self._refresh_tile(key)
        self._update_counts()

    def _add_tile(self, key: str):
        if key in self.tiles:
            return
        self.keys.append(key)
        tile = TileButton(key, self._thumb(key))
        tile.set_state(tile_state(self.index[key], self._exists(key)))
        tile.clicked.connect(self.select_tile)
        tile.entered.connect(self._on_tile_entered)
        tile.left.connect(self._on_tile_left)
        self.tiles[key] = tile

    def _remove_tile(self, key: str):
        tile = self.tiles.pop(key, None)
        if tile is not None:
            tile.setParent(None)
            tile.deleteLater()
        if key in self.keys:
            self.keys.remove(key)

    # -- Story autosave -----------------------------------------------------
    def _on_story_changed(self):
        if not self._loading:
            self._save_timer.start()
            self._update_action_button()

    def _flush_story(self):
        self._save_timer.stop()
        if self.current_key is None:
            return
        entry = self.index[self.current_key]
        text = self.story_edit.toPlainText()
        stored = entry.get("story") or ""
        if text != stored:
            entry["story"] = text or None
            self._save_index_entry(self.current_key, entry)
            self._refresh_tile(self.current_key)

    # -- Title autosave -------------------------------------------------------
    def _on_title_changed(self):
        if not self._loading:
            self._title_save_timer.start()

    def _flush_title(self):
        self._title_save_timer.stop()
        if self.current_key is None:
            return
        entry = self.index[self.current_key]
        text = self.title_edit.text().strip()
        stored = entry.get("title") or ""
        if text != stored:
            entry["title"] = text or None
            self._save_index_entry(self.current_key, entry)

    # -- Alt text autosave / generation --------------------------------------
    def _on_alt_changed(self):
        if not self._loading:
            self._alt_save_timer.start()

    def _flush_alt(self):
        self._alt_save_timer.stop()
        if self.current_key is None:
            return
        entry = self.index[self.current_key]
        text = self.alt_edit.toPlainText()
        stored = entry.get("alt") or ""
        if text != stored:
            entry["alt"] = text or None
            self._save_index_entry(self.current_key, entry)

    def _on_generate_alt(self):
        if self.current_key is None or self._alt_busy:
            return
        key = self.current_key
        webp_path = os.path.join(self.tile_dir, key)
        if not os.path.exists(webp_path):
            QMessageBox.warning(self, "Missing image", f"{key} is not on disk.")
            return

        entry = self.index[key]
        prompt = core.default_alt_prompt(core.keyword_texts(entry))
        model = self.model_combo.currentData()

        worker = _CallWorker(key, core.generate_alt_text, webp_path, prompt, model)
        worker.setAutoDelete(False)
        self._workers.add(worker)
        worker.signals.done.connect(self._on_generate_alt_done)
        worker.signals.error.connect(self._on_generate_alt_error)
        self._alt_busy = True
        self.alt_generate_button.setEnabled(False)
        self.alt_generate_button.setText("Working…")
        self.pool.start(worker)

    def _on_generate_alt_done(self, key: str, text: str):
        self._retire_worker()
        self._alt_busy = False
        self.alt_generate_button.setEnabled(True)
        self.alt_generate_button.setText("Generate alt")
        entry = self.index[key]
        entry["alt"] = text.strip()
        self._save_index_entry(key, entry)
        if self.current_key == key:
            self._loading = True
            self.alt_edit.setPlainText(text.strip())
            self._loading = False

    def _on_generate_alt_error(self, key: str, message: str):
        self._retire_worker()
        self._alt_busy = False
        self.alt_generate_button.setEnabled(True)
        self.alt_generate_button.setText("Generate alt")
        QMessageBox.critical(self, "Alt text generation failed", message)

    # -- Final toggle -------------------------------------------------------
    def _on_final_toggled(self, checked: bool):
        if self._loading or self.current_key is None:
            return
        entry = self.index[self.current_key]
        entry["final"] = checked
        self._save_index_entry(self.current_key, entry)
        self._refresh_tile(self.current_key)
        self._update_action_button()
        if checked:
            self._advance_to_next_unfinal()

    # -- Needs-inpainting toggle --------------------------------------------
    def _on_inpaint_toggled(self, checked: bool):
        if self._loading or self.current_key is None:
            return
        entry = self.index[self.current_key]
        if checked:
            entry["needs_inpainting"] = True
        else:
            entry.pop("needs_inpainting", None)
        self._save_index_entry(self.current_key, entry)

    # -- Sensitive content tags ----------------------------------------------
    def _on_sensitive_toggled(self, _checked: bool):
        if self._loading or self.current_key is None:
            return
        entry = self.index[self.current_key]
        tags = [tag for tag, check in self.sensitive_checks.items() if check.isChecked()]
        if tags:
            entry["sensitive_content_tags"] = tags
        else:
            entry.pop("sensitive_content_tags", None)
        self._save_index_entry(self.current_key, entry)

    # -- Generate / Revise --------------------------------------------------
    def _update_action_button(self):
        """Set the action button's label and enabled state per the spec."""
        if self.current_key is None:
            self.action_button.setEnabled(False)
            self.clear_button.setEnabled(False)
            return

        story = self.story_edit.toPlainText().strip()
        prompt = self.prompt_edit.toPlainText().strip()
        revision = self.revision_edit.toPlainText().strip()
        is_final = self.final_check.isChecked()

        self.clear_button.setEnabled(not is_final)

        if not story:
            self.action_button.setText("Generate")
            enabled = bool(prompt)
        else:
            self.action_button.setText("Revise")
            enabled = bool(revision)

        self.action_button.setEnabled(enabled and not is_final and not self._busy)

    def _on_action(self):
        if self.current_key is None or self._busy:
            return
        key = self.current_key
        webp_path = os.path.join(self.tile_dir, key)
        if not os.path.exists(webp_path):
            QMessageBox.warning(self, "Missing image", f"{key} is not on disk.")
            return

        prompt = self.prompt_edit.toPlainText()
        story = self.story_edit.toPlainText().strip()
        model = self.model_combo.currentData()

        if not story:
            worker = _CallWorker(key, core.generate_story, webp_path, prompt, model)
        else:
            revision = self.revision_edit.toPlainText()
            worker = _CallWorker(
                key, core.revise_story, webp_path, prompt, story, revision, model
            )

        worker.setAutoDelete(False)
        self._workers.add(worker)
        worker.signals.done.connect(self._on_action_done)
        worker.signals.error.connect(self._on_action_error)
        self._set_busy(True)
        self.pool.start(worker)

    def _retire_worker(self):
        """Drop the just-finished worker so it (and its signals) can be freed."""
        signals = self.sender()
        for worker in list(self._workers):
            if worker.signals is signals:
                self._workers.discard(worker)
                break

    def _on_action_done(self, key: str, text: str):
        self._retire_worker()
        self._set_busy(False)
        # The user may have navigated away while Claude was working; write the
        # story back to the tile it was requested for, and only touch the
        # editor if that tile is still selected.
        entry = self.index[key]
        entry["story"] = text
        self._save_index_entry(key, entry)
        self._refresh_tile(key)
        if self.current_key == key:
            self._loading = True
            self.story_edit.setPlainText(text)
            self.revision_edit.setPlainText("")
            self._loading = False
            self._update_action_button()

    def _on_action_error(self, key: str, message: str):
        self._retire_worker()
        self._set_busy(False)
        QMessageBox.critical(self, "Story generation failed", message)

    def _set_busy(self, busy: bool):
        self._busy = busy
        if busy:
            self.action_button.setEnabled(False)
            self.action_button.setText("Working…")
        else:
            self._update_action_button()  # restores the Generate/Revise label

    # -- Clear --------------------------------------------------------------
    def _on_clear(self):
        """Wipe the current story and jump to the next reviewable tile.

        No confirmation (the button is disabled for finalized tiles, so an
        approved story is never at risk).
        """
        if self.current_key is None:
            return
        entry = self.index[self.current_key]
        if entry.get("final"):
            return
        self._save_timer.stop()
        entry["story"] = None
        self._save_index_entry(self.current_key, entry)
        self._loading = True
        self.story_edit.setPlainText("")
        self._loading = False
        self._refresh_tile(self.current_key)
        self._update_action_button()
        self._advance_to_next_reviewable()

    # -- Delete -------------------------------------------------------------
    def _on_delete(self):
        if self.current_key is None:
            return
        key = self.current_key
        reply = QMessageBox.question(
            self,
            "Delete tile",
            f"Delete {key} from disk and metadata? This cannot be undone.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if reply != QMessageBox.Yes:
            return

        path = os.path.join(self.tile_dir, key)
        if os.path.exists(path):
            os.remove(path)
        self._save_index_entry(key, None)

        tile = self.tiles.pop(key)
        tile.setParent(None)
        tile.deleteLater()
        pos = self.keys.index(key)
        self.keys.remove(key)
        self.current_key = None
        self._reflow(force=True)
        self._update_counts()

        if self.keys:
            self.select_tile(self.keys[min(pos, len(self.keys) - 1)])
        else:
            self._update_action_button()

    # -- Shutdown -----------------------------------------------------------
    def closeEvent(self, event):
        self._mod_timer.stop()
        self._flush_story()
        self._flush_alt()
        self._flush_title()
        super().closeEvent(event)
