"""
Widgets for the story review window (``gui.py``): the tile table, the image
panel, and the pitch rows and draft cards of the story-engine panel.

Each widget shows the state it is handed and reports edits through signals.
None of them reads or writes a file, so the window owns every save and every
model call. Rows and cards must update in place (``update_from``), never be
rebuilt on refresh: a background call finishing refreshes the panel, and a
rebuild would take focus and unsent text from the field being typed in.
"""

from __future__ import annotations

import os

from PySide6.QtCore import (
    QAbstractTableModel,
    QByteArray,
    QModelIndex,
    QPersistentModelIndex,
    QSize,
    QSortFilterProxyModel,
    Qt,
    Signal,
)
from PySide6.QtGui import QColor, QFont, QIcon, QImageReader, QPainter, QPalette, QPixmap
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPlainTextEdit,
    QPushButton,
    QSizePolicy,
    QTextEdit,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from story_engine import DraftEntry, PitchEntry

THUMB_SIZE = QSize(64, 48)

# Status colors, shared by the tile table and the draft cards.
COLOR_FINAL = "#4caf7a"
COLOR_UNREVIEWED = "#e0a23a"
COLOR_MISSING_STORY = "#d25555"
COLOR_MISSING_IMAGE = "#7f8c8d"
COLOR_REVISED = "#6f9fe0"
COLOR_MUTED = "#8a8a93"


def tile_state(entry: dict, exists: bool) -> str:
    """Classify a tile: ``final``, ``unreviewed`` (story, not final), ``missing_story`` or ``missing_image``."""
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
_STATE_TEXT = {
    "final": "Final",
    "unreviewed": "Story, not final",
    "missing_story": "No story",
    "missing_image": "Image missing",
}
# Sort order for the status column: work still to do first.
_STATE_ORDER = {"missing_story": 0, "unreviewed": 1, "final": 2, "missing_image": 3}


def _swatch(color: str, size: int = 10) -> QPixmap:
    pixmap = QPixmap(size, size)
    pixmap.fill(QColor(color))
    return pixmap


# Stroke icons, drawn in the palette's text color so they suit light and dark themes.
_ICON_PATHS = {
    "edit": '<path d="M9.5 2.5l2 2L5 11H3V9z"/>',
    "close": '<path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/>',
    "duplicate": '<rect x="4.5" y="4.5" width="7" height="7" rx="1"/><path d="M2.5 9.5v-7h7"/>',
    "redraft": '<path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2"/><path d="M10.5 1.5v2.5H8"/>',
    "history": '<circle cx="7" cy="7" r="5"/><path d="M7 4v3l2 1.5"/>',
    "hide": '<path d="M1.5 7s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4-5.5-4-5.5-4z"/><path d="M2 12 12 2"/>',
    "check": '<path d="M2.5 7.5 5.5 10.5 11.5 3.5"/>',
}


def icon(name: str, palette: QPalette) -> QIcon:
    color = palette.color(QPalette.ColorRole.ButtonText).name()
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" '
        f'fill="none" stroke="{color}" stroke-width="1.4" stroke-linecap="round" '
        f'stroke-linejoin="round">{_ICON_PATHS[name]}</svg>'
    )
    renderer = QSvgRenderer(QByteArray(svg.encode()))
    pixmap = QPixmap(28, 28)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    renderer.render(painter)
    painter.end()
    return QIcon(pixmap)


def icon_button(name: str, tooltip: str, parent: QWidget) -> QToolButton:
    button = QToolButton(parent)
    button.setIcon(icon(name, parent.palette()))
    button.setToolTip(tooltip)
    button.setAccessibleName(tooltip)
    button.setAutoRaise(True)
    return button


def set_text_quietly(widget: QLineEdit | QPlainTextEdit | QTextEdit, text: str) -> None:
    """Replace a field's text without firing its change signal, unless it has focus.

    A focused field is being typed in, and its text wins over whatever
    arrived from a save or a background call.
    """
    if widget.hasFocus():
        return
    current = widget.text() if isinstance(widget, QLineEdit) else widget.toPlainText()
    if current == text:
        return
    widget.blockSignals(True)
    if isinstance(widget, QLineEdit):
        widget.setText(text)
    else:
        widget.setPlainText(text)
    widget.blockSignals(False)
    if isinstance(widget, GrowingTextEdit):
        widget.fit()


