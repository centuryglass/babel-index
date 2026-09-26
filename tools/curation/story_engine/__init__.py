"""
A staged generator for short fiction tied to an image.

Project-independent: a caller supplies a ``Frame`` (what the images are, the
payload and form lists) and a trace directory. ``babel_index_review.story_frame``
is the Babel Index configuration. Issue #385 tracks the stages still to come
(checking, corpus memory, LLM-owned judging).
"""

from story_engine.engine import Engine, Frame, Pitch, PitchBatch, Reading
from story_engine.options import Option, load_options
from story_engine.trace import TraceLog

__all__ = [
    "Engine",
    "Frame",
    "Option",
    "Pitch",
    "PitchBatch",
    "Reading",
    "TraceLog",
    "load_options",
]
