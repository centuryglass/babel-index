"""
Qt story-review interface for the babel-index tiles.

Three columns, laid out for a 1920x1080 window:

- **Tiles** (left): a sortable table of every tile in ``metadata.json``
  (thumbnail, name, title, keywords, status), with a text filter and a
  status filter.
- **Tile** (middle): the selected image, then the tile's own fields: title,
  Final, keywords, the story, and collapsible Alt text and Sensitive content
  sections. The title's Generate button runs ``titles.propose_title``.
  Holding Ctrl over the image zooms it to the whole window.
  Each keyword is a chip: hovering shows a model's explanation of it
  (``tag_explainer``), clicking opens every stored explanation with a button
  to ask for another, and right-clicking offers the pitch and draft models.
- **Story engine** (right): the tile's workspace (``story_engine.workspace``):
  the reading, a Pitches tab and a Drafts tab. It follows the current
  workflow in ``docs/story_workflow.md``.

Every text field autosaves. Tile fields go to ``metadata.json`` through
``core.update_index``; the reading, pitches and drafts go to the tile's
workspace file. Model calls run on a thread pool, several at once (pitching,
drafting and revising on different drafts all overlap), and each result is
applied on the GUI thread to whichever tile it was made for.

The chosen draft and the story are one text: editing either edits both. A
Final tile is locked against choosing, revising, clearing and editing the
story; the rest of the engine panel stays usable.

``ReviewWindow(tile_dir, content_review=...)`` accepts an optional one-time
display filter: "flagged" shows only tiles with a non-empty
``sensitive_content_tags``, "unflagged" only tiles without one. It narrows
which keys the table ever sees; every entry stays loaded and intact on disk.
``sample_update=True`` adds a "Save to samples" button
(``core.add_to_tile_collection_sample``).
"""

from __future__ import annotations

import copy
import html
import itertools
import json
import os
from typing import Callable, cast

from PySide6.QtCore import (
    QFileSystemWatcher,
    QItemSelectionModel,
    QMetaObject,
    QObject,
    QRunnable,
    QSettings,
    Qt,
    QThreadPool,
    QTimer,
    Signal,
)
from PySide6.QtGui import QGuiApplication, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QComboBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSlider,
    QSpinBox,
    QSplitter,
    QTableView,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from babel_index_review import core, story_frame, tag_explainer, titles
from babel_index_review.review_widgets import (
    COLOR_MUTED,
    THUMB_SIZE,
    CollapsibleSection,
    DraftCard,
    DraftChips,
    GrowingTextEdit,
    HistoryDialog,
    ImagePanel,
    KeywordChips,
    PitchRow,
    TagExplainPanel,
    TileFilterProxy,
    TileTableModel,
    set_text_quietly,
)
from story_engine import DraftEntry, PitchEntry, Reading, Workspace
from story_engine.workspace import new_id, now
from tag.describe_image import DEFAULT_MODEL, LOCAL_PREFIX, MODELS, available_models

SENSITIVE_TAGS = core.SENSITIVE_TAGS
SETTINGS = ("babel-index", "story-review")
MAX_PARALLEL_CALLS = 16


# ---------------------------------------------------------------------------
# Background model calls
# ---------------------------------------------------------------------------
class _CallSignals(QObject):
    done = Signal(int, object)  # (token, result)
    error = Signal(int, str)  # (token, message)


class _CallWorker(QRunnable):
    """Run a blocking callable off the GUI thread, reporting via signals.

    The signals are connected to bound methods of the (main-thread) window,
    which gives them a receiver context and so a queued connection: the slots
    run on the GUI thread. A bare lambda would have no receiver context and
    default to a DirectConnection, running the slot on this worker thread and
    crashing the moment it touched a Qt widget.
    """

    def __init__(self, token: int, fn: Callable[[], object]):
        super().__init__()
        self._token = token
        self._fn = fn
        self.signals = _CallSignals()

    def run(self):
        try:
            self.signals.done.emit(self._token, self._fn())
        except Exception as err:  # surfaced to the user, never crashes the thread
            self.signals.error.emit(self._token, str(err))


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