# ---------------------------------------------------------------------------
# Tile table
# ---------------------------------------------------------------------------
class TileTableModel(QAbstractTableModel):
    """Every tile as a row: thumbnail and name, title, keywords, status.

    ``entry_for(key)`` returns the tile's current metadata entry, so the model
    always shows what the window last saved. Thumbnails load on first display
    and are cached.
    """

    COLUMNS = ("Name", "Title", "Keywords", "")
    SORT_ROLE = Qt.ItemDataRole.UserRole + 1
    KEY_ROLE = Qt.ItemDataRole.UserRole

    def __init__(self, tile_dir: str, keys: list[str], entry_for, parent=None):
        super().__init__(parent)
        self.tile_dir = tile_dir
        self.keys = keys
        self._entry_for = entry_for
        self._thumbs: dict[str, QPixmap] = {}
        self._swatches = {state: _swatch(color) for state, color in _STATE_COLOR.items()}

    def rowCount(self, parent: QModelIndex | QPersistentModelIndex = QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self.keys)

    def columnCount(self, parent: QModelIndex | QPersistentModelIndex = QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self.COLUMNS)

    def headerData(self, section: int, orientation: Qt.Orientation, role: int = Qt.ItemDataRole.DisplayRole):
        if orientation == Qt.Orientation.Horizontal and role == Qt.ItemDataRole.DisplayRole:
            return self.COLUMNS[section]
        return None

    def state(self, key: str) -> str:
        return tile_state(self._entry_for(key), os.path.exists(os.path.join(self.tile_dir, key)))

    def data(self, index: QModelIndex | QPersistentModelIndex, role: int = Qt.ItemDataRole.DisplayRole):
        if not index.isValid():
            return None
        key = self.keys[index.row()]
        entry = self._entry_for(key)
        column = index.column()
        if role == self.KEY_ROLE:
            return key
        if column == 0:
            if role in (Qt.ItemDataRole.DisplayRole, self.SORT_ROLE):
                return os.path.splitext(key)[0]
            if role == Qt.ItemDataRole.DecorationRole:
                return self._thumb(key)
        elif column == 1:
            title = entry.get("title") or ""
            if role == self.SORT_ROLE:
                return title.casefold()
            if role in (Qt.ItemDataRole.DisplayRole, Qt.ItemDataRole.ToolTipRole):
                return title or ("(untitled)" if role == Qt.ItemDataRole.DisplayRole else None)
            if role == Qt.ItemDataRole.FontRole and not title:
                font = QFont()
                font.setItalic(True)
                return font
            if role == Qt.ItemDataRole.ForegroundRole and not title:
                return QColor(COLOR_MUTED)
        elif column == 2:
            text = ", ".join(kw.get("text", "") for kw in entry.get("keywords", []))
            if role in (Qt.ItemDataRole.DisplayRole, Qt.ItemDataRole.ToolTipRole):
                return text
            if role == self.SORT_ROLE:
                return text.casefold()
        elif column == 3:
            state = self.state(key)
            if role == Qt.ItemDataRole.DecorationRole:
                return self._swatches[state]
            if role == Qt.ItemDataRole.ToolTipRole:
                return _STATE_TEXT[state]
            if role == self.SORT_ROLE:
                return _STATE_ORDER[state]
        return None

    def _thumb(self, key: str) -> QPixmap | None:
        if key not in self._thumbs:
            reader = QImageReader(os.path.join(self.tile_dir, key))
            size = reader.size()
            if size.isValid():
                reader.setScaledSize(size.scaled(THUMB_SIZE, Qt.AspectRatioMode.KeepAspectRatio))
            image = reader.read()
            self._thumbs[key] = QPixmap.fromImage(image) if not image.isNull() else QPixmap()
        pixmap = self._thumbs[key]
        return pixmap if not pixmap.isNull() else None

    def row_of(self, key: str) -> int:
        try:
            return self.keys.index(key)
        except ValueError:
            return -1

    def refresh(self, key: str) -> None:
        row = self.row_of(key)
        if row >= 0:
            self.dataChanged.emit(self.index(row, 0), self.index(row, self.columnCount() - 1))

    def add(self, key: str) -> None:
        keys = sorted(self.keys + [key])
        row = keys.index(key)
        self.beginInsertRows(QModelIndex(), row, row)
        self.keys.insert(row, key)
        self.endInsertRows()

    def remove(self, key: str) -> None:
        row = self.row_of(key)
        if row < 0:
            return
        self.beginRemoveRows(QModelIndex(), row, row)
        del self.keys[row]
        self.endRemoveRows()
        self._thumbs.pop(key, None)


