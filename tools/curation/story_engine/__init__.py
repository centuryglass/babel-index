"""
A staged generator for short fiction tied to an image.

Project-independent: a caller supplies a ``Frame`` (what the images are, the
seed, form and constraint lists) and a trace directory, and keeps each image's
pitches and drafts in a ``Workspace``. ``babel_index_review.story_frame`` is
the Babel Index configuration. Issue #385 tracks the stages still to come
(checking, corpus memory, LLM-owned judging).
"""

from story_engine.engine import Draft, Engine, Frame, Pitch, Reading, Revision
from story_engine.options import Option, OptionSet, load_options
from story_engine.trace import TraceLog
from story_engine.workspace import DraftEntry, PitchEntry, Workspace, WorkspaceStore

__all__ = [
    "Draft",
    "DraftEntry",
    "Engine",
    "Frame",
    "Option",
    "OptionSet",
    "Pitch",
    "PitchEntry",
    "Reading",
    "Revision",
    "TraceLog",
    "Workspace",
    "WorkspaceStore",
    "load_options",
]
