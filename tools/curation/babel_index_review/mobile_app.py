"""Minimal mobile-friendly web GUI for reviewing babel-index stories.

Serves a single-page app over plain HTTP so a phone on the same LAN as the
desktop can page through non-final tiles, view the image/keywords/story, edit
the story text (autosaves), mark a tile final or needing inpainting, clear a
story, and generate a fresh one. Story generation always uses
``tag.describe_image.DEFAULT_MODEL`` (OpenRouter Gemini Flash Latest) -- there
is no model picker and no revision/turn support, unlike the full desktop tool
at ``babel_index_review.gui``. An optional "extra guidance" field is appended
to the default keyword-seeded prompt.

Run from the repo root:

    python -m babel_index_review.mobile_app DIR [--host H] [--port P]

then open ``http://<desktop-lan-ip>:<port>/`` from the phone's browser.
"""

from __future__ import annotations

import argparse
import os

from flask import Flask, abort, jsonify, render_template_string, request, send_file

from babel_index_review import core

INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>babel-index review</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, sans-serif;
    background: #17181c;
    color: #e6e6e6;
    display: flex;
    flex-direction: column;
    /* svh, not dvh: Firefox for Android's dynamic toolbar recompute of dvh is
       buggy (mozilla-mobile/fenix#25680, #17991) and can leave a bottom flex
       item like #bottombar rendered off-screen or jumping as the toolbar
       shows/hides while scrolling #main. svh is static (sized as if the
       toolbar is always shown), so it never re-triggers that reflow -- the
       cost is not reclaiming the sliver of space when the toolbar auto-hides. */
    height: 100svh;
  }
  #status {
    padding: 6px 10px;
    font-size: 0.8rem;
    color: #999;
    text-align: center;
    border-bottom: 1px solid #2a2b30;
  }
  #main {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 10px;
  }
  /* #main is a plain block scroll container, not a flex column -- flexing its
     children let the image get flex-shrunk down to a sliver instead of the
     container just scrolling. Spacing between children comes from margins. */
  #main > * {
    margin-bottom: 10px;
  }
  #image-wrap {
    text-align: center;
    background: #000;
    border-radius: 6px;
    overflow: hidden;
  }
  #tile-image {
    max-width: 100%;
    max-height: 45vh;
    display: block;
    margin: 0 auto;
  }
  #missing {
    padding: 40px 0;
    color: #888;
    text-align: center;
  }
  #keywords {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .kw {
    background: #2a2b30;
    border-radius: 12px;
    padding: 3px 10px;
    font-size: 0.8rem;
    color: #ccc;
  }
  .kw .type { color: #888; }
  label.field-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #888;
  }
  #story {
    width: 100%;
    min-height: 30vh;
    resize: vertical;
    background: #1e1f24;
    color: #e6e6e6;
    border: 1px solid #34353c;
    border-radius: 6px;
    padding: 10px;
    font-size: 1rem;
    line-height: 1.4;
  }
  #empty-state {
    margin: auto;
    text-align: center;
    color: #888;
    padding: 40px 20px;
  }
  #bottombar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px;
    border-top: 1px solid #2a2b30;
    background: #1b1c21;
  }
  button, input[type="checkbox"] {
    font-size: 1rem;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid #3a3b42;
    background: #26272d;
    color: #e6e6e6;
  }
  button:active { background: #33343b; }
  button:disabled { opacity: 0.4; }
  #nav-prev, #nav-next { flex: 1; }
  .toggle-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 12px 10px;
    white-space: nowrap;
  }
  input[type="checkbox"] { width: 22px; height: 22px; padding: 0; }
  #save-indicator {
    font-size: 0.75rem;
    color: #666;
    min-width: 3.5em;
    text-align: right;
  }
  #toggles-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 10px;
    border-top: 1px solid #2a2b30;
    background: #1b1c21;
  }
  #extra-guidance {
    width: 100%;
    background: #1e1f24;
    color: #e6e6e6;
    border: 1px solid #34353c;
    border-radius: 6px;
    padding: 8px;
    font-size: 0.9rem;
  }
  #ai-controls {
    display: flex;
    gap: 8px;
  }
  #generate-btn { flex: 1; }
  #clear-btn { min-width: 80px; }