class TileFilterProxy(QSortFilterProxyModel):
    """Filters the tile table by free text and by status.

    ``status`` is one of ``all``, ``notfinal``, ``unreviewed`` (a story, not
    final) or ``nostory``.
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self.text = ""
        self.status = "all"
        self.setSortRole(TileTableModel.SORT_ROLE)

    def set_text(self, text: str) -> None:
        self.text = text.strip().casefold()
        self.invalidateFilter()

    def set_status(self, status: str) -> None:
        self.status = status
        self.invalidateFilter()

    def filterAcceptsRow(self, source_row: int, source_parent: QModelIndex | QPersistentModelIndex) -> bool:
        model = self.sourceModel()
        assert isinstance(model, TileTableModel)
        key = model.keys[source_row]
        state = model.state(key)
        if self.status == "notfinal" and state == "final":
            return False
        if self.status == "unreviewed" and state != "unreviewed":
            return False
        if self.status == "nostory" and state != "missing_story":
            return False
        if not self.text:
            return True
        entry = model._entry_for(key)
        haystack = " ".join(
            [key, entry.get("title") or "", *(kw.get("text", "") for kw in entry.get("keywords", []))]
        )
        return self.text in haystack.casefold()


# ---------------------------------------------------------------------------
# Image panel
# ---------------------------------------------------------------------------
class ImagePanel(QLabel):
    """The selected tile's image, scaled to fit. Reports hover for the Ctrl zoom."""

    entered = Signal()
    left = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Ignored)
        self.setMinimumSize(200, 150)
        self.setStyleSheet("background: #111113; color: #8a8a93;")
        self.source = QPixmap()

    def set_image(self, path: str | None) -> None:
        self.source = QPixmap(path) if path and os.path.exists(path) else QPixmap()
        if self.source.isNull():
            self.setPixmap(QPixmap())
            self.setText("Image missing" if path else "")
        self._rescale()

    def _rescale(self) -> None:
        if self.source.isNull():
            return
        self.setPixmap(
            self.source.scaled(
                self.size(), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation
            )
        )

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._rescale()

    def enterEvent(self, event):
        self.entered.emit()
        super().enterEvent(event)

    def leaveEvent(self, event):
        self.left.emit()
        super().leaveEvent(event)


# ---------------------------------------------------------------------------
# Small building blocks
# ---------------------------------------------------------------------------
class CollapsibleSection(QWidget):
    """A header button that folds its body away, with a one-line summary beside the title."""

    def __init__(self, title: str, body: QWidget, open_: bool = False, parent=None):
        super().__init__(parent)
        self.body = body
        self.toggle = QToolButton()
        self.toggle.setText(title)
        self.toggle.setCheckable(True)
        self.toggle.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.toggle.setAutoRaise(True)
        self.toggle.setStyleSheet("QToolButton { font-weight: bold; border: none; }")
        self.toggle.toggled.connect(self._on_toggled)
        self.summary = QLabel()
        self.summary.setStyleSheet(f"color: {COLOR_MUTED};")
        header = QHBoxLayout()
        header.setContentsMargins(0, 0, 0, 0)
        header.addWidget(self.toggle)
        header.addStretch(1)
        header.addWidget(self.summary)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        layout.addLayout(header)
        layout.addWidget(body)
        self.toggle.setChecked(open_)
        self._on_toggled(open_)

    def _on_toggled(self, checked: bool) -> None:
        self.body.setVisible(checked)
        self.toggle.setArrowType(Qt.ArrowType.DownArrow if checked else Qt.ArrowType.RightArrow)


class GrowingTextEdit(QTextEdit):
    """A plain-text editor as tall as its text, so the scroll area around it does the scrolling."""

    def __init__(self, min_height: int = 40, parent=None):
        super().__init__(parent)
        self.setAcceptRichText(False)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._min_height = min_height
        self.document().documentLayout().documentSizeChanged.connect(self.fit)
        self.fit()

    def fit(self, *_args) -> None:
        margins = self.contentsMargins()
        height = int(self.document().size().height()) + margins.top() + margins.bottom() + 4
        self.setFixedHeight(max(self._min_height, height))


