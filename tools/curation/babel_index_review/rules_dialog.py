"""
The lint rules window: every rule in the tile directory's
``story_rules.json``, edited by hand or rewritten from collection memory.

Opened from the review GUI's Story engine menu. Edits are held in a copy of
the rule set until Save, so Close discards them, the same as the weight
report. **Update from memory** runs ``story_rules.derive_rules`` through the
window's ``run`` callback (the review window's thread pool), and its result
lands in that copy for review before Save.

Ownership follows ``story_engine.rules``: an edit makes a rule ``hand``, and
deleting an ``llm`` rule records its description as dismissed. The Fails
column counts the Final stories each check fails, so a check too broad to be
useful shows before it is saved.
"""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Callable

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QStackedWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from babel_index_review import collection_memory, story_rules
from story_engine.rules import Rule, RuleSet, describe_check, run_check, validate_check
from story_engine.workspace import new_id, now

HEADERS = ["Source", "Description", "Check", "Fails"]
CHECK_LABELS = {None: "No check", "words": "Words", "opener": "Opener", "regex": "Regex", "word_count": "Word count"}


class _RuleEditor(QDialog):
    """A rule's description and check, one form per check kind."""

    def __init__(self, title: str, rule: Rule | None, parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(560, 360)
        self.description = QPlainTextEdit()
        self.description.setPlaceholderText("An instruction the writer reads, e.g. Don't use the name Vane or Vance.")
        self.kind = QComboBox()
        for kind, label in CHECK_LABELS.items():
            self.kind.addItem(label, kind)
        self.words = QPlainTextEdit()
        self.words.setPlaceholderText("One word or phrase per line")
        self.case_sensitive = QCheckBox("Case-sensitive")
        self.openers = QPlainTextEdit()
        self.openers.setPlaceholderText("One opening word sequence per line")
        self.pattern = QLineEdit()
        self.ignore_case = QCheckBox("Ignore case")
        self.max_words = QSpinBox()
        self.max_words.setRange(1, 10000)
        self.max_words.setValue(150)

        self.pages = QStackedWidget()
        self.pages.addWidget(QLabel("The rule reaches the writer's prompt, and no draft is linted against it."))
        words_page = QWidget()
        words_layout = QVBoxLayout(words_page)
        words_layout.setContentsMargins(0, 0, 0, 0)
        words_layout.addWidget(self.words)
        words_layout.addWidget(self.case_sensitive)
        self.pages.addWidget(words_page)
        self.pages.addWidget(self.openers)
        regex_page = QWidget()
        regex_layout = QVBoxLayout(regex_page)
        regex_layout.setContentsMargins(0, 0, 0, 0)
        regex_layout.addWidget(self.pattern)
        regex_layout.addWidget(self.ignore_case)
        regex_layout.addStretch(1)
        self.pages.addWidget(regex_page)
        self.pages.addWidget(self.max_words)
        self.kind.currentIndexChanged.connect(self.pages.setCurrentIndex)

        if rule is not None:
            self.description.setPlainText(rule.description)
            check = rule.check or {}
            self.kind.setCurrentIndex(max(0, self.kind.findData(check.get("kind"))))
            self.words.setPlainText("\n".join(check.get("words", [])))
            self.case_sensitive.setChecked(bool(check.get("case_sensitive")))
            self.openers.setPlainText("\n".join(check.get("openers", [])))
            self.pattern.setText(check.get("pattern", ""))
            self.ignore_case.setChecked(bool(check.get("ignore_case")))
            self.max_words.setValue(check.get("max", 150))

        form = QFormLayout()
        form.addRow("Description", self.description)
        form.addRow("Check", self.kind)
        form.addRow("", self.pages)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self._accept)
        buttons.rejected.connect(self.reject)
        layout = QVBoxLayout(self)
        layout.addLayout(form)
        layout.addWidget(buttons)
        self.result_rule: tuple[str, dict | None] | None = None

    def _check(self) -> dict | None:
        kind = self.kind.currentData()
        lines = lambda edit: [line.strip() for line in edit.toPlainText().splitlines() if line.strip()]  # noqa: E731
        if kind == "words":
            return {"kind": kind, "words": lines(self.words), "case_sensitive": self.case_sensitive.isChecked()}
        if kind == "opener":
            return {"kind": kind, "openers": lines(self.openers)}
        if kind == "regex":
            return {"kind": kind, "pattern": self.pattern.text(), "ignore_case": self.ignore_case.isChecked()}
        if kind == "word_count":
            return {"kind": kind, "max": self.max_words.value()}
        return None

    def _accept(self) -> None:
        description = " ".join(self.description.toPlainText().split())
        if not description:
            QMessageBox.warning(self, "Rule", "A rule needs a description.")
            return
        try:
            check = validate_check(self._check())
        except ValueError as err:
            QMessageBox.warning(self, "Rule", str(err))
            return
        self.result_rule = (description, check)
        self.accept()