</style>
</head>
<body>
  <div id="status">loading…</div>
  <div id="main">
    <div id="image-wrap"><img id="tile-image" alt="tile"></div>
    <div id="missing" style="display:none">image missing from disk</div>
    <div id="keywords"></div>
    <div>
      <label class="field-label" for="story">Story</label>
      <textarea id="story" spellcheck="true"></textarea>
    </div>
    <div>
      <label class="field-label" for="extra-guidance">Extra guidance (optional, appended to the story prompt)</label>
      <textarea id="extra-guidance" rows="2"></textarea>
    </div>
    <div id="ai-controls">
      <button id="generate-btn">Generate</button>
      <button id="clear-btn">Clear</button>
    </div>
    <div id="empty-state" style="display:none">No non-final tiles remaining.</div>
  </div>
  <div id="toggles-row">
    <div class="toggle-wrap">
      <input type="checkbox" id="final-toggle">
      <label for="final-toggle">Final</label>
    </div>
    <div class="toggle-wrap">
      <input type="checkbox" id="inpaint-toggle">
      <label for="inpaint-toggle">Needs inpainting</label>
    </div>
    <span id="save-indicator"></span>
  </div>
  <div id="bottombar">
    <button id="nav-prev">&larr; Prev</button>
    <button id="nav-next">Next &rarr;</button>
  </div>