# ---------------------------------------------------------------------------
# Pitch row
# ---------------------------------------------------------------------------
class PitchRow(QFrame):
    """One pitch: keep checkbox, seed, text, note to the writer, edit and delete."""

    keptChanged = Signal(str, bool)
    noteChanged = Signal(str, str)
    fieldsEdited = Signal(str, dict)
    deleteRequested = Signal(str)

    def __init__(self, pitch_id: str, parent=None):
        super().__init__(parent)
        self.pitch_id = pitch_id
        self.setFrameShape(QFrame.Shape.StyledPanel)

        self.keep = QCheckBox()
        self.keep.setToolTip("Keep this pitch")
        self.keep.toggled.connect(lambda on: self.keptChanged.emit(self.pitch_id, on))

        self.number = QLabel()
        self.number.setStyleSheet(f"color: {COLOR_MUTED};")
        self.seed = QLabel()
        self.seed.setStyleSheet(f"color: {COLOR_REVISED}; font-weight: bold;")
        self.status = QLabel()
        self.status.setStyleSheet(f"color: {COLOR_MUTED};")
        self.origin = QLabel()
        self.origin.setStyleSheet(f"color: {COLOR_MUTED}; font-size: 11px;")
        meta = QHBoxLayout()
        meta.setSpacing(8)
        for widget in (self.number, self.seed, self.status):
            meta.addWidget(widget)
        meta.addStretch(1)
        meta.addWidget(self.origin)

        self.pitch_label = QLabel()
        self.pitch_label.setWordWrap(True)
        self.hook_label = QLabel()
        self.hook_label.setWordWrap(True)
        self.hook_label.setStyleSheet("color: palette(placeholder-text);")
        self.anchor_label = QLabel()
        self.anchor_label.setWordWrap(True)
        self.anchor_label.setStyleSheet(f"color: {COLOR_MUTED};")

        # Edit mode swaps the labels for fields.
        self.editors = QWidget()
        form = QGridLayout(self.editors)
        form.setContentsMargins(0, 0, 0, 0)
        self.fields: dict[str, QLineEdit] = {}
        for row, name in enumerate(("seed", "pitch", "hook", "anchor")):
            form.addWidget(QLabel(name.capitalize()), row, 0)
            edit = QLineEdit()
            form.addWidget(edit, row, 1)
            self.fields[name] = edit
        self.editors.hide()

        self.note = GrowingTextEdit(min_height=28)
        self.note.setPlaceholderText("Note to the writer (optional)")
        self.note.textChanged.connect(lambda: self.noteChanged.emit(self.pitch_id, self.note.toPlainText()))

        text_column = QVBoxLayout()
        text_column.setSpacing(3)
        text_column.addLayout(meta)
        for widget in (self.pitch_label, self.hook_label, self.anchor_label, self.editors, self.note):
            text_column.addWidget(widget)

        self.edit_button = icon_button("edit", "Edit pitch", self)
        self.edit_button.clicked.connect(self._on_edit_clicked)
        self.delete_button = icon_button("close", "Delete pitch", self)
        self.delete_button.clicked.connect(lambda: self.deleteRequested.emit(self.pitch_id))
        buttons = QVBoxLayout()
        buttons.addWidget(self.edit_button)
        buttons.addWidget(self.delete_button)
        buttons.addStretch(1)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(8, 6, 8, 6)
        layout.addWidget(self.keep, alignment=Qt.AlignmentFlag.AlignTop)
        layout.addLayout(text_column, stretch=1)
        layout.addLayout(buttons)

    def editing(self) -> bool:
        return self.editors.isVisible()

    def start_editing(self) -> None:
        if not self.editing():
            self._on_edit_clicked()
        self.fields["pitch"].setFocus()

    def _on_edit_clicked(self) -> None:
        if self.editing():
            self.fieldsEdited.emit(self.pitch_id, {k: e.text().strip() for k, e in self.fields.items()})
            self.editors.hide()
            self.edit_button.setIcon(icon("edit", self.palette()))
            self.edit_button.setToolTip("Edit pitch")
        else:
            self.fields["seed"].setText(self.seed.text())
            self.fields["pitch"].setText(self.pitch_label.text())
            self.fields["hook"].setText(self.hook_label.text().removeprefix("Hook: "))
            self.fields["anchor"].setText(self.anchor_label.text().removeprefix("Anchor: "))
            self.editors.show()
            self.edit_button.setIcon(icon("check", self.palette()))
            self.edit_button.setToolTip("Save edits")
        for label in (self.pitch_label, self.hook_label, self.anchor_label):
            label.setVisible(not self.editing())

    def update_from(self, pitch: PitchEntry, number: int, status: str, locked: bool) -> None:
        self.keep.blockSignals(True)
        self.keep.setChecked(pitch.kept)
        self.keep.blockSignals(False)
        self.number.setText(str(number))
        self.seed.setText(pitch.seed)
        self.status.setText(status)
        self.origin.setText(pitch.source if pitch.source != "hand" else "written by hand")
        self.pitch_label.setText(pitch.pitch)
        self.hook_label.setText(f"Hook: {pitch.hook}")
        self.anchor_label.setText(f"Anchor: {pitch.anchor}")
        set_text_quietly(self.note, pitch.note)
        self.note.setReadOnly(locked)
        for label in (self.pitch_label, self.hook_label, self.anchor_label, self.seed, self.number):
            label.setEnabled(pitch.kept)
        for widget in (self.keep, self.edit_button, self.delete_button):
            widget.setEnabled(not locked)


