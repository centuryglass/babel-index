"""
The weight report and tuning window: how each seed, seed kind, form and
constraint has fared, with its weight editable in place.

Opened from the review GUI's Story engine menu. The report counts come from
``story_engine.stats.tally`` over every workspace in the tile directory's
``story_traces/``; ``save`` writes the edited lists back to the
``data/story_*.json`` files through ``story_engine.options.save_options``,
and the caller swaps the saved lists into the running engine.

Edits are held in copies of the option sets until Save, so Close discards
them. A list the engine draws from has to keep one drawable entry, since
``Engine.draft`` indexes the first draw: ``_drawable`` guards that.
"""

from __future__ import annotations

import glob
import json
import os
from dataclasses import dataclass

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFormLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from babel_index_review import story_frame
from story_engine import Option, OptionSet, TraceLog, Workspace
from story_engine.options import save_options
from story_engine.stats import Report, Row, tally

LIST_NAMES = ("seeds", "forms", "constraints")
HEADERS = ["Weight", "Used", "Kept", "Kept %", "Drafted", "Chosen", "Accepted", "Accepted %", "Discarded", "Edited"]
HELP = {
    "Used": "Seeds: pitches made from it. Forms and constraints: drafts written with it.",
    "Kept": "Pitches that survived pitch review (seeds only).",
    "Drafted": "Pitches that have a draft (seeds only).",
    "Chosen": "Drafts that were ever picked as a tile's story.",
    "Accepted": "Drafts whose story is marked Final.",
    "Accepted %": "Accepted out of Used.",
    "Discarded": "Chosen drafts whose story was cleared.",
    "Edited": "Accepted drafts changed by hand after they were chosen.",
}
WEIGHT_COLUMN = 1  # column 0 is the name


def load_subjects(tile_dir: str) -> list[tuple[Workspace, list[dict]]]:
    """Every saved workspace under the tile directory, with its trace events.

    Reads files only. A tile that has a trace but no workspace file has not
    been opened since workspaces were added, and is left out.
    """
    directory = os.path.join(tile_dir, story_frame.TRACE_DIR)
    trace = TraceLog(directory)
    subjects = []
    for path in sorted(glob.glob(os.path.join(directory, "*.json"))):
        subject = os.path.splitext(os.path.basename(path))[0]
        try:
            with open(path, encoding="utf-8") as file:
                workspace = Workspace.from_json(json.load(file))
        except (OSError, ValueError, TypeError, KeyError):
            continue
        subjects.append((workspace, trace.events(subject)))
    return subjects


class _SortItem(QTableWidgetItem):
    """A cell that sorts by a number but shows text."""

    def __init__(self, text: str, key: float):
        super().__init__(text)
        self.key = key
        self.setFlags(self.flags() & ~Qt.ItemFlag.ItemIsEditable)
        self.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)

    def __lt__(self, other: QTableWidgetItem) -> bool:
        return self.key < getattr(other, "key", 0)


def _cell(value: int | None) -> _SortItem:
    return _SortItem("-" if value is None else str(value), -1 if value is None else value)


def _percent(rate: float | None) -> _SortItem:
    return _SortItem("-" if rate is None else f"{rate:.0%}", -1 if rate is None else rate)


def _format_weight(weight: float) -> str:
    return f"{weight:g}"


def _drawable(option_set: OptionSet) -> bool:
    return any(o.weight > 0 and option_set.kind_weights.get(o.kind, 0) > 0 for o in option_set.options)