<script>
(() => {
  let allKeys = [];       // [{key, final, has_story, exists}]
  let nonFinalKeys = [];  // ordered list of keys, final == false
  let pos = 0;            // index into nonFinalKeys
  let currentKey = null;
  let saveTimer = null;
  let loading = false;
  let busy = false;  // a generate request is in flight

  const statusEl = document.getElementById('status');
  const imgEl = document.getElementById('tile-image');
  const imgWrap = document.getElementById('image-wrap');
  const missingEl = document.getElementById('missing');
  const keywordsEl = document.getElementById('keywords');
  const storyEl = document.getElementById('story');
  const finalEl = document.getElementById('final-toggle');
  const inpaintEl = document.getElementById('inpaint-toggle');
  const extraEl = document.getElementById('extra-guidance');
  const generateBtn = document.getElementById('generate-btn');
  const clearBtn = document.getElementById('clear-btn');
  const emptyEl = document.getElementById('empty-state');
  const mainEl = document.getElementById('main');
  const prevBtn = document.getElementById('nav-prev');
  const nextBtn = document.getElementById('nav-next');
  const saveIndicator = document.getElementById('save-indicator');

  function setStatus() {
    if (!nonFinalKeys.length) {
      statusEl.textContent = `0 non-final left (${allKeys.length} total)`;
      return;
    }
    statusEl.textContent =
      `${pos + 1} / ${nonFinalKeys.length} non-final  ·  ${allKeys.length} total`;
  }

  async function fetchKeys() {
    const res = await fetch('/api/keys');
    allKeys = await res.json();
    nonFinalKeys = allKeys.filter(k => !k.final).map(k => k.key);
  }

  async function loadTile(key) {
    loading = true;
    const res = await fetch(`/api/tile/${encodeURIComponent(key)}`);
    if (!res.ok) { loading = false; return; }
    const tile = await res.json();
    currentKey = tile.key;

    if (tile.exists) {
      imgEl.src = `/image/${encodeURIComponent(key)}?t=${Date.now()}`;
      imgWrap.style.display = '';
      missingEl.style.display = 'none';
    } else {
      imgWrap.style.display = 'none';
      missingEl.style.display = '';
    }

    keywordsEl.innerHTML = '';
    for (const kw of tile.keywords || []) {
      const span = document.createElement('span');
      span.className = 'kw';
      span.innerHTML = `${kw.text} <span class="type">(${kw.type})</span>`;
      keywordsEl.appendChild(span);
    }

    storyEl.value = tile.story || '';
    finalEl.checked = !!tile.final;
    inpaintEl.checked = !!tile.needs_inpainting;
    extraEl.value = '';
    saveIndicator.textContent = '';
    loading = false;
    updateActionAvailability();
  }

  function updateActionAvailability() {
    const disabled = finalEl.checked || busy;
    generateBtn.disabled = disabled;
    clearBtn.disabled = disabled;
  }

  function showTileView(show) {
    mainEl.querySelectorAll(':scope > *').forEach(el => {
      if (el.id !== 'empty-state') el.style.display = show ? '' : 'none';
    });
    emptyEl.style.display = show ? 'none' : '';
    document.getElementById('toggles-row').style.display = show ? '' : 'none';
    document.getElementById('bottombar').style.display = show ? '' : 'none';
  }

  async function refreshAndShow() {
    await fetchKeys();
    setStatus();
    if (!nonFinalKeys.length) {
      showTileView(false);
      currentKey = null;
      return;
    }
    showTileView(true);
    pos = Math.min(pos, nonFinalKeys.length - 1);
    await loadTile(nonFinalKeys[pos]);
  }

  function navigate(delta) {
    if (!nonFinalKeys.length) return;
    pos = (pos + delta + nonFinalKeys.length) % nonFinalKeys.length;
    setStatus();
    loadTile(nonFinalKeys[pos]);
  }

  prevBtn.addEventListener('click', () => navigate(-1));
  nextBtn.addEventListener('click', () => navigate(1));

  storyEl.addEventListener('input', () => {
    if (loading || !currentKey) return;
    saveIndicator.textContent = 'editing…';
    clearTimeout(saveTimer);
    const key = currentKey;
    const text = storyEl.value;
    saveTimer = setTimeout(async () => {
      await fetch(`/api/tile/${encodeURIComponent(key)}/story`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ story: text }),
      });
      if (currentKey === key) saveIndicator.textContent = 'saved';
    }, 600);
  });

  finalEl.addEventListener('change', async () => {
    if (loading || !currentKey) return;
    const key = currentKey;
    const final = finalEl.checked;
    await fetch(`/api/tile/${encodeURIComponent(key)}/final`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ final }),
    });
    // Marking final drops it out of the non-final queue; stay at the same
    // position so the next tile slides into view (mirrors the desktop GUI).
    await refreshAndShow();
  });

  inpaintEl.addEventListener('change', () => {
    if (loading || !currentKey) return;
    fetch(`/api/tile/${encodeURIComponent(currentKey)}/inpaint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inpaint: inpaintEl.checked }),
    });
  });

  clearBtn.addEventListener('click', async () => {
    if (!currentKey || clearBtn.disabled) return;
    if (!confirm('Clear this story? This cannot be undone.')) return;
    clearTimeout(saveTimer);
    const key = currentKey;
    storyEl.value = '';
    await fetch(`/api/tile/${encodeURIComponent(key)}/story`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ story: '' }),
    });
    if (currentKey === key) saveIndicator.textContent = 'cleared';
  });

  generateBtn.addEventListener('click', async () => {
    if (!currentKey || generateBtn.disabled) return;
    const key = currentKey;
    busy = true;
    updateActionAvailability();
    generateBtn.textContent = 'Generating…';
    try {
      const res = await fetch(`/api/tile/${encodeURIComponent(key)}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extra: extraEl.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'generation failed');
      if (currentKey === key) {
        storyEl.value = data.story;
        saveIndicator.textContent = 'saved';
      }
    } catch (err) {
      alert('Generate failed: ' + err.message);
    } finally {
      busy = false;
      generateBtn.textContent = 'Generate';
      updateActionAvailability();
    }
  });

  refreshAndShow();
})();
</script>
</body>
</html>
"""


def create_app(tile_dir: str) -> Flask:
    app = Flask(__name__)

    @app.get("/")
    def index():
        return render_template_string(INDEX_HTML)

    @app.get("/api/keys")
    def api_keys():
        idx = core.load_index(tile_dir)
        return jsonify(
            [
                {
                    "key": key,
                    "final": bool(entry.get("final")),
                    "has_story": bool(entry.get("story")),
                    "exists": os.path.exists(os.path.join(tile_dir, key)),
                }
                for key, entry in sorted(idx.items())
            ]
        )

    @app.get("/api/tile/<key>")
    def api_tile(key):
        idx = core.load_index(tile_dir)
        entry = idx.get(key)
        if entry is None:
            abort(404)
        return jsonify(
            {
                "key": key,
                "keywords": entry.get("keywords", []),
                "story": entry.get("story") or "",
                "final": bool(entry.get("final")),
                "needs_inpainting": bool(entry.get("needs_inpainting")),
                "exists": os.path.exists(os.path.join(tile_dir, key)),
            }
        )

    @app.get("/image/<key>")
    def image(key):
        path = os.path.join(tile_dir, key)
        if not os.path.isfile(path):
            abort(404)
        return send_file(path, mimetype="image/webp")

    @app.post("/api/tile/<key>/story")
    def save_story(key):
        idx = core.load_index(tile_dir)
        if key not in idx:
            abort(404)
        text = (request.get_json(silent=True) or {}).get("story", "")
        idx[key]["story"] = text or None
        core.save_index(tile_dir, idx)
        return jsonify({"ok": True})

    @app.post("/api/tile/<key>/final")
    def save_final(key):
        idx = core.load_index(tile_dir)
        if key not in idx:
            abort(404)
        idx[key]["final"] = bool((request.get_json(silent=True) or {}).get("final"))
        core.save_index(tile_dir, idx)
        return jsonify({"ok": True})

    @app.post("/api/tile/<key>/inpaint")
    def save_inpaint(key):
        idx = core.load_index(tile_dir)
        entry = idx.get(key)
        if entry is None:
            abort(404)
        if (request.get_json(silent=True) or {}).get("inpaint"):
            entry["needs_inpainting"] = True
        else:
            entry.pop("needs_inpainting", None)
        core.save_index(tile_dir, idx)
        return jsonify({"ok": True})

    @app.post("/api/tile/<key>/generate")
    def generate(key):
        idx = core.load_index(tile_dir)
        entry = idx.get(key)
        if entry is None:
            abort(404)
        webp_path = os.path.join(tile_dir, key)
        if not os.path.isfile(webp_path):
            return jsonify({"error": f"{key} is not on disk."}), 400

        extra = (request.get_json(silent=True) or {}).get("extra", "").strip()
        prompt = core.default_prompt(core.keyword_texts(entry))
        if extra:
            prompt += "\n\n" + extra

        try:
            story = core.generate_story(webp_path, prompt)
        except Exception as err:  # surfaced to the client, never a 500 page
            return jsonify({"error": str(err)}), 500

        idx[key]["story"] = story
        core.save_index(tile_dir, idx)
        return jsonify({"story": story})

    return app


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Mobile-friendly web GUI for reviewing babel-index tile stories."
    )
    parser.add_argument("dir", help="Tile directory (holds NNNNN.webp + metadata.json).")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default: all interfaces).")
    parser.add_argument("--port", type=int, default=5057)
    args = parser.parse_args()

    if not os.path.isdir(args.dir):
        print(f"{args.dir} not found")
        return 1

    app = create_app(os.path.abspath(args.dir))
    app.run(host=args.host, port=args.port, threaded=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