# ---------------------------------------------------------------------------
# Draft card
# ---------------------------------------------------------------------------
class DraftCard(QFrame):
    """One draft: its text, a revision request, and the actions on it.

    The story sits above a stretch, so when the grid gives two cards in a row
    the same height the shorter one's spare space falls between its story and
    its controls, and the controls of both line up.
    """

    textEdited = Signal(str, str)
    reviseRequested = Signal(str, str)
    chooseRequested = Signal(str)
    dropToggled = Signal(str)
    duplicateRequested = Signal(str)
    redraftRequested = Signal(str)
    historyRequested = Signal(str)
    hideRequested = Signal(str)
    deleteRequested = Signal(str)
    objectionEditRequested = Signal(str)
    objectionPassed = Signal(str)

    def __init__(self, draft_id: str, parent=None):
        super().__init__(parent)
        self.draft_id = draft_id
        self.setObjectName("draftCard")
        self.setFrameShape(QFrame.Shape.StyledPanel)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)

        self.title = QLabel()
        self.title.setStyleSheet("font-weight: bold;")
        self.form = QLabel()
        self.constraint = QLabel()
        self.constraint.setStyleSheet("color: #e8c07a; border: 1px solid #7a6334; border-radius: 3px; padding: 0 4px;")
        self.state = QLabel()
        header = QHBoxLayout()
        header.addWidget(self.title)
        header.addWidget(self.form)
        header.addWidget(self.constraint)
        header.addStretch(1)
        header.addWidget(self.state)

        self.pitch = QLabel()
        self.pitch.setWordWrap(True)
        self.pitch.setStyleSheet(f"color: {COLOR_MUTED};")

        self.objection = QFrame()
        self.objection.setStyleSheet("QFrame { border: 1px solid #7a6334; border-radius: 3px; }")
        self.objection_request = QLabel()
        self.objection_request.setWordWrap(True)
        self.objection_request.setStyleSheet("color: #e8c07a; border: none;")
        self.objection_reply = QLabel()
        self.objection_reply.setWordWrap(True)
        self.objection_reply.setStyleSheet("border: none;")
        edit_request = QPushButton("Edit request")
        edit_request.clicked.connect(lambda: self.objectionEditRequested.emit(self.draft_id))
        pass_as_is = QPushButton("Pass as is")
        pass_as_is.clicked.connect(lambda: self.objectionPassed.emit(self.draft_id))
        objection_buttons = QHBoxLayout()
        objection_buttons.addWidget(edit_request)
        objection_buttons.addWidget(pass_as_is)
        objection_buttons.addStretch(1)
        objection_layout = QVBoxLayout(self.objection)
        objection_layout.addWidget(self.objection_request)
        objection_layout.addWidget(self.objection_reply)
        objection_layout.addLayout(objection_buttons)

        self.revised = QLabel()
        self.revised.setWordWrap(True)
        self.revised.setStyleSheet(f"color: {COLOR_REVISED};")

        self.text = GrowingTextEdit(min_height=60)
        self.text.setFrameShape(QFrame.Shape.NoFrame)
        self.text.textChanged.connect(lambda: self.textEdited.emit(self.draft_id, self.text.toPlainText()))

        self.pending = QLabel()
        self.pending.setWordWrap(True)
        self.pending.setStyleSheet(f"color: {COLOR_REVISED};")

        self.request = QLineEdit()
        self.request.setMinimumWidth(80)
        self.request.setPlaceholderText("Revision request")
        self.request.textChanged.connect(self._update_revise_button)
        self.request.returnPressed.connect(self._on_revise)
        self.revise_button = QPushButton("Revise")
        self.revise_button.clicked.connect(self._on_revise)
        request_row = QHBoxLayout()
        request_row.addWidget(self.request, stretch=1)
        request_row.addWidget(self.revise_button)

        self.choose_button = QPushButton("Choose")
        self.choose_button.clicked.connect(lambda: self.chooseRequested.emit(self.draft_id))
        self.drop_button = QPushButton("Drop")
        self.drop_button.clicked.connect(lambda: self.dropToggled.emit(self.draft_id))
        footer = QHBoxLayout()
        footer.addWidget(self.choose_button)
        footer.addWidget(self.drop_button)
        footer.addStretch(1)
        self.duplicate_button = icon_button("duplicate", "Duplicate", self)
        self.duplicate_button.clicked.connect(lambda: self.duplicateRequested.emit(self.draft_id))
        self.redraft_button = icon_button("redraft", "Redraft from the same pitch", self)
        self.redraft_button.clicked.connect(lambda: self.redraftRequested.emit(self.draft_id))
        self.history_button = icon_button("history", "Earlier versions", self)
        self.history_button.clicked.connect(lambda: self.historyRequested.emit(self.draft_id))
        hide_button = icon_button("hide", "Hide", self)
        hide_button.clicked.connect(lambda: self.hideRequested.emit(self.draft_id))
        self.delete_button = icon_button("close", "Delete", self)
        self.delete_button.clicked.connect(lambda: self.deleteRequested.emit(self.draft_id))
        for button in (self.duplicate_button, self.redraft_button, self.history_button, hide_button, self.delete_button):
            footer.addWidget(button)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 6, 8, 6)
        layout.setSpacing(5)
        layout.addLayout(header)
        layout.addWidget(self.pitch)
        layout.addWidget(self.objection)
        layout.addWidget(self.revised)
        layout.addWidget(self.text)
        layout.addStretch(1)
        layout.addWidget(self.pending)
        layout.addLayout(request_row)
        layout.addLayout(footer)

        self._pending = False
        self._locked = False

    def _update_revise_button(self) -> None:
        self.revise_button.setEnabled(bool(self.request.text().strip()) and not self._pending and not self._locked)

    def _on_revise(self) -> None:
        request = self.request.text().strip()
        if request and not self._pending and not self._locked:
            self.reviseRequested.emit(self.draft_id, request)

    def update_from(
        self,
        draft: DraftEntry,
        number: int,
        pitch_text: str,
        chosen: bool,
        pending: str | None,
        locked: bool,
        can_redraft: bool,
    ) -> None:
        """Show ``draft``. ``pending`` is an in-flight revision request; ``locked`` a Final chosen draft."""
        self._pending = pending is not None
        self._locked = locked
        self.title.setText(f"Draft {number}")
        self.form.setText(draft.form)
        self.constraint.setText(draft.constraint or "")
        self.constraint.setVisible(bool(draft.constraint))
        if chosen:
            state, color = "chosen", COLOR_FINAL
        elif draft.objection:
            state, color = "objection", "#e8c07a"
        elif draft.dropped:
            state, color = "dropped", COLOR_MUTED
        elif draft.last_request() is not None:
            state, color = "revised", COLOR_REVISED
        else:
            state, color = "", COLOR_MUTED
        self.state.setText(state)
        self.state.setStyleSheet(f"color: {color};")
        border = COLOR_FINAL if chosen else "palette(mid)"
        self.setStyleSheet(f"#draftCard {{ border: 1px solid {border}; border-radius: 4px; }}")
        self.pitch.setText(pitch_text)

        self.objection.setVisible(bool(draft.objection))
        if draft.objection:
            self.objection_request.setText(f"Writer's reply to: \"{draft.objection['request']}\"")
            self.objection_reply.setText(draft.objection["reply"])
        request = draft.last_request()
        self.revised.setVisible(request is not None and not draft.objection)
        self.revised.setText(f"Revised: \"{request}\"" if request else "")

        set_text_quietly(self.text, draft.story)
        self.text.setReadOnly(locked)
        for widget in (self.title, self.form, self.pitch, self.text):
            widget.setEnabled(not draft.dropped or chosen)

        self.pending.setVisible(self._pending)
        self.pending.setText(f"Revising: \"{pending}\"" if pending else "")
        self.request.setEnabled(not locked)
        self._update_revise_button()
        self.choose_button.setText("Chosen" if chosen else "Choose")
        self.choose_button.setEnabled(not chosen and not locked)
        self.drop_button.setText("Restore" if draft.dropped else "Drop")
        self.redraft_button.setEnabled(can_redraft)
        self.history_button.setEnabled(bool(draft.history))
        self.history_button.setToolTip(f"Earlier versions ({len(draft.history)})")
        self.delete_button.setEnabled(not locked)

    def take_request(self) -> str:
        """Clear the request field, returning what it held."""
        text = self.request.text()
        self.request.clear()
        return text

    def set_request(self, text: str) -> None:
        self.request.setText(text)
        self.request.setFocus()