class _EntryDialog(QDialog):
    """Name, description, weight and (for seeds) kind of a new entry."""

    def __init__(self, title: str, kinds: list[str] | None, parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(480, 260)
        self.name_edit = QLineEdit()
        self.description_edit = QPlainTextEdit()
        self.weight_spin = QDoubleSpinBox()
        self.weight_spin.setRange(0, 1000)
        self.weight_spin.setSingleStep(0.1)
        self.weight_spin.setValue(1)
        self.kind_combo = QComboBox()
        for kind in kinds or []:
            self.kind_combo.addItem(kind)
        form = QFormLayout()
        form.addRow("Name", self.name_edit)
        form.addRow("Description", self.description_edit)
        if kinds:
            form.addRow("Kind", self.kind_combo)
        form.addRow("Weight", self.weight_spin)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout = QVBoxLayout(self)
        layout.addLayout(form)
        layout.addWidget(buttons)

    def option(self) -> Option:
        return Option(
            self.name_edit.text().strip(),
            self.description_edit.toPlainText().strip(),
            self.weight_spin.value(),
            self.kind_combo.currentText() if self.kind_combo.count() else "",
        )


class _ListTab(QWidget):
    """One list's table of options (and, for seeds, a table of kinds) with an Add button."""

    def __init__(self, label: str, option_set: OptionSet, owner: "WeightsDialog"):
        super().__init__()
        self.label = label
        self.option_set = option_set
        self.owner = owner
        self.rows: dict[str, Row] = {}
        self.kind_rows: dict[str, Row] = {}
        self._filling = False
        layout = QVBoxLayout(self)
        self.kind_table: QTableWidget | None = None
        if len(option_set.kind_weights) > 1 or "" not in option_set.kind_weights:
            layout.addWidget(QLabel("Kinds: a draw picks a kind by its weight first, then an entry within it."))
            self.kind_table = self._table()
            self.kind_table.setMaximumHeight(30 * (len(option_set.kind_weights) + 1) + 8)
            self.kind_table.itemChanged.connect(self._on_kind_changed)
            layout.addWidget(self.kind_table)
        self.table = self._table()
        self.table.itemChanged.connect(self._on_changed)
        layout.addWidget(self.table, stretch=1)
        add = QPushButton("Add entry...")
        add.clicked.connect(self._add)
        row = QHBoxLayout()
        row.addWidget(add)
        row.addStretch(1)
        layout.addLayout(row)

    def _table(self) -> QTableWidget:
        table = QTableWidget()
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.verticalHeader().hide()
        return table

    def _fill(self, table: QTableWidget, rows: list[Row], weights: dict[str, float], kinds: dict[str, str] | None):
        headers = ["Name"] + (["Kind"] if kinds is not None else []) + HEADERS
        self._filling = True
        table.setSortingEnabled(False)
        table.clear()
        table.setColumnCount(len(headers))
        table.setHorizontalHeaderLabels(headers)
        table.setRowCount(len(rows))
        offset = 1 if kinds is not None else 0
        for i, row in enumerate(rows):
            name = QTableWidgetItem(row.name)
            name.setFlags(name.flags() & ~Qt.ItemFlag.ItemIsEditable)
            table.setItem(i, 0, name)
            if kinds is not None:
                kind = _SortItem(kinds.get(row.name, ""), 0)
                kind.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
                table.setItem(i, 1, kind)
            weight = _SortItem(_format_weight(weights[row.name]), weights[row.name])
            weight.setFlags(weight.flags() | Qt.ItemFlag.ItemIsEditable)
            weight.setToolTip("Double-click to edit. 0 removes it from draws.")
            table.setItem(i, 1 + offset, weight)
            cells = [
                _cell(row.used),
                _cell(row.kept),
                _percent(row.rate(row.kept)),
                _cell(row.drafted),
                _cell(row.chosen),
                _cell(row.accepted),
                _percent(row.rate(row.accepted)),
                _cell(row.discarded),
                _cell(row.edited),
            ]
            for j, cell in enumerate(cells):
                table.setItem(i, 2 + offset + j, cell)
        for column, header in enumerate(headers):
            item = table.horizontalHeaderItem(column)
            if item is not None and header in HELP:
                item.setToolTip(HELP[header])
        table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        for column in range(1, len(headers)):
            table.horizontalHeader().setSectionResizeMode(column, QHeaderView.ResizeMode.ResizeToContents)
        table.setSortingEnabled(True)
        self._filling = False

    def show_report(self, rows: list[Row], kind_rows: list[Row] | None = None) -> None:
        self.rows = {r.name: r for r in rows}
        self.kind_rows = {r.name: r for r in kind_rows or []}
        self._refresh()

    def _refresh(self) -> None:
        by_name = {o.name: o for o in self.option_set.options}
        has_kinds = self.kind_table is not None
        blank = (lambda name: Row(name, kept=0, drafted=0)) if has_kinds else Row
        order = [self.rows.get(o.name) or blank(o.name) for o in self.option_set.options]
        if has_kinds:
            self._fill(self.table, order, {n: o.weight for n, o in by_name.items()}, {n: o.kind for n, o in by_name.items()})
            self._fill(self.kind_table, list(self.kind_rows.values()), self.option_set.kind_weights, None)
        else:
            self._fill(self.table, order, {n: o.weight for n, o in by_name.items()}, None)

    def _weight(self, item: QTableWidgetItem) -> float | None:
        try:
            weight = float(item.text())
        except ValueError:
            weight = -1
        if weight < 0:
            QMessageBox.warning(self, "Weight", "A weight is a number, zero or more.")
            return None
        return weight

    def _on_changed(self, item: QTableWidgetItem) -> None:
        if self._filling:
            return
        offset = 1 if self.kind_table is not None else 0
        if item.column() != 1 + offset:
            return
        name = self.table.item(item.row(), 0).text()
        weight = self._weight(item)
        if weight is not None:
            self.option_set = self.option_set.with_weights({name: weight})
            self.owner.changed()
        self._refresh()

    def _on_kind_changed(self, item: QTableWidgetItem) -> None:
        if self._filling or item.column() != 1:
            return
        kind = self.kind_table.item(item.row(), 0).text()
        weight = self._weight(item)
        if weight is not None:
            self.option_set = self.option_set.with_weights({}, {kind: weight})
            self.owner.changed()
        self._refresh()

    def _add(self) -> None:
        kinds = list(self.option_set.kind_weights) if self.kind_table is not None else None
        dialog = _EntryDialog(f"Add to {self.label}", kinds, self)
        while dialog.exec():
            option = dialog.option()
            if not option.name or not option.description:
                QMessageBox.warning(self, "Add entry", "An entry needs a name and a description.")
            elif option.name.casefold() in {o.name.casefold() for o in self.option_set.options}:
                QMessageBox.warning(self, "Add entry", f"{option.name!r} is already in the list.")
            else:
                options = list(self.option_set.options)
                # Entries of one kind stay together, as the file keeps them.
                last = max((i for i, o in enumerate(options) if o.kind == option.kind), default=len(options) - 1)
                options.insert(last + 1, option)
                self.option_set = OptionSet(options, self.option_set.kind_weights)
                self.owner.changed()
                self._refresh()
                return


@dataclass
class _Paths:
    seeds: str = story_frame.SEEDS_PATH
    forms: str = story_frame.FORMS_PATH
    constraints: str = story_frame.CONSTRAINTS_PATH


class WeightsDialog(QDialog):
    """The report and tuning window. After ``exec``, ``saved`` holds the lists written, by name."""

    def __init__(
        self,
        report: Report,
        seeds: OptionSet,
        forms: OptionSet,
        constraints: OptionSet | None,
        parent=None,
        paths: _Paths | None = None,
    ):
        super().__init__(parent)
        self.setWindowTitle("Story engine: weight report and tuning")
        self.resize(1000, 640)
        self.paths = paths or _Paths()
        self.original = {"seeds": seeds, "forms": forms, "constraints": constraints}
        self.saved: dict[str, OptionSet] = {}
        self.tabs: dict[str, _ListTab] = {}
        tabs = QTabWidget()
        for name, option_set, rows, kind_rows in (
            ("seeds", seeds, report.seeds, report.kinds),
            ("forms", forms, report.forms, None),
            ("constraints", constraints, report.constraints, None),
        ):
            if option_set is None:
                continue
            tab = _ListTab(name.capitalize(), option_set, self)
            tab.show_report(rows, kind_rows)
            self.tabs[name] = tab
            tabs.addTab(tab, name.capitalize())
        summary = QLabel(
            f"Counted over {report.subjects} tile workspaces. A rate beside a small count says little: "
            "check Used before trusting it. A weight is relative (2 is drawn twice as often as 1) and 0 "
            "removes the entry from draws but leaves it available by hand."
        )
        summary.setWordWrap(True)
        self.buttons = QDialogButtonBox()
        self.save_button = self.buttons.addButton("Save", QDialogButtonBox.ButtonRole.AcceptRole)
        self.buttons.addButton(QDialogButtonBox.StandardButton.Close)
        self.save_button.setEnabled(False)
        self.save_button.clicked.connect(self.save)
        self.buttons.rejected.connect(self.reject)
        layout = QVBoxLayout(self)
        layout.addWidget(summary)
        layout.addWidget(tabs, stretch=1)
        layout.addWidget(self.buttons)

    def pending(self) -> dict[str, OptionSet]:
        """The lists that differ from what was loaded."""
        return {n: t.option_set for n, t in self.tabs.items() if t.option_set != self.original[n]}

    def changed(self) -> None:
        self.save_button.setEnabled(bool(self.pending()))

    def save(self) -> bool:
        """Write each changed list. Refuses a list nothing can be drawn from."""
        pending = self.pending()
        for name, option_set in pending.items():
            if name != "constraints" and not _drawable(option_set):
                QMessageBox.warning(self, "Save", f"The {name} list would have nothing left to draw.")
                return False
        for name, option_set in pending.items():
            try:
                save_options(getattr(self.paths, name), option_set)
            except OSError as err:
                QMessageBox.critical(self, "Save failed", f"{getattr(self.paths, name)}: {err}")
                return False
            self.saved[name] = option_set
            self.original[name] = option_set
        self.changed()
        self.accept()
        return True

    def reject(self) -> None:
        if self.pending():
            answer = QMessageBox.question(self, "Unsaved changes", "Close and discard the unsaved changes?")
            if answer != QMessageBox.StandardButton.Yes:
                return
        super().reject()


def open_dialog(tile_dir: str, seeds: OptionSet, forms: OptionSet, constraints: OptionSet | None, parent=None):
    """Show the window over ``tile_dir``'s workspaces. Returns the dialog after it closes."""
    report = tally(load_subjects(tile_dir), seeds, forms, constraints)
    dialog = WeightsDialog(report, seeds, forms, constraints, parent)
    dialog.exec()
    return dialog