class RulesDialog(QDialog):
    """The rules window. After ``exec``, ``saved`` is True when Save wrote the file.

    ``run(fn, model, on_done, on_error)`` runs a blocking call off the GUI
    thread; ``model`` is the deriving model's id, ``model_label`` its name.
    """

    def __init__(
        self,
        tile_dir: str,
        run: Callable,
        model: str,
        model_label: str,
        parent=None,
    ):
        super().__init__(parent)
        self.setWindowTitle("Story engine: lint rules")
        self.resize(1100, 640)
        self.tile_dir = tile_dir
        self.run = run
        self.model = model
        self.original = story_rules.load(tile_dir)
        self.rules = RuleSet(list(self.original.rules), list(self.original.dismissed))
        self.saved = False
        self._deriving = False
        final = story_rules.final_stories(tile_dir)
        self._stories = list(final.values())
        self._hits: dict[str, int] = {}  # check JSON -> stories failed

        remembered = len(final.keys() & collection_memory.load(tile_dir).keys())
        summary = QLabel(
            "Every rule's description goes into the writer's prompt (Engine settings can turn that off), and "
            "every draft is linted against the rules with a check. Update from memory rewrites the rules marked "
            f"llm from collection memory's report; hand rules stay. Memory holds {remembered} of "
            f"{len(self._stories)} Final stories."
            + (" Run python -m babel_index_review.collection_memory to tag the rest." if remembered < len(self._stories) else "")
        )
        summary.setWordWrap(True)

        self.table = QTableWidget()
        self.table.setColumnCount(len(HEADERS))
        self.table.setHorizontalHeaderLabels(HEADERS)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setWordWrap(True)
        self.table.verticalHeader().hide()
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Interactive)
        header.resizeSection(2, 360)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeaderItem(3).setToolTip("Final stories in the collection this rule's check fails")
        self.table.doubleClicked.connect(lambda _index: self._edit())
        self.table.itemSelectionChanged.connect(self._update_buttons)

        add = QPushButton("Add...")
        add.clicked.connect(self._add)
        self.edit_button = QPushButton("Edit...")
        self.edit_button.clicked.connect(self._edit)
        self.delete_button = QPushButton("Delete")
        self.delete_button.clicked.connect(self._delete)
        self.derive_button = QPushButton()
        self.derive_button.setToolTip(f"Model: {model_label}. Change it in Engine settings' Rules model.")
        self.derive_button.clicked.connect(self._derive)
        row = QHBoxLayout()
        for button in (add, self.edit_button, self.delete_button):
            row.addWidget(button)
        row.addStretch(1)
        row.addWidget(self.derive_button)

        self.buttons = QDialogButtonBox()
        self.save_button = self.buttons.addButton("Save", QDialogButtonBox.ButtonRole.AcceptRole)
        self.buttons.addButton(QDialogButtonBox.StandardButton.Close)
        self.save_button.clicked.connect(self.save)
        self.buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(summary)
        layout.addWidget(self.table, stretch=1)
        layout.addLayout(row)
        layout.addWidget(self.buttons)
        self._refresh()

    # -- Display -------------------------------------------------------------------
    def _fails(self, rule: Rule) -> int | None:
        if rule.check is None:
            return None
        key = json.dumps(rule.check, sort_keys=True)
        if key not in self._hits:
            self._hits[key] = sum(1 for story in self._stories if run_check(rule.check, story) is not None)
        return self._hits[key]

    def _refresh(self) -> None:
        selected = self._selected()
        self.table.setRowCount(len(self.rules.rules))
        for i, rule in enumerate(self.rules.rules):
            fails = self._fails(rule)
            cells = [
                rule.source + (f" ({rule.model})" if rule.source == "llm" and rule.model else ""),
                rule.description,
                describe_check(rule.check),
                "-" if fails is None else f"{fails} ({fails / max(1, len(self._stories)):.0%})",
            ]
            for j, text in enumerate(cells):
                item = QTableWidgetItem(text)
                item.setToolTip(text)
                if j == 3:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
                self.table.setItem(i, j, item)
        self.table.resizeRowsToContents()
        if selected is not None and selected < len(self.rules.rules):
            self.table.selectRow(selected)
        self._update_buttons()

    def _selected(self) -> int | None:
        rows = self.table.selectionModel().selectedRows()
        return rows[0].row() if rows else None

    def _update_buttons(self) -> None:
        has_row = self._selected() is not None
        self.edit_button.setEnabled(has_row)
        self.delete_button.setEnabled(has_row)
        self.derive_button.setEnabled(not self._deriving)
        self.derive_button.setText("Updating..." if self._deriving else "Update from memory")
        self.save_button.setEnabled(self.pending() and not self._deriving)

    def pending(self) -> bool:
        return self.rules != self.original

    # -- Editing ---------------------------------------------------------------------
    def _add(self) -> None:
        editor = _RuleEditor("Add rule", None, self)
        if editor.exec() and editor.result_rule is not None:
            description, check = editor.result_rule
            self.rules.rules.append(Rule(new_id(), description, check, "hand", "", now()))
            self._refresh()
            self.table.selectRow(len(self.rules.rules) - 1)

    def _edit(self) -> None:
        row = self._selected()
        if row is None:
            return
        rule = self.rules.rules[row]
        editor = _RuleEditor("Edit rule", rule, self)
        if editor.exec() and editor.result_rule is not None:
            description, check = editor.result_rule
            if (description, check) != (rule.description, rule.check):
                self.rules.rules[row] = replace(rule, description=description, check=check, source="hand")
                self._refresh()

    def _delete(self) -> None:
        row = self._selected()
        if row is None:
            return
        rule = self.rules.rules.pop(row)
        if rule.source == "llm" and rule.description not in self.rules.dismissed:
            self.rules.dismissed.append(rule.description)
        self._refresh()

    def _derive(self) -> None:
        if self._deriving:
            return
        tile_dir, rules, model = self.tile_dir, RuleSet(list(self.rules.rules), list(self.rules.dismissed)), self.model
        self._deriving = True
        self._update_buttons()

        def done(derived: list[Rule]):
            self._deriving = False
            if not self.isVisible():
                return  # closed while the call ran, discarding it
            self.rules = self.rules.with_derived(derived)
            self._refresh()

        def failed(message: str):
            self._deriving = False
            if not self.isVisible():
                return
            self._update_buttons()
            QMessageBox.critical(self, "Update from memory failed", message)

        self.run(lambda: story_rules.derive_rules(tile_dir, rules, model), model, done, failed)

    # -- Closing ---------------------------------------------------------------------
    def save(self) -> bool:
        try:
            story_rules.save(self.tile_dir, self.rules)
        except OSError as err:
            QMessageBox.critical(self, "Save failed", str(err))
            return False
        self.original = RuleSet(list(self.rules.rules), list(self.rules.dismissed))
        self.saved = True
        self.accept()
        return True

    def reject(self) -> None:
        if self._deriving:
            answer = QMessageBox.question(self, "Update running", "Close and discard the update still running?")
            if answer != QMessageBox.StandardButton.Yes:
                return
        elif self.pending():
            answer = QMessageBox.question(self, "Unsaved changes", "Close and discard the unsaved changes?")
            if answer != QMessageBox.StandardButton.Yes:
                return
        super().reject()