class DraftChips(QWidget):
    """Numbered toggle buttons that show or hide each draft card."""

    toggled = Signal(str, bool)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._layout = QHBoxLayout(self)
        self._layout.setContentsMargins(0, 0, 0, 0)
        self._layout.setSpacing(3)

    def set_drafts(self, drafts: list[tuple[str, int, bool, str]]) -> None:
        """``drafts``: ``(id, number, shown, state)`` in list order; state is ``chosen``, ``dropped`` or empty."""
        while self._layout.count():
            item = self._layout.takeAt(0)
            widget = item.widget() if item else None
            if widget is not None:
                widget.deleteLater()
        for draft_id, number, shown, state in drafts:
            chip = QToolButton()
            chip.setText(str(number))
            chip.setCheckable(True)
            chip.setChecked(shown)
            chip.setMinimumWidth(28)
            chip.setToolTip(f"Draft {number}" + (f", {state}" if state else ""))
            if state == "chosen":
                chip.setStyleSheet(f"QToolButton {{ border: 1px solid {COLOR_FINAL}; border-radius: 3px; }}")
            elif state == "dropped":
                chip.setStyleSheet(f"QToolButton {{ color: {COLOR_MUTED}; }}")
            chip.toggled.connect(lambda on, d=draft_id: self.toggled.emit(d, on))
            self._layout.addWidget(chip)