def _discard(widget: QWidget) -> None:
    """Take a widget off screen now; ``deleteLater`` alone leaves it drawn until the event loop turns."""
    widget.hide()
    widget.setParent(None)
    widget.deleteLater()


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------
class ReviewWindow(QMainWindow):
    _MIN_FONT_POINT_SIZE = 6

    def __init__(self, tile_dir: str, content_review: str | None = None, sample_update: bool = False):
        super().__init__()
        # The size the app launched with, so Ctrl+0 always lands back on it
        # rather than on some rounded intermediate from repeated scaling.
        self._base_font_point_size = cast(QApplication, QApplication.instance()).font().pointSize()
        self.tile_dir = tile_dir
        self.content_review = content_review
        self.sample_update = sample_update
        self.index = core.load_index(tile_dir)
        self.settings = QSettings(*SETTINGS)

        # A one-time display filter: which keys the table/navigation ever see.
        # `self.index` always keeps every entry loaded from disk untouched --
        # this only narrows what's shown, never what's saved.
        keys = sorted(self.index)
        if content_review == "flagged":
            keys = [k for k in keys if self.index[k].get("sensitive_content_tags")]
        elif content_review == "unflagged":
            keys = [k for k in keys if not self.index[k].get("sensitive_content_tags")]
        self.current_key: str | None = None
        self._loading = False  # suppress autosave while populating fields

        # A missing data/ list (launched from outside tools/curation) disables
        # the engine panel rather than the whole GUI.
        try:
            self.story_engine = story_frame.build_engine(tile_dir)
            self.store = story_frame.build_store(tile_dir)
            self._engine_error = ""
        except (OSError, ValueError, KeyError) as err:
            self.story_engine = None
            self.store = None
            self._engine_error = f"Story engine unavailable: {err}"

        # Per-subject engine state. Workspaces are cached once loaded; the
        # pending maps are what the panels show as in flight.
        self._workspaces: dict[str, Workspace] = {}
        self._hidden: dict[str, set[str]] = {}  # draft ids hidden by the chips
        self._pitching: dict[str, int] = {}  # subject -> pitches requested
        self._reading_busy: set[str] = set()
        self._writing: dict[str, list[str | None]] = {}  # subject -> pitch ids being drafted
        self._revising: dict[str, dict[str, str]] = {}  # subject -> {draft id: request}
        self._hand_edited: set[str] = set()  # drafts whose pre-edit text is already in history
        self._pitch_rows: dict[str, PitchRow] = {}
        self._draft_cards: dict[str, DraftCard] = {}
        self._unsent_requests: dict[str, str] = {}  # draft id -> request text, across tile switches
        self._titling: set[str] = set()  # keys with a title generation in flight
        self.tag_notes = tag_explainer.load(tile_dir)
        self._explaining: set[tuple[str, str]] = set()  # (keyword, model id) in flight
        self._open_keyword: str | None = None
        self._model_setting_connections: dict[str, QMetaObject.Connection] = {}

        # Model calls. Network-bound, so many run at once; a single-model
        # local server can't serve concurrent requests, so its calls queue.
        self.pool = QThreadPool(self)
        self.pool.setMaxThreadCount(MAX_PARALLEL_CALLS)
        self.local_pool = QThreadPool(self)
        self.local_pool.setMaxThreadCount(1)
        self._tokens = itertools.count()
        self._calls: dict[int, tuple[_CallWorker, Callable, Callable]] = {}
        self._loaders: set[_ModelLoader] = set()

        self._save_timer = QTimer(self, singleShot=True, interval=600)
        self._save_timer.timeout.connect(self._flush_story)
        self._alt_save_timer = QTimer(self, singleShot=True, interval=600)
        self._alt_save_timer.timeout.connect(self._flush_alt)
        self._title_save_timer = QTimer(self, singleShot=True, interval=600)
        self._title_save_timer.timeout.connect(self._flush_title)
        self._workspace_save_timer = QTimer(self, singleShot=True, interval=600)
        self._workspace_save_timer.timeout.connect(self._flush_workspace)
        self._dirty_subject: str | None = None

        # Pick up edits another process (a batch script, or a second GUI)
        # makes to metadata.json while this window is open. Re-added on every
        # fire because some writers replace-via-rename, which drops a
        # QFileSystemWatcher's inode-based watch.
        self._metadata_path = core.index_path(tile_dir)
        self._fs_watcher = QFileSystemWatcher(self)
        if os.path.exists(self._metadata_path):
            self._fs_watcher.addPath(self._metadata_path)
        self._fs_watcher.fileChanged.connect(self._on_watched_file_changed)
        # The explanations file may not exist yet, or a second GUI may create
        # it, so the directory is watched too and the file added once it appears.
        self._tag_notes_path = tag_explainer.descriptions_path(tile_dir)
        self._fs_watcher.addPath(tile_dir)
        self._fs_watcher.directoryChanged.connect(self._on_tile_dir_changed)
        self._watch_tag_notes()

        self.setWindowTitle(f"babel-index review: {os.path.basename(os.path.abspath(tile_dir))}")
        self.resize(1920, 1040)
        self.model = TileTableModel(tile_dir, keys, lambda key: self.index[key], self)
        self._build_ui()
        self._build_overlay()
        self._install_shortcuts()
        self._set_models(MODELS)
        self._refresh_models()
        self._update_counts()

        # Qt only reports a held modifier when some other event happens to
        # carry it, so key-press/release alone is unreliable (and never fires
        # while the cursor sits still). Poll the real hardware modifier state
        # instead, and react whenever Ctrl changes.
        self._image_hovered = False
        self._ctrl_held = False
        self._mod_timer = QTimer(self, interval=100)
        self._mod_timer.timeout.connect(self._poll_modifiers)
        self._mod_timer.start()

        first = self._visible_keys()
        if first:
            self.select_tile(first[0])

    # -- UI construction ----------------------------------------------------
    def _build_ui(self):
        columns = QSplitter(Qt.Orientation.Horizontal)
        columns.addWidget(self._build_tile_list())
        self.middle = QSplitter(Qt.Orientation.Vertical)
        self.image_panel = ImagePanel()
        self.image_panel.entered.connect(lambda: self._set_image_hover(True))
        self.image_panel.left.connect(lambda: self._set_image_hover(False))
        self.middle.addWidget(self.image_panel)
        self.middle.addWidget(self._build_tile_editor())
        self.middle.setSizes([624, 400])
        self.middle.setStretchFactor(0, 3)
        self.middle.setStretchFactor(1, 2)
        columns.addWidget(self.middle)
        columns.addWidget(self._build_engine_panel())
        columns.setSizes([380, 832, 708])
        columns.setStretchFactor(0, 0)
        columns.setStretchFactor(1, 1)
        columns.setStretchFactor(2, 1)
        self.setCentralWidget(columns)

        self.counts_label = QLabel()
        self.trace_label = QLabel()
        self.trace_label.setStyleSheet(f"color: {COLOR_MUTED};")
        self.statusBar().addWidget(self.counts_label)
        self.statusBar().addPermanentWidget(self.trace_label)

    def _build_tile_list(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(4, 4, 0, 0)
        filters = QHBoxLayout()
        self.filter_edit = QLineEdit()
        self.filter_edit.setPlaceholderText("Filter by name, title, keyword")
        self.filter_edit.setClearButtonEnabled(True)
        filters.addWidget(self.filter_edit, stretch=1)
        self.status_combo = QComboBox()
        for label, status in (
            ("All", "all"), ("Not final", "notfinal"), ("Story, not final", "unreviewed"), ("No story", "nostory"),
        ):
            self.status_combo.addItem(label, status)
        filters.addWidget(self.status_combo)
        layout.addLayout(filters)

        self.proxy = TileFilterProxy(self)
        self.proxy.setSourceModel(self.model)
        self.filter_edit.textChanged.connect(self.proxy.set_text)
        self.status_combo.currentIndexChanged.connect(
            lambda _i: self.proxy.set_status(self.status_combo.currentData())
        )
        self.table = QTableView()
        self.table.setModel(self.proxy)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setSortingEnabled(True)
        self.table.sortByColumn(0, Qt.SortOrder.AscendingOrder)
        self.table.setIconSize(THUMB_SIZE)
        self.table.setWordWrap(False)
        self.table.verticalHeader().hide()
        self.table.verticalHeader().setDefaultSectionSize(THUMB_SIZE.height() + 6)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        header.resizeSection(0, 140)
        header.resizeSection(1, 120)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Fixed)
        header.resizeSection(3, 28)
        self.table.selectionModel().currentRowChanged.connect(self._on_table_row_changed)
        layout.addWidget(self.table, stretch=1)
        return panel

    def _build_tile_editor(self) -> QWidget:
        body = QWidget()
        layout = QVBoxLayout(body)
        layout.setContentsMargins(8, 6, 8, 6)

        header = QHBoxLayout()
        for label, tooltip, handler in (
            ("<<", "Previous non-final tile", lambda: self._navigate_skip_final(-1)),
            ("<", "Previous tile (Ctrl+Left)", lambda: self._navigate(-1)),
            (">", "Next tile (Ctrl+Right)", lambda: self._navigate(1)),
            (">>", "Next non-final tile", lambda: self._navigate_skip_final(1)),
        ):
            button = QToolButton()
            button.setText(label)
            button.setToolTip(tooltip)
            button.clicked.connect(handler)
            header.addWidget(button)
        self.name_label = QLabel()
        self.name_label.setStyleSheet("font-family: monospace; font-weight: bold;")
        header.addWidget(self.name_label)
        header.addWidget(QLabel("Title"))
        self.title_edit = QLineEdit()
        self.title_edit.setPlaceholderText("(untitled)")
        self.title_edit.textChanged.connect(self._on_title_changed)
        header.addWidget(self.title_edit, stretch=1)
        self.title_generate_button = QPushButton("Generate")
        self.title_generate_button.setToolTip("Propose a title from the image and story (titles.py's rules)")
        self.title_generate_button.clicked.connect(self._on_generate_title)
        header.addWidget(self.title_generate_button)
        self.title_model_combo = QComboBox()
        header.addWidget(self.title_model_combo)
        self.final_button = QPushButton("Mark final")
        self.final_button.setCheckable(True)
        self.final_button.toggled.connect(self._on_final_toggled)
        header.addWidget(self.final_button)
        layout.addLayout(header)

        keyword_row = QHBoxLayout()
        keywords_title = QLabel("Keywords")
        keywords_title.setStyleSheet(f"color: {COLOR_MUTED};")
        keyword_row.addWidget(keywords_title)
        self.keyword_chips = KeywordChips(self._keyword_tooltip)
        self.keyword_chips.clicked.connect(self._on_keyword_clicked)
        self.keyword_chips.menu_requested.connect(self._on_keyword_menu)
        keyword_row.addWidget(self.keyword_chips)
        keyword_row.addStretch(1)
        layout.addLayout(keyword_row)
        self.tag_panel = TagExplainPanel()
        self.tag_panel.explain_requested.connect(self._on_explain_requested)
        self.tag_panel.closed.connect(lambda: self._open_tag_panel(None))
        self.tag_panel.hide()
        layout.addWidget(self.tag_panel)

        story_header = QHBoxLayout()
        story_title = QLabel("Story")
        story_title.setStyleSheet("font-weight: bold;")
        story_header.addWidget(story_title)
        self.provenance_label = QLabel()
        self.provenance_label.setStyleSheet(f"color: {COLOR_MUTED};")
        story_header.addWidget(self.provenance_label)
        story_header.addStretch(1)
        self.clear_button = QPushButton("Clear")
        self.clear_button.clicked.connect(self._on_clear)
        story_header.addWidget(self.clear_button)
        layout.addLayout(story_header)

        self.story_edit = QPlainTextEdit()
        self.story_edit.setMinimumHeight(150)
        self.story_edit.textChanged.connect(self._on_story_changed)
        layout.addWidget(self.story_edit, stretch=1)

        alt_body = QWidget()
        alt_layout = QVBoxLayout(alt_body)
        alt_layout.setContentsMargins(0, 0, 0, 0)
        self.alt_edit = QPlainTextEdit()
        self.alt_edit.setMinimumHeight(90)
        self.alt_edit.textChanged.connect(self._on_alt_changed)
        alt_layout.addWidget(self.alt_edit)
        alt_row = QHBoxLayout()
        self.alt_generate_button = QPushButton("Generate alt")
        self.alt_generate_button.clicked.connect(self._on_generate_alt)
        alt_row.addWidget(self.alt_generate_button)
        self.alt_model_combo = QComboBox()
        alt_row.addWidget(self.alt_model_combo)
        alt_row.addStretch(1)
        alt_layout.addLayout(alt_row)
        self.alt_section = CollapsibleSection("Alt text", alt_body)
        layout.addWidget(self.alt_section)

        tags_body = QWidget()
        tags_grid = QGridLayout(tags_body)
        tags_grid.setContentsMargins(16, 0, 0, 0)
        self.sensitive_checks: dict[str, QCheckBox] = {}
        for i, tag in enumerate(SENSITIVE_TAGS):
            check = QCheckBox(tag)
            check.toggled.connect(self._on_sensitive_toggled)
            tags_grid.addWidget(check, i // 3, i % 3)
            self.sensitive_checks[tag] = check
        self.tags_section = CollapsibleSection("Sensitive content", tags_body)
        layout.addWidget(self.tags_section)

        footer = QHBoxLayout()
        self.inpaint_check = QCheckBox("Needs inpainting")
        self.inpaint_check.toggled.connect(self._on_inpaint_toggled)
        footer.addWidget(self.inpaint_check)
        footer.addStretch(1)
        if self.sample_update:
            sample_button = QPushButton("Save to samples")
            sample_button.setToolTip("Copy this tile and its keywords/story/title/alt into assets/tile-collection-sample.")
            sample_button.clicked.connect(self._on_save_to_sample)
            footer.addWidget(sample_button)
        delete_button = QPushButton("Delete tile")
        delete_button.clicked.connect(self._on_delete)
        footer.addWidget(delete_button)
        layout.addLayout(footer)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setWidget(body)
        return scroll

    def _build_engine_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 4, 4, 0)
        if self.story_engine is None:
            message = QLabel(self._engine_error)
            message.setWordWrap(True)
            layout.addWidget(message)
            layout.addStretch(1)
            self.engine_body = None
            return panel

        top = QHBoxLayout()
        self.engine_counts = QLabel()
        self.engine_counts.setStyleSheet(f"color: {COLOR_MUTED};")
        top.addWidget(self.engine_counts)
        top.addStretch(1)
        self.settings_button = QToolButton()
        self.settings_button.setText("Engine settings")
        self.settings_button.setCheckable(True)
        top.addWidget(self.settings_button)
        self.pitch_button = QPushButton("Pitch more")
        self.pitch_button.clicked.connect(self._on_pitch_more)
        top.addWidget(self.pitch_button)
        self.pitch_count = QSpinBox()
        self.pitch_count.setRange(1, 12)
        self.pitch_count.setValue(self.story_engine.frame.pitch_count)
        self.pitch_count.setToolTip("How many pitches to add")
        top.addWidget(self.pitch_count)
        layout.addLayout(top)

        self.settings_frame = QFrame()
        self.settings_frame.setFrameShape(QFrame.Shape.StyledPanel)
        grid = QGridLayout(self.settings_frame)
        self.pitch_model_combo = QComboBox()
        self.draft_model_combo = QComboBox()
        self.revise_model_combo = QComboBox()
        self.form_combo = QComboBox()
        self.form_combo.addItem("Drawn by weight", None)
        for option in self.story_engine.frame.forms.options:
            self.form_combo.addItem(option.name, option.name)
        self.chance_slider = QSlider(Qt.Orientation.Horizontal)
        self.chance_slider.setRange(0, 100)
        self.chance_slider.setSingleStep(5)
        self.chance_slider.setPageStep(25)
        self.chance_label = QLabel()
        self.chance_slider.valueChanged.connect(lambda v: self.chance_label.setText(f"{v}%"))
        self.chance_slider.setValue(round(self.story_engine.frame.constraint_chance * 100))
        chance_row = QHBoxLayout()
        chance_row.addWidget(self.chance_slider, stretch=1)
        chance_row.addWidget(self.chance_label)
        self.instructions_edit = QLineEdit()
        self.instructions_edit.setPlaceholderText("Extra rules or ideas for the next pitch call (optional)")
        grid.addWidget(QLabel("Pitch model"), 0, 0)
        grid.addWidget(self.pitch_model_combo, 0, 1)
        grid.addWidget(QLabel("Draft model"), 0, 2)
        grid.addWidget(self.draft_model_combo, 0, 3)
        grid.addWidget(QLabel("Revise model"), 1, 0)
        grid.addWidget(self.revise_model_combo, 1, 1)
        grid.addWidget(QLabel("Form"), 1, 2)
        grid.addWidget(self.form_combo, 1, 3)
        grid.addWidget(QLabel("Constraint chance"), 2, 0)
        grid.addLayout(chance_row, 2, 1)
        grid.addWidget(QLabel("Pitch instructions"), 2, 2)
        grid.addWidget(self.instructions_edit, 2, 3)
        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(3, 1)
        self.settings_frame.hide()
        self.settings_button.toggled.connect(self.settings_frame.setVisible)
        layout.addWidget(self.settings_frame)

        reading_header = QHBoxLayout()
        self.reading_toggle = QToolButton()
        self.reading_toggle.setText("Reading")
        self.reading_toggle.setCheckable(True)
        self.reading_toggle.setAutoRaise(True)
        self.reading_toggle.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.reading_toggle.setArrowType(Qt.ArrowType.RightArrow)
        self.reading_toggle.setStyleSheet("QToolButton { font-weight: bold; border: none; }")
        reading_header.addWidget(self.reading_toggle)
        hint = QLabel("used by every later pitch and draft call")
        hint.setStyleSheet(f"color: {COLOR_MUTED};")
        reading_header.addWidget(hint)
        reading_header.addStretch(1)
        self.reading_button = QPushButton("Regenerate reading")
        self.reading_button.clicked.connect(self._on_regenerate_reading)
        reading_header.addWidget(self.reading_button)
        layout.addLayout(reading_header)
        self.enigma_edit = GrowingTextEdit(min_height=30)
        self.enigma_edit.setPlaceholderText("No reading yet. Pitch more makes one.")
        self.enigma_edit.textChanged.connect(self._on_reading_edited)
        layout.addWidget(self.enigma_edit)
        self.notes_edit = GrowingTextEdit(min_height=60)
        self.notes_edit.setPlaceholderText("Notes, one per line")
        self.notes_edit.textChanged.connect(self._on_reading_edited)
        self.notes_edit.hide()
        layout.addWidget(self.notes_edit)

        def toggle_notes(on: bool):
            self.notes_edit.setVisible(on)
            self.reading_toggle.setArrowType(Qt.ArrowType.DownArrow if on else Qt.ArrowType.RightArrow)

        self.reading_toggle.toggled.connect(toggle_notes)

        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_pitch_tab(), "Pitches")
        self.tabs.addTab(self._build_draft_tab(), "Drafts")
        self.tabs.currentChanged.connect(self._on_tab_changed)
        layout.addWidget(self.tabs, stretch=1)
        self.engine_body = panel
        return panel

    def _build_pitch_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        toolbar = QHBoxLayout()
        add = QPushButton("Add pitch")
        add.clicked.connect(self._on_add_pitch)
        toolbar.addWidget(add)
        toolbar.addStretch(1)
        keep_all = QPushButton("Keep all")
        keep_all.clicked.connect(self._on_keep_all)
        toolbar.addWidget(keep_all)
        self.draft_kept_button = QPushButton()
        self.draft_kept_button.clicked.connect(self._on_draft_kept)
        toolbar.addWidget(self.draft_kept_button)
        self._pitch_toolbar_buttons = [add, keep_all]
        layout.addLayout(toolbar)

        host = QWidget()
        self.pitch_layout = QVBoxLayout(host)
        self.pitch_layout.setContentsMargins(0, 0, 0, 0)
        self.pitch_empty = QLabel("No pitches yet. Pitch more writes a reading and the first pitches.")
        self.pitch_empty.setStyleSheet(f"color: {COLOR_MUTED};")
        self.pitch_empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.pitch_pending = QLabel()
        self.pitch_pending.setStyleSheet("color: #6f9fe0;")
        self.pitch_layout.addWidget(self.pitch_empty)
        self.pitch_layout.addWidget(self.pitch_pending)
        self.pitch_layout.addStretch(1)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setWidget(host)
        layout.addWidget(scroll, stretch=1)
        return tab

    def _build_draft_tab(self) -> QWidget:
        tab = QWidget()
        layout = QVBoxLayout(tab)
        toolbar = QHBoxLayout()
        toolbar.addWidget(QLabel("Show"))
        self.chips = DraftChips()
        self.chips.toggled.connect(self._on_chip_toggled)
        toolbar.addWidget(self.chips)
        show_all = QToolButton()
        show_all.setText("All")
        show_all.clicked.connect(self._on_show_all_drafts)
        toolbar.addWidget(show_all)
        toolbar.addStretch(1)
        self.drafting_label = QLabel()
        self.drafting_label.setStyleSheet("color: #6f9fe0;")
        toolbar.addWidget(self.drafting_label)
        self.add_draft_button = QPushButton("Add draft")
        self.add_draft_button.clicked.connect(self._on_add_draft)
        toolbar.addWidget(self.add_draft_button)
        layout.addLayout(toolbar)

        host = QWidget()
        outer = QVBoxLayout(host)
        outer.setContentsMargins(0, 0, 0, 0)
        self.draft_grid = QGridLayout()
        self.draft_grid.setSpacing(10)
        self.draft_grid.setColumnStretch(0, 1)
        self.draft_grid.setColumnStretch(1, 1)
        self.draft_empty = QLabel()
        self.draft_empty.setStyleSheet(f"color: {COLOR_MUTED};")
        self.draft_empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
        outer.addWidget(self.draft_empty)
        outer.addLayout(self.draft_grid)
        outer.addStretch(1)
        self.draft_scroll = QScrollArea()
        self.draft_scroll.setWidgetResizable(True)
        self.draft_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.draft_scroll.setWidget(host)
        layout.addWidget(self.draft_scroll, stretch=1)
        return tab

    # -- Full-window zoom -----------------------------------------------------
    def _build_overlay(self):
        """The selected image over the whole window while Ctrl is held over the image panel.

        The label is transparent to the mouse so the panel beneath keeps
        receiving hover events (no flicker).
        """
        self.overlay = QLabel(self)
        self.overlay.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.overlay.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        self.overlay.setStyleSheet("background: rgba(12,12,14,0.96);")
        self.overlay.hide()

    def _set_image_hover(self, hovered: bool):
        self._image_hovered = hovered
        self._update_overlay()

    def _poll_modifiers(self):
        # queryKeyboardModifiers() reads the live hardware state, unlike
        # keyboardModifiers() which only reflects the last delivered event.
        held = bool(QGuiApplication.queryKeyboardModifiers() & Qt.KeyboardModifier.ControlModifier)
        if held != self._ctrl_held:
            self._ctrl_held = held
            self._update_overlay()

    def _update_overlay(self):
        source = self.image_panel.source
        if not (self._image_hovered and self._ctrl_held) or source.isNull():
            self.overlay.hide()
            return
        rect = self.centralWidget().geometry()
        self.overlay.setGeometry(rect)
        self.overlay.setPixmap(
            source.scaled(rect.size(), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        )
        self.overlay.show()
        self.overlay.raise_()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if getattr(self, "overlay", None) is not None and self.overlay.isVisible():
            self._update_overlay()

    # -- Shortcuts --------------------------------------------------------------
    def _install_shortcuts(self):
        """Ctrl+Left/Right step through tiles and Ctrl+=/-/0 scale fonts, from anywhere in the window.

        A WindowContext shortcut fires no matter which child widget holds
        focus, so it works while the cursor is in a text box, with no clash
        with the plain arrow keys those widgets use for editing.
        """
        bindings: list[tuple[QKeySequence, Callable[[], None]]] = [
            (QKeySequence("Ctrl+Left"), lambda: self._navigate(-1)),
            (QKeySequence("Ctrl+Right"), lambda: self._navigate(1)),
            (QKeySequence("Ctrl+0"), self._reset_font_scale),
        ]
        # Bound to every key a keyboard layout might route "+"/"-" through
        # (the shifted "=" key sends "+" on some layouts without triggering a
        # separate KeypadPlus).
        for keys in ("Ctrl+=", "Ctrl++", "Ctrl+Shift+="):
            bindings.append((QKeySequence(keys), lambda: self._adjust_font_scale(1)))
        bindings.append((QKeySequence(QKeySequence.StandardKey.ZoomIn), lambda: self._adjust_font_scale(1)))
        bindings.append((QKeySequence("Ctrl+-"), lambda: self._adjust_font_scale(-1)))
        bindings.append((QKeySequence(QKeySequence.StandardKey.ZoomOut), lambda: self._adjust_font_scale(-1)))
        for keys, handler in bindings:
            shortcut = QShortcut(keys, self)
            shortcut.setContext(Qt.ShortcutContext.WindowShortcut)
            shortcut.activated.connect(handler)

    def _adjust_font_scale(self, step: int):
        """Grow/shrink every widget's font by one point, app-wide.

        Applied to QApplication rather than this window's font because Qt
        widgets resolve an unset font from their parent at construction time,
        not live -- rescaling only `self` would leave already-built children
        at their original size.
        """
        app = cast(QApplication, QApplication.instance())
        font = app.font()
        new_size = max(self._MIN_FONT_POINT_SIZE, font.pointSize() + step)
        if new_size != font.pointSize():
            font.setPointSize(new_size)
            app.setFont(font)

    def _reset_font_scale(self):
        app = cast(QApplication, QApplication.instance())
        font = app.font()
        if font.pointSize() != self._base_font_point_size:
            font.setPointSize(self._base_font_point_size)
            app.setFont(font)

    # -- Model selectors --------------------------------------------------------
    def _model_combos(self) -> dict[str, QComboBox]:
        """Each model picker by its settings key. The engine's are absent when it failed to load."""
        combos = {
            "alt_model": self.alt_model_combo,
            "title_model": self.title_model_combo,
            "explain_model": self.tag_panel.model_combo,
        }
        if self.story_engine is not None:
            combos.update(
                pitch_model=self.pitch_model_combo,
                draft_model=self.draft_model_combo,
                revise_model=self.revise_model_combo,
            )
        return combos

    def _set_models(self, models: dict):
        """Repopulate every model picker, keeping each one's pick.

        Sorted alphabetically (case-insensitive) by label, except local-server
        entries (model id starts with `local:`), which always sort first. A
        picker with no current pick takes its saved one, else the default.
        """
        if not models:
            return
        ordered = sorted(models.items(), key=lambda item: (not item[1].startswith(LOCAL_PREFIX), item[0].casefold()))
        for setting, combo in self._model_combos().items():
            # Sized by a fixed character count, not the longest label, so a
            # long model name can't widen its column and squeeze the image.
            combo.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
            combo.setMinimumContentsLength(16)
            current = combo.currentData() or self.settings.value(setting, DEFAULT_MODEL)
            combo.blockSignals(True)
            combo.clear()
            for label, model_id in ordered:
                combo.addItem(label, model_id)
            index = combo.findData(current)
            if index < 0:
                index = combo.findData(DEFAULT_MODEL)
            combo.setCurrentIndex(max(index, 0))
            combo.blockSignals(False)
            self._model_setting_connections[setting] = combo.currentIndexChanged.connect(
                lambda _i, s=setting, c=combo: self.settings.setValue(s, c.currentData())
            )
        self._refresh_keywords()

    def _refresh_models(self):
        """Kick off a background query for the live model list."""
        loader = _ModelLoader(available_models)
        loader.setAutoDelete(False)
        self._loaders.add(loader)
        loader.signals.done.connect(self._on_models_loaded)
        self.pool.start(loader)

    def _on_models_loaded(self, models: dict):
        self._loaders.clear()
        # Only the settings connections: the explain panel listens to its own combo.
        for connection in self._model_setting_connections.values():
            QObject.disconnect(connection)
        self._model_setting_connections.clear()
        self._set_models(models)

    # -- Tile table -------------------------------------------------------------
    def _visible_keys(self) -> list[str]:
        """Keys in the table's current filter and sort order."""
        return [
            self.proxy.index(row, 0).data(TileTableModel.KEY_ROLE) for row in range(self.proxy.rowCount())
        ]

    def _on_table_row_changed(self, current, _previous):
        if current.isValid():
            self.select_tile(current.data(TileTableModel.KEY_ROLE))

    def _sync_table_selection(self, key: str):
        row = self.model.row_of(key)
        if row < 0:
            return
        index = self.proxy.mapFromSource(self.model.index(row, 0))
        if not index.isValid() or self.table.currentIndex().row() == index.row():
            return
        self.table.selectionModel().setCurrentIndex(
            index, QItemSelectionModel.SelectionFlag.ClearAndSelect | QItemSelectionModel.SelectionFlag.Rows
        )
        self.table.scrollTo(index)

    def _refresh_tile(self, key: str):
        self.model.refresh(key)
        self._update_counts()

    def _update_counts(self):
        final = unreviewed = empty = 0
        for key in self.model.keys:
            entry = self.index[key]
            if entry.get("final"):
                final += 1
            elif entry.get("story"):
                unreviewed += 1
            else:
                empty += 1
        self.counts_label.setText(
            f"{final} final · {unreviewed} story, not final · {empty} without story · {len(self.model.keys)} total"
        )

    def _exists(self, key: str) -> bool:
        return os.path.exists(os.path.join(self.tile_dir, key))

    def _navigate(self, delta: int):
        """Select the tile `delta` rows from the current one in the table (wrapping)."""
        keys = self._visible_keys()
        if not keys:
            return
        idx = keys.index(self.current_key) if self.current_key in keys else -1
        self.select_tile(keys[(idx + delta) % len(keys)])

    def _navigate_skip_final(self, delta: int):
        """Select the next/previous non-final tile in the table (wrapping)."""
        keys = self._visible_keys()
        if not keys:
            return
        idx = keys.index(self.current_key) if self.current_key in keys else -1
        for step in range(1, len(keys) + 1):
            key = keys[(idx + delta * step) % len(keys)]
            if not self.index[key].get("final"):
                self.select_tile(key)
                return

    # -- Selection --------------------------------------------------------------
    def select_tile(self, key: str):
        if key not in self.index or key == self.current_key:
            return
        self._flush_all()
        self.current_key = key
        self._sync_table_selection(key)
        self._hand_edited.clear()

        entry = self.index[key]
        self._loading = True
        self.name_label.setText(key)
        self.keyword_chips.set_keywords([(kw["text"], kw.get("type", "")) for kw in entry.get("keywords", [])])
        self._open_tag_panel(None)
        self.title_edit.setText(entry.get("title") or "")
        self.story_edit.setPlainText(entry.get("story") or "")
        self.alt_edit.setPlainText(entry.get("alt") or "")
        self.final_button.setChecked(bool(entry.get("final")))
        self.inpaint_check.setChecked(bool(entry.get("needs_inpainting")))
        tags = set(entry.get("sensitive_content_tags") or [])
        for tag, check in self.sensitive_checks.items():
            check.setChecked(tag in tags)
        self._loading = False
        self._update_tile_summaries()
        self.image_panel.set_image(os.path.join(self.tile_dir, key))
        self.trace_label.setText(f"Trace: {story_frame.TRACE_DIR}/{story_frame.subject_for(key)}.jsonl")

        if self.story_engine is not None:
            for row in self._pitch_rows.values():
                _discard(row)
            self._pitch_rows.clear()
            for card in self._draft_cards.values():
                self._unsent_requests[card.draft_id] = card.request.text()
                _discard(card)
            self._draft_cards.clear()
            self._refresh_engine()
        self._update_locks()

    def _update_tile_summaries(self):
        alt = self.alt_edit.toPlainText().strip()
        self.alt_section.summary.setText(f"{len(alt.split())} words" if alt else "empty")
        tags = [tag for tag, check in self.sensitive_checks.items() if check.isChecked()]
        self.tags_section.summary.setText(", ".join(tags) if tags else "none")

    def _is_final(self) -> bool:
        return self.current_key is not None and bool(self.index[self.current_key].get("final"))

    def _update_locks(self):
        final = self._is_final()
        self.final_button.setText("Final ✓" if final else "Mark final")
        self.final_button.setEnabled(bool(self.story_edit.toPlainText().strip()) or final)
        self.story_edit.setReadOnly(final)
        self.clear_button.setEnabled(not final and bool(self.story_edit.toPlainText().strip()))
        titling = self.current_key in self._titling
        self.title_generate_button.setEnabled(not titling and bool(self.story_edit.toPlainText().strip()))
        self.title_generate_button.setText("Working…" if titling else "Generate")

    # -- Merge-safe persistence ---------------------------------------------------
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

    def _flush_all(self):
        self._flush_story()
        self._flush_alt()
        self._flush_title()
        self._flush_workspace()

    # -- External changes (another process editing metadata.json) ---------------
    def _on_watched_file_changed(self, path: str):
        if path == self._tag_notes_path:
            self._on_tag_notes_changed()
        else:
            self._on_metadata_changed(path)

    def _on_metadata_changed(self, _path: str):
        if self._metadata_path not in self._fs_watcher.files() and os.path.exists(self._metadata_path):
            self._fs_watcher.addPath(self._metadata_path)  # re-add after replace-via-rename

        # A malformed read means we caught the file mid-write (or it's genuinely
        # corrupt); either way an empty {} here would reconcile as "every tile
        # removed" and tear the whole table down. Skip this event and wait for
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
        removed = [key for key in self.index if key not in fresh and key != self.current_key]
        changed = [
            key for key in fresh
            if key != self.current_key and key in self.index and fresh[key] != self.index[key]
        ]
        self.index = fresh
        for key in removed:
            self.model.remove(key)
        for key in added:
            flagged = bool((fresh[key] or {}).get("sensitive_content_tags"))
            if (self.content_review == "flagged" and not flagged) or (self.content_review == "unflagged" and flagged):
                continue
            self.model.add(key)
        for key in changed:
            self.model.refresh(key)
        if added or removed or changed:
            self._update_counts()

    # -- Tile fields ----------------------------------------------------------------
    def _on_story_changed(self):
        if self._loading:
            return
        self._save_timer.start()
        self._update_locks()
        # The chosen draft and the story are one text.
        subject, workspace = self._current_workspace()
        if workspace is not None and subject is not None:
            draft = workspace.draft(workspace.chosen)
            if draft is not None:
                self._hand_edit(draft, self.story_edit.toPlainText())
                self._mark_workspace_dirty(subject)
                card = self._draft_cards.get(draft.id)
                if card is not None:
                    set_text_quietly(card.text, draft.story)

    def _flush_story(self):
        self._save_timer.stop()
        if self.current_key is None:
            return
        entry = self.index[self.current_key]
        text = self.story_edit.toPlainText()
        if text != (entry.get("story") or ""):
            entry["story"] = text or None
            self._save_index_entry(self.current_key, entry)
            self._refresh_tile(self.current_key)

    def _set_story(self, key: str, text: str | None):
        """Store ``text`` as ``key``'s story now, and show it if ``key`` is selected."""
        entry = self.index[key]
        entry["story"] = text or None
        self._save_index_entry(key, entry)
        self._refresh_tile(key)
        if key == self.current_key:
            self._save_timer.stop()
            self._loading = True
            self.story_edit.setPlainText(text or "")
            self._loading = False
            self._update_locks()

    def _on_title_changed(self):
        if not self._loading:
            self._title_save_timer.start()

    def _flush_title(self):
        self._title_save_timer.stop()
        if self.current_key is None:
            return
        entry = self.index[self.current_key]
        text = self.title_edit.text().strip()
        if text != (entry.get("title") or ""):
            entry["title"] = text or None
            self._save_index_entry(self.current_key, entry)
            self._refresh_tile(self.current_key)

    def _confirm_title_replace(self, key: str, old: str) -> bool:
        reply = QMessageBox.question(
            self,
            "Replace title",
            f'Replace {key}\'s title "{old}" with a generated one?',
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        return reply == QMessageBox.StandardButton.Yes

    def _on_generate_title(self):
        """Ask ``titles.propose_title`` for a title, blocking every title already in the index.

        The tile's own current title is blocked too, so generating again
        always proposes something new. A non-empty title is replaced only
        after confirmation, asked again on arrival if it changed meanwhile.
        """
        key = self.current_key
        if key is None or key in self._titling:
            return
        self._flush_story()
        self._flush_title()
        entry = self.index[key]
        story = entry.get("story")
        if not story:
            return
        image = os.path.join(self.tile_dir, key)
        if not os.path.exists(image):
            QMessageBox.warning(self, "Missing image", f"{key} is not on disk.")
            return
        old = entry.get("title") or ""
        if old and not self._confirm_title_replace(key, old):
            return
        registry = titles.TitleRegistry(e["title"] for e in self.index.values() if e.get("title"))
        model = self.title_model_combo.currentData()
        self._titling.add(key)
        self._update_locks()

        def finish():
            self._titling.discard(key)
            if key == self.current_key:
                self._update_locks()

        def done(title: str | None):
            finish()
            if key not in self.index:
                return
            if title is None:
                QMessageBox.warning(
                    self, "Title generation failed",
                    f"No valid title for {key} after {titles.MAX_ATTEMPTS} attempts.",
                )
                return
            if key == self.current_key:
                self._flush_title()
            # Another tile may have claimed a near-duplicate while this call ran.
            others = titles.TitleRegistry(
                e["title"] for k, e in self.index.items() if k != key and e.get("title")
            )
            conflict = others.conflict(title)
            if conflict is not None:
                QMessageBox.warning(
                    self, "Title generation failed",
                    f'"{title}" is too close to "{conflict}", claimed while {key} was generating.',
                )
                return
            current = self.index[key].get("title") or ""
            if current and current != old and not self._confirm_title_replace(key, current):
                return
            self._set_title(key, title)

        def failed(message: str):
            finish()
            QMessageBox.critical(self, "Title generation failed", message)

        self._run(lambda: titles.propose_title(image, story, registry, model, key=key), model, done, failed)

    def _set_title(self, key: str, title: str):
        """Store ``title`` as ``key``'s title now, and show it if ``key`` is selected."""
        entry = self.index[key]
        entry["title"] = title
        self._save_index_entry(key, entry)
        self._refresh_tile(key)
        if key == self.current_key:
            self._title_save_timer.stop()
            self._loading = True
            self.title_edit.setText(title)
            self._loading = False

    def _on_alt_changed(self):
        if not self._loading:
            self._alt_save_timer.start()
            self._update_tile_summaries()

    def _flush_alt(self):
        self._alt_save_timer.stop()
        if self.current_key is None:
            return
        entry = self.index[self.current_key]
        text = self.alt_edit.toPlainText()
        if text != (entry.get("alt") or ""):
            entry["alt"] = text or None
            self._save_index_entry(self.current_key, entry)

    def _on_generate_alt(self):
        key = self.current_key
        if key is None or not self.alt_generate_button.isEnabled():
            return
        webp_path = os.path.join(self.tile_dir, key)
        if not os.path.exists(webp_path):
            QMessageBox.warning(self, "Missing image", f"{key} is not on disk.")
            return
        prompt = core.default_alt_prompt(core.keyword_texts(self.index[key]))
        model = self.alt_model_combo.currentData()
        self.alt_generate_button.setEnabled(False)
        self.alt_generate_button.setText("Working…")

        def done(text: str):
            self._reset_alt_button()
            entry = self.index[key]
            entry["alt"] = text.strip()
            self._save_index_entry(key, entry)
            if self.current_key == key:
                self._loading = True
                self.alt_edit.setPlainText(text.strip())
                self._loading = False
                self._update_tile_summaries()

        def failed(message: str):
            self._reset_alt_button()
            QMessageBox.critical(self, "Alt text generation failed", message)

        self._run(lambda: core.generate_alt_text(webp_path, prompt, model), model, done, failed)

    def _reset_alt_button(self):
        self.alt_generate_button.setEnabled(True)
        self.alt_generate_button.setText("Generate alt")

    def _on_final_toggled(self, checked: bool):
        if self._loading or self.current_key is None:
            return
        key = self.current_key
        self._flush_story()
        entry = self.index[key]
        entry["final"] = checked
        self._save_index_entry(key, entry)
        self._refresh_tile(key)
        self._update_locks()
        self._refresh_engine()
        if checked:
            self._record_outcome(key, "accepted", entry.get("story"))
            self._navigate_skip_final(1)

    def _on_inpaint_toggled(self, checked: bool):
        if self._loading or self.current_key is None:
            return
        entry = self.index[self.current_key]
        if checked:
            entry["needs_inpainting"] = True
        else:
            entry.pop("needs_inpainting", None)
        self._save_index_entry(self.current_key, entry)

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
        self._update_tile_summaries()

    def _on_clear(self):
        """Wipe the story and unmark the chosen draft; the drafts themselves stay."""
        key = self.current_key
        if key is None or self._is_final():
            return
        self._record_outcome(key, "discarded", self.story_edit.toPlainText())
        subject, workspace = self._current_workspace()
        if workspace is not None and subject is not None and workspace.chosen:
            workspace.chosen = None
            self._save_workspace(subject)
        self._set_story(key, None)
        self._refresh_engine()

    def _on_save_to_sample(self):
        key = self.current_key
        if key is None:
            return
        if not self._exists(key):
            QMessageBox.warning(self, "Missing image", f"{key} is not on disk.")
            return
        try:
            name = core.add_to_tile_collection_sample(self.tile_dir, key, self.index[key])
        except OSError as err:
            QMessageBox.critical(self, "Save to samples failed", str(err))
            return
        QMessageBox.information(self, "Saved to samples", f"Copied {key} to assets/tile-collection-sample as {name}.")

    def _on_delete(self):
        key = self.current_key
        if key is None:
            return
        reply = QMessageBox.question(
            self,
            "Delete tile",
            f"Delete {key} from disk and metadata? This cannot be undone.",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        keys = self._visible_keys()
        pos = keys.index(key) if key in keys else 0
        path = os.path.join(self.tile_dir, key)
        if os.path.exists(path):
            os.remove(path)
        self._save_timer.stop()
        self._title_save_timer.stop()
        self._alt_save_timer.stop()
        self._save_index_entry(key, None)
        self.current_key = None
        self.model.remove(key)
        self._update_counts()
        remaining = self._visible_keys()
        if remaining:
            self.select_tile(remaining[min(pos, len(remaining) - 1)])

    # -- Keyword explanations -----------------------------------------------------------
    def _watch_tag_notes(self) -> bool:
        """Watch the explanations file once it exists; True when the watch is new.

        Also re-adds the watch after a replace-via-rename dropped it.
        """
        if os.path.exists(self._tag_notes_path) and self._tag_notes_path not in self._fs_watcher.files():
            return self._fs_watcher.addPath(self._tag_notes_path)
        return False

    def _on_tile_dir_changed(self, _path: str):
        if self._watch_tag_notes():
            self._on_tag_notes_changed()

    def _on_tag_notes_changed(self):
        self._watch_tag_notes()
        try:
            self.tag_notes = tag_explainer.load(self.tile_dir, strict=True)
        except json.JSONDecodeError:
            return  # caught mid-write; the next fire has the whole file
        self._refresh_keywords()

    def _active_model(self) -> str | None:
        """The model a keyword's explanation is for: the Drafts tab's draft model, else the pitch model."""
        if self.story_engine is None:
            return None
        combo = self.draft_model_combo if self.tabs.currentIndex() == 1 else self.pitch_model_combo
        return combo.currentData()

    def _keyword_kind(self, keyword: str) -> str:
        if self.current_key is None:
            return ""
        for kw in self.index[self.current_key].get("keywords", []):
            if kw["text"] == keyword:
                return kw.get("type", "")
        return ""

    def _keyword_tooltip(self, keyword: str) -> str:
        kind = html.escape(self._keyword_kind(keyword))
        found = tag_explainer.preferred(self.tag_notes.get(keyword, {}), self._active_model())
        if found is None:
            return f"<p>{kind}</p><p>No explanation yet. Click to ask a model, or right-click for the pitch and draft models.</p>"
        model, entry = found
        paragraphs = "".join(f"<p>{html.escape(p)}</p>" for p in entry.get("text", "").split("\n") if p.strip())
        return f"<p><b>{html.escape(self.tag_panel.model_label(model))}</b></p>{paragraphs}"

    def _refresh_keywords(self):
        self.keyword_chips.set_state({k for k, v in self.tag_notes.items() if v}, self._open_keyword)
        keyword = self._open_keyword
        if keyword is not None:
            busy = {model for k, model in self._explaining if k == keyword}
            self.tag_panel.show_keyword(keyword, self.tag_notes.get(keyword, {}), busy)

    def _open_tag_panel(self, keyword: str | None):
        """Show ``keyword``'s explanations with the active model picked, or close the panel for None."""
        self._open_keyword = keyword
        self.tag_panel.setVisible(keyword is not None)
        if keyword is not None:
            self._pick_explain_model()
        self._refresh_keywords()

    def _pick_explain_model(self):
        index = self.tag_panel.model_combo.findData(self._active_model())
        if index >= 0:
            self.tag_panel.model_combo.setCurrentIndex(index)

    def _on_tab_changed(self, _index: int):
        if self._open_keyword is not None:
            self._pick_explain_model()

    def _on_keyword_clicked(self, keyword: str):
        self._open_tag_panel(None if keyword == self._open_keyword else keyword)

    def _on_keyword_menu(self, keyword: str, pos):
        menu = QMenu(self)
        menu.addAction("Show explanations", lambda: self._open_tag_panel(keyword))
        if self.story_engine is not None:
            # A model picked for both stages gets one entry naming both.
            stages: dict[str, tuple[str, list[str]]] = {}
            for stage, combo in (("pitch", self.pitch_model_combo), ("draft", self.draft_model_combo)):
                model = combo.currentData()
                if model:
                    stages.setdefault(model, (combo.currentText(), []))[1].append(stage)
            menu.addSeparator()
            explained = self.tag_notes.get(keyword, {})
            for model, (label, names) in stages.items():
                text = f"Explain with {' and '.join(names)} model ({label})"
                if (keyword, model) in self._explaining:
                    text += ": working"
                elif model in explained:
                    text += ": already explained"
                action = menu.addAction(text, lambda m=model: self._explain_tag(keyword, m))
                action.setEnabled((keyword, model) not in self._explaining and model not in explained)
        menu.exec(pos)

    def _on_explain_requested(self, keyword: str, model: str):
        if model in self.tag_notes.get(keyword, {}):
            reply = QMessageBox.question(
                self,
                "Re-explain keyword",
                f"Replace {self.tag_panel.model_label(model)}'s explanation of {keyword}?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if reply != QMessageBox.StandardButton.Yes:
                return
        self._explain_tag(keyword, model)

    def _explain_tag(self, keyword: str, model: str):
        """Ask ``model`` about ``keyword`` in the background and store the answer."""
        if (keyword, model) in self._explaining:
            return
        kind = self._keyword_kind(keyword)
        self._explaining.add((keyword, model))
        self._refresh_keywords()

        def done(text: str):
            self._explaining.discard((keyword, model))
            self.tag_notes = tag_explainer.record(self.tile_dir, keyword, model, text)
            self._watch_tag_notes()
            self._refresh_keywords()

        def failed(message: str):
            self._explaining.discard((keyword, model))
            self._refresh_keywords()
            QMessageBox.critical(self, "Keyword explanation failed", message)

        self._run(lambda: tag_explainer.explain(keyword, kind, model), model, done, failed)

    # -- Model calls ----------------------------------------------------------------
    def _run(self, fn: Callable[[], object], model: str | None, on_done: Callable, on_error: Callable) -> None:
        """Run ``fn`` on a worker thread; ``on_done(result)`` or ``on_error(message)`` runs on this thread."""
        token = next(self._tokens)
        worker = _CallWorker(token, fn)
        worker.setAutoDelete(False)  # kept in _calls until it reports, so its signals survive delivery
        self._calls[token] = (worker, on_done, on_error)
        worker.signals.done.connect(self._on_call_done)
        worker.signals.error.connect(self._on_call_error)
        pool = self.local_pool if model and model.startswith(LOCAL_PREFIX) else self.pool
        pool.start(worker)

    def _on_call_done(self, token: int, result: object):
        _worker, on_done, _on_error = self._calls.pop(token)
        on_done(result)

    def _on_call_error(self, token: int, message: str):
        _worker, _on_done, on_error = self._calls.pop(token)
        on_error(message)

    # -- Workspaces -------------------------------------------------------------------
    def _workspace(self, subject: str) -> Workspace:
        if subject not in self._workspaces:
            assert self.store is not None
            workspace = self.store.load(subject)
            self._workspaces[subject] = workspace
            self._hidden[subject] = {d.id for d in workspace.drafts if d.dropped}
        return self._workspaces[subject]

    def _current_workspace(self) -> tuple[str | None, Workspace | None]:
        if self.current_key is None or self.store is None:
            return None, None
        subject = story_frame.subject_for(self.current_key)
        return subject, self._workspace(subject)

    def _save_workspace(self, subject: str):
        if self.store is not None and subject in self._workspaces:
            if self._dirty_subject == subject:
                self._workspace_save_timer.stop()
                self._dirty_subject = None
            self.store.save(subject, self._workspaces[subject])

    def _mark_workspace_dirty(self, subject: str):
        """Save ``subject``'s workspace after a pause in typing."""
        if self._dirty_subject not in (None, subject):
            self._flush_workspace()
        self._dirty_subject = subject
        self._workspace_save_timer.start()

    def _flush_workspace(self):
        self._workspace_save_timer.stop()
        if self._dirty_subject is not None:
            subject, self._dirty_subject = self._dirty_subject, None
            self._save_workspace(subject)

    def _key_for(self, subject: str) -> str | None:
        return next((k for k in self.index if story_frame.subject_for(k) == subject), None)

    def _engine_inputs(self, key: str) -> tuple[str, str, list[str]] | None:
        """(subject, image path, keywords) for ``key``, or None if the image is gone."""
        image = os.path.join(self.tile_dir, key)
        if not os.path.exists(image):
            QMessageBox.warning(self, "Missing image", f"{key} is not on disk.")
            return None
        return story_frame.subject_for(key), image, core.keyword_texts(self.index[key])

    def _hand_edit(self, draft: DraftEntry, text: str):
        """Apply a typed change to ``draft``, keeping its pre-edit text once per editing session."""
        if text == draft.story:
            return
        if draft.id not in self._hand_edited and draft.story:
            draft.replace_story(text, "hand edit")
            self._hand_edited.add(draft.id)
        else:
            draft.story = text

    # -- Engine panel -------------------------------------------------------------------
    def _refresh_engine(self):
        """Bring the engine panel in line with the current tile's workspace."""
        if self.story_engine is None:
            return
        subject, workspace = self._current_workspace()
        if subject is None or workspace is None:
            return
        locked = self._is_final()
        self.engine_counts.setText(f"{len(workspace.pitches)} pitches, {len(workspace.drafts)} drafts")
        pitching = self._pitching.get(subject)
        self.pitch_button.setEnabled(pitching is None and not locked)
        self.reading_button.setEnabled(subject not in self._reading_busy and workspace.reading is not None and not locked)
        self.reading_button.setText("Regenerating…" if subject in self._reading_busy else "Regenerate reading")
        reading = workspace.reading
        set_text_quietly(self.enigma_edit, reading.enigma if reading else "")
        set_text_quietly(self.notes_edit, "\n".join(reading.notes) if reading else "")
        self.enigma_edit.setReadOnly(locked or reading is None)
        self.notes_edit.setReadOnly(locked or reading is None)
        self._refresh_pitches(subject, workspace, locked)
        self._refresh_drafts(subject, workspace, locked)
        self._update_provenance(workspace)

    def _refresh_pitches(self, subject: str, workspace: Workspace, locked: bool):
        drafted = {d.pitch_id for d in workspace.drafts}
        writing = self._writing.get(subject, [])
        for pitch_id in [pid for pid in self._pitch_rows if workspace.pitch(pid) is None]:
            _discard(self._pitch_rows.pop(pitch_id))
        for number, pitch in enumerate(workspace.pitches, 1):
            row = self._pitch_rows.get(pitch.id)
            if row is None:
                row = PitchRow(pitch.id)
                row.keptChanged.connect(self._on_pitch_kept)
                row.noteChanged.connect(self._on_pitch_note)
                row.fieldsEdited.connect(self._on_pitch_fields)
                row.deleteRequested.connect(self._on_delete_pitch)
                self._pitch_rows[pitch.id] = row
            if pitch.id in writing:
                status = "drafting…"
            elif pitch.id in drafted:
                status = "drafted"
            else:
                status = "not drafted yet" if pitch.kept else "dropped"
            row.update_from(pitch, number, status, locked)
            # Insert in list order, ahead of the empty/pending labels and the stretch.
            if self.pitch_layout.indexOf(row) != number - 1:
                self.pitch_layout.insertWidget(number - 1, row)
        self.pitch_empty.setVisible(not workspace.pitches and self._pitching.get(subject) is None)
        count = self._pitching.get(subject)
        self.pitch_pending.setVisible(count is not None)
        if count is not None:
            first = len(workspace.pitches) + 1
            self.pitch_pending.setText(f"Pitching {count} more; they will be added as pitches {first} to {first + count - 1}.")
        undrafted = [p for p in workspace.undrafted_kept() if p.id not in writing]
        self.draft_kept_button.setText(f"Draft kept pitches ({len(undrafted)} new)")
        self.draft_kept_button.setEnabled(bool(undrafted) and not locked)
        for button in self._pitch_toolbar_buttons:
            button.setEnabled(not locked)

    def _refresh_drafts(self, subject: str, workspace: Workspace, locked: bool):
        hidden = self._hidden.setdefault(subject, set())
        revising = self._revising.get(subject, {})
        for draft_id in [did for did in self._draft_cards if workspace.draft(did) is None]:
            _discard(self._draft_cards.pop(draft_id))
        while self.draft_grid.count():
            self.draft_grid.takeAt(0)
        chips = []
        position = 0
        for number, draft in enumerate(workspace.drafts, 1):
            chosen = draft.id == workspace.chosen
            chips.append((draft.id, number, draft.id not in hidden, "chosen" if chosen else "dropped" if draft.dropped else ""))
            card = self._draft_cards.get(draft.id)
            if card is None:
                card = self._new_draft_card(draft.id)
            pitch = workspace.pitch(draft.pitch_id)
            if pitch is not None:
                pitch_text = f"Pitch {workspace.pitch_number(pitch.id)}, {pitch.seed}: {pitch.pitch}"
            elif draft.pitch_id is None:
                pitch_text = "Written by hand"
            else:
                pitch_text = "From a deleted pitch"
            card.update_from(
                draft, number, pitch_text, chosen, revising.get(draft.id), locked and chosen,
                can_redraft=pitch is not None and not locked,
            )
            if draft.id in hidden:
                card.hide()
                continue
            card.show()
            self.draft_grid.addWidget(card, position // 2, position % 2)
            position += 1
        self.chips.set_drafts(chips)
        writing = len(self._writing.get(subject, []))
        self.drafting_label.setText(f"Writing {writing} draft{'s' if writing != 1 else ''}…" if writing else "")
        self.add_draft_button.setEnabled(not locked)
        self.draft_empty.setVisible(position == 0)
        if not workspace.drafts:
            self.draft_empty.setText("No drafts yet. Review the pitches, then draft the kept ones.")
        else:
            self.draft_empty.setText("Every draft is hidden. Pick drafts to show above.")

    def _new_draft_card(self, draft_id: str) -> DraftCard:
        card = DraftCard(draft_id)
        card.textEdited.connect(self._on_draft_text)
        card.reviseRequested.connect(self._on_revise)
        card.chooseRequested.connect(self._on_choose)
        card.dropToggled.connect(self._on_drop_toggled)
        card.duplicateRequested.connect(self._on_duplicate)
        card.redraftRequested.connect(self._on_redraft)
        card.historyRequested.connect(self._on_history)
        card.hideRequested.connect(lambda did: self._on_chip_toggled(did, False))
        card.deleteRequested.connect(self._on_delete_draft)
        card.objectionEditRequested.connect(self._on_objection_edit)
        card.objectionPassed.connect(self._on_objection_pass)
        card.request.setText(self._unsent_requests.pop(draft_id, ""))
        self._draft_cards[draft_id] = card
        return card

    def _update_provenance(self, workspace: Workspace):
        draft = workspace.draft(workspace.chosen)
        if draft is not None:
            number = workspace.draft_number(draft.id)
            pitch_number = workspace.pitch_number(draft.pitch_id)
            source = f", pitch {pitch_number}" if pitch_number else ""
            revised = ", revised" if any(v["reason"].startswith("revise") for v in draft.history) else ""
            self.provenance_label.setText(f"from draft {number} ({draft.form}{source}){revised}")
        elif self.story_edit.toPlainText().strip():
            self.provenance_label.setText("not from a draft")
        else:
            self.provenance_label.setText("")

    # -- Reading --------------------------------------------------------------------------
    def _on_reading_edited(self):
        subject, workspace = self._current_workspace()
        if subject is None or workspace is None or workspace.reading is None:
            return
        workspace.reading = Reading(
            enigma=self.enigma_edit.toPlainText().strip(),
            notes=[line.strip() for line in self.notes_edit.toPlainText().splitlines() if line.strip()],
        )
        self._mark_workspace_dirty(subject)

    def _on_regenerate_reading(self):
        key = self.current_key
        if key is None or self.story_engine is None:
            return
        inputs = self._engine_inputs(key)
        if inputs is None:
            return
        subject, image, keywords = inputs
        engine, model = self.story_engine, self.pitch_model_combo.currentData()
        self._reading_busy.add(subject)

        def done(reading: Reading):
            self._reading_busy.discard(subject)
            self._workspace(subject).reading = reading
            self._save_workspace(subject)
            self._refresh_if_current(subject)

        def failed(message: str):
            self._reading_busy.discard(subject)
            self._refresh_if_current(subject)
            QMessageBox.critical(self, "Reading failed", message)

        self._run(lambda: engine.read(subject, image, keywords, model), model, done, failed)
        self._refresh_engine()

    def _refresh_if_current(self, subject: str):
        if self.current_key is not None and story_frame.subject_for(self.current_key) == subject:
            self._refresh_engine()

    # -- Pitches -----------------------------------------------------------------------------
    def _on_pitch_more(self):
        key = self.current_key
        if key is None or self.story_engine is None:
            return
        inputs = self._engine_inputs(key)
        if inputs is None:
            return
        subject, image, keywords = inputs
        if subject in self._pitching:
            return
        workspace = self._workspace(subject)
        engine, model = self.story_engine, self.pitch_model_combo.currentData()
        count = self.pitch_count.value()
        reading = workspace.reading
        existing = [p.as_pitch() for p in workspace.pitches]
        extra = self.instructions_edit.text()
        self._pitching[subject] = count

        def done(result):
            new_reading, pitches = result
            self._pitching.pop(subject, None)
            target = self._workspace(subject)
            if new_reading is not None and target.reading is None:
                target.reading = new_reading
            stamp = now()
            target.pitches += [
                PitchEntry(new_id(), p.seed, p.pitch, p.hook, p.anchor, source=model, created=stamp) for p in pitches
            ]
            self._save_workspace(subject)
            self._refresh_if_current(subject)

        def failed(message: str):
            self._pitching.pop(subject, None)
            self._refresh_if_current(subject)
            QMessageBox.critical(self, "Pitching failed", message)

        self._run(
            lambda: engine.pitch(subject, image, keywords, model, count, reading, existing, extra), model, done, failed
        )
        self.tabs.setCurrentIndex(0)
        self._refresh_engine()

    def _on_pitch_kept(self, pitch_id: str, kept: bool):
        subject, workspace = self._current_workspace()
        pitch = workspace.pitch(pitch_id) if workspace else None
        if subject is None or pitch is None:
            return
        pitch.kept = kept
        self._save_workspace(subject)
        self._refresh_engine()

    def _on_pitch_note(self, pitch_id: str, text: str):
        subject, workspace = self._current_workspace()
        pitch = workspace.pitch(pitch_id) if workspace else None
        if subject is None or pitch is None:
            return
        pitch.note = text
        self._mark_workspace_dirty(subject)

    def _on_pitch_fields(self, pitch_id: str, fields: dict):
        subject, workspace = self._current_workspace()
        pitch = workspace.pitch(pitch_id) if workspace else None
        if subject is None or pitch is None:
            return
        pitch.seed, pitch.pitch, pitch.hook, pitch.anchor = (
            fields["seed"], fields["pitch"], fields["hook"], fields["anchor"],
        )
        self._save_workspace(subject)
        self._refresh_engine()

    def _on_delete_pitch(self, pitch_id: str):
        subject, workspace = self._current_workspace()
        pitch = workspace.pitch(pitch_id) if workspace else None
        if subject is None or workspace is None or pitch is None:
            return
        drafts = sum(1 for d in workspace.drafts if d.pitch_id == pitch_id)
        if drafts:
            reply = QMessageBox.question(
                self, "Delete pitch",
                f"Delete pitch {workspace.pitch_number(pitch_id)}? Its {drafts} draft(s) stay, marked as from a deleted pitch.",
            )
            if reply != QMessageBox.StandardButton.Yes:
                return
        workspace.pitches.remove(pitch)
        self._save_workspace(subject)
        self._refresh_engine()

    def _on_add_pitch(self):
        subject, workspace = self._current_workspace()
        if subject is None or workspace is None:
            return
        pitch = PitchEntry(new_id(), "own idea", "", "", "", source="hand", created=now())
        workspace.pitches.append(pitch)
        self._save_workspace(subject)
        self._refresh_engine()
        self._pitch_rows[pitch.id].start_editing()

    def _on_keep_all(self):
        subject, workspace = self._current_workspace()
        if subject is None or workspace is None:
            return
        for pitch in workspace.pitches:
            pitch.kept = True
        self._save_workspace(subject)
        self._refresh_engine()

    # -- Drafting --------------------------------------------------------------------------
    def _on_draft_kept(self):
        subject, workspace = self._current_workspace()
        if subject is None or workspace is None:
            return
        writing = self._writing.get(subject, [])
        for pitch in workspace.undrafted_kept():
            if pitch.id not in writing:
                self._start_write(pitch.id)
        self.tabs.setCurrentIndex(1)

    def _start_write(self, pitch_id: str):
        key = self.current_key
        if key is None or self.story_engine is None:
            return
        inputs = self._engine_inputs(key)
        if inputs is None:
            return
        subject, image, keywords = inputs
        workspace = self._workspace(subject)
        pitch = workspace.pitch(pitch_id)
        if pitch is None:
            return
        engine, model = self.story_engine, self.draft_model_combo.currentData()
        form = self.form_combo.currentData()
        chance = self.chance_slider.value() / 100
        reading, brief, note = workspace.reading, pitch.as_pitch(), pitch.note
        self._writing.setdefault(subject, []).append(pitch_id)

        def finish():
            writing = self._writing.get(subject, [])
            if pitch_id in writing:
                writing.remove(pitch_id)

        def done(draft):
            finish()
            target = self._workspace(subject)
            entry = DraftEntry(
                new_id(), pitch_id, draft.form, draft.constraint, draft.story,
                prompt=draft.prompt, model=model, created=now(),
            )
            target.drafts.append(entry)
            self._save_workspace(subject)
            self._refresh_if_current(subject)

        def failed(message: str):
            finish()
            self._refresh_if_current(subject)
            QMessageBox.warning(self, "Draft failed", f"Pitch {workspace.pitch_number(pitch_id)}: {message}")

        self._run(
            lambda: engine.write(subject, image, keywords, reading, brief, model, form, chance, note, pitch_id),
            model, done, failed,
        )
        self._refresh_engine()

    def _on_redraft(self, draft_id: str):
        _subject, workspace = self._current_workspace()
        draft = workspace.draft(draft_id) if workspace else None
        if draft is not None and draft.pitch_id is not None:
            self._start_write(draft.pitch_id)

    def _on_add_draft(self):
        subject, workspace = self._current_workspace()
        if subject is None or workspace is None:
            return
        draft = DraftEntry(new_id(), None, "by hand", None, "", model="hand", created=now())
        workspace.drafts.append(draft)
        self._hidden.setdefault(subject, set()).discard(draft.id)
        self._save_workspace(subject)
        self._refresh_engine()
        self._draft_cards[draft.id].text.setFocus()

    def _on_draft_text(self, draft_id: str, text: str):
        subject, workspace = self._current_workspace()
        draft = workspace.draft(draft_id) if workspace else None
        if subject is None or workspace is None or draft is None or text == draft.story:
            return
        self._hand_edit(draft, text)
        self._mark_workspace_dirty(subject)
        if draft.id == workspace.chosen and self.current_key is not None and not self._is_final():
            self._loading = True
            self.story_edit.setPlainText(text)
            self._loading = False
            self._save_timer.start()

    def _on_duplicate(self, draft_id: str):
        subject, workspace = self._current_workspace()
        draft = workspace.draft(draft_id) if workspace else None
        if subject is None or workspace is None or draft is None:
            return
        copy_ = copy.deepcopy(draft)
        copy_.id, copy_.created, copy_.objection = new_id(), now(), None
        workspace.drafts.insert(workspace.drafts.index(draft) + 1, copy_)
        self._save_workspace(subject)
        self._refresh_engine()

    def _on_history(self, draft_id: str):
        subject, workspace = self._current_workspace()
        draft = workspace.draft(draft_id) if workspace else None
        if subject is None or workspace is None or draft is None:
            return
        dialog = HistoryDialog(draft, workspace.draft_number(draft_id) or 0, self)
        if dialog.exec() and dialog.chosen_text is not None and not (self._is_final() and draft.id == workspace.chosen):
            draft.replace_story(dialog.chosen_text, "restore")
            self._hand_edited.discard(draft.id)
            self._save_workspace(subject)
            if draft.id == workspace.chosen and self.current_key is not None:
                self._set_story(self.current_key, draft.story)
            self._refresh_engine()

    def _on_drop_toggled(self, draft_id: str):
        subject, workspace = self._current_workspace()
        draft = workspace.draft(draft_id) if workspace else None
        if subject is None or draft is None:
            return
        draft.dropped = not draft.dropped
        self._save_workspace(subject)
        self._refresh_engine()

    def _on_delete_draft(self, draft_id: str):
        subject, workspace = self._current_workspace()
        draft = workspace.draft(draft_id) if workspace else None
        if subject is None or workspace is None or draft is None:
            return
        number = workspace.draft_number(draft_id)
        reply = QMessageBox.question(self, "Delete draft", f"Delete draft {number} and its earlier versions?")
        if reply != QMessageBox.StandardButton.Yes:
            return
        workspace.drafts.remove(draft)
        if workspace.chosen == draft_id:
            workspace.chosen = None  # the story itself stays in metadata.json
        self._save_workspace(subject)
        self._refresh_engine()

    def _on_chip_toggled(self, draft_id: str, shown: bool):
        subject, _workspace = self._current_workspace()
        if subject is None:
            return
        hidden = self._hidden.setdefault(subject, set())
        if shown:
            hidden.discard(draft_id)
        else:
            hidden.add(draft_id)
        self._refresh_engine()

    def _on_show_all_drafts(self):
        subject, _workspace = self._current_workspace()
        if subject is not None:
            self._hidden[subject] = set()
            self._refresh_engine()

    # -- Choosing ------------------------------------------------------------------------------
    def _on_choose(self, draft_id: str):
        key = self.current_key
        subject, workspace = self._current_workspace()
        draft = workspace.draft(draft_id) if workspace else None
        if key is None or subject is None or workspace is None or draft is None or self._is_final():
            return
        workspace.chosen = draft_id
        self._save_workspace(subject)
        if self.story_engine is not None:
            self.story_engine.record_choice(subject, draft_id, draft.story)
        self._set_story(key, draft.story)
        self._refresh_engine()

    def _record_outcome(self, key: str, outcome: str, story: str | None):
        """Log a Final or Clear on an engine-written story, for tuning.

        A tile whose workspace has no chosen draft never took a story from the
        engine and is skipped. ``edited`` marks a story changed by hand since
        the draft was chosen.
        """
        if self.story_engine is None or self.store is None or not story:
            return
        subject = story_frame.subject_for(key)
        workspace = self._workspace(subject)
        draft = workspace.draft(workspace.chosen)
        if draft is None:
            return
        edited = any(v["reason"] in ("hand edit", "restore") for v in draft.history)
        self.story_engine.record_outcome(subject, outcome, story, draft_id=draft.id, edited=edited)

    # -- Revising --------------------------------------------------------------------------------
    def _on_revise(self, draft_id: str, request: str):
        key = self.current_key
        if key is None or self.story_engine is None:
            return
        inputs = self._engine_inputs(key)
        if inputs is None:
            return
        subject, image, keywords = inputs
        workspace = self._workspace(subject)
        draft = workspace.draft(draft_id)
        revising = self._revising.setdefault(subject, {})
        if draft is None or draft_id in revising:
            return
        engine, model = self.story_engine, self.revise_model_combo.currentData()
        pitch = workspace.pitch(draft.pitch_id)
        prompt = draft.prompt or engine.context_prompt(
            keywords, workspace.reading, pitch.as_pitch() if pitch else None, pitch.note if pitch else ""
        )
        story = draft.story
        revising[draft_id] = request
        card = self._draft_cards.get(draft_id)
        if card is not None:
            card.take_request()

        def done(revision):
            revising.pop(draft_id, None)
            target = self._workspace(subject).draft(draft_id)
            if target is None:
                return  # deleted while the call ran
            if revision.story is not None and revision.story.strip() == target.story.strip():
                target.objection = {"request": request, "reply": "The writer sent the draft back unchanged."}
            elif revision.story is not None:
                target.replace_story(revision.story, f"revise: {request}")
                target.objection = None
                self._hand_edited.discard(draft_id)
                target_key = self._key_for(subject)
                if self._workspace(subject).chosen == draft_id and target_key is not None:
                    if not self.index[target_key].get("final"):
                        self._set_story(target_key, target.story)
            else:
                target.objection = {"request": request, "reply": revision.objection or ""}
            self._save_workspace(subject)
            self._refresh_if_current(subject)

        def failed(message: str):
            revising.pop(draft_id, None)
            self._refresh_if_current(subject)
            QMessageBox.warning(self, "Revision failed", message)

        self._run(lambda: engine.revise(subject, image, prompt, story, request, model, draft_id), model, done, failed)
        self._refresh_engine()

    def _on_objection_edit(self, draft_id: str):
        subject, workspace = self._current_workspace()
        draft = workspace.draft(draft_id) if workspace else None
        if subject is None or draft is None or not draft.objection:
            return
        request = draft.objection["request"]
        draft.objection = None
        self._save_workspace(subject)
        self._refresh_engine()
        card = self._draft_cards.get(draft_id)
        if card is not None:
            card.set_request(request)

    def _on_objection_pass(self, draft_id: str):
        subject, workspace = self._current_workspace()
        draft = workspace.draft(draft_id) if workspace else None
        if subject is None or draft is None:
            return
        draft.objection = None
        self._save_workspace(subject)
        self._refresh_engine()

    # -- Shutdown ------------------------------------------------------------------------------
    def closeEvent(self, event):
        self._mod_timer.stop()
        self._flush_all()
        super().closeEvent(event)