class HistoryDialog(QDialog):
    """A draft's earlier versions, with a button to restore one."""

    def __init__(self, draft: DraftEntry, number: int, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"Draft {number}: earlier versions")
        self.resize(640, 480)
        self.chosen_text: str | None = None
        self.list = QListWidget()
        versions = [("Current", draft.story)] + [
            (f"{v.get('time', '')}, replaced by {v.get('reason', '')}", v["story"]) for v in reversed(draft.history)
        ]
        for label, text in versions:
            item = QListWidgetItem(label)
            item.setData(Qt.ItemDataRole.UserRole, text)
            self.list.addItem(item)
        self.preview = QPlainTextEdit()
        self.preview.setReadOnly(True)
        self.list.currentItemChanged.connect(
            lambda item, _prev: self.preview.setPlainText(item.data(Qt.ItemDataRole.UserRole) if item else "")
        )
        buttons = QDialogButtonBox()
        restore = buttons.addButton("Restore this version", QDialogButtonBox.ButtonRole.AcceptRole)
        buttons.addButton(QDialogButtonBox.StandardButton.Close)
        restore.clicked.connect(self._restore)
        buttons.rejected.connect(self.reject)
        layout = QVBoxLayout(self)
        layout.addWidget(self.list, stretch=1)
        layout.addWidget(self.preview, stretch=2)
        layout.addWidget(buttons)
        self.list.setCurrentRow(min(1, self.list.count() - 1))

    def _restore(self) -> None:
        item = self.list.currentItem()
        if item is not None and self.list.currentRow() > 0:
            self.chosen_text = item.data(Qt.ItemDataRole.UserRole)
            self.accept()
