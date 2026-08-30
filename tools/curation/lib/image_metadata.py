"""Image-metadata backbone: read/write every store an image carries.

Single source of truth for the metadata this project cares about:
  - PNG text chunks, where AUTOMATIC1111 writes its `parameters` blob
  - EXIF, IPTC, XMP, and the JPEG/EXIF comment
  - IPTC/XMP `Keywords` -- the "tags" gThumb reads/writes, used across this repo
    to store ratings, style names, and metadata on reference images

This module supersedes the old `comment_exif`: it keeps that module's granular
per-tag / per-comment helpers (`readTags`, `setTags`, `addTag`, `removeTag`,
`readComment`, `writeComment`) verbatim, and adds a whole-image layer on top.
`read_prompt` (and `read_model`) now build on that whole-image layer so they
work across every format it supports, not just PNG.

The whole-image layer passes metadata around as a plain dict:
    {'png_text': {...}, 'exif': {...}, 'iptc': {...}, 'xmp': {...},
     'comment': str}
plus optional '_file'/'_format' provenance fields. That layout round-trips: what
`read_image_metadata` returns is exactly what `write_image_metadata` accepts, and
it JSON-serialises cleanly for on-disk dumps. See `util/metadata.py` for a CLI
built on these helpers.

Format coverage: reads are attempted for every format PIL can open; structured
EXIF/IPTC/XMP goes through pyexiv2 (exiv2) where the container supports it, while
the A1111 parameter blob / plain comment is pulled from — and written back to —
whichever place a given format actually keeps it (PNG text chunk, EXIF
ImageDescription, or a PIL comment field for GIF/JPEG-2000). Where a format
cannot hold a store, the write path says so rather than failing silently. See
`metadata_capabilities` for the per-format capability model.
"""
import os
import re

import pyexiv2
from PIL import Image, PngImagePlugin

# Populate PIL's plugin registry so the capability sets below are complete
# (Image.OPEN / Image.SAVE are empty until the plugins are imported).
Image.init()

# The stores a whole-image metadata dict carries, in write order.
METADATA_KEYS = ('png_text', 'exif', 'iptc', 'xmp', 'comment')

# PIL exposes these alongside the real text chunks; they duplicate the EXIF/IPTC/
# XMP that pyexiv2 reads properly, or are binary/structural. Skip them so
# png_text holds only genuine, human-readable text chunks (e.g. `parameters`).
_PNG_SKIP = {'exif', 'XML:com.adobe.xmp', 'icc_profile', 'dpi', 'srgb',
             'gamma', 'chromaticity', 'transparency', 'aspect', 'interlace'}


# ===========================================================================
# Format capabilities
# ===========================================================================
# Every format PIL can open / save in this install, keyed by the id `img.format`
# reports (e.g. 'PNG', 'JPEG', 'GIF', 'TIFF', 'WEBP', 'JPEG2000').
PIL_READ_FORMATS = set(Image.OPEN)
PIL_WRITE_FORMATS = set(Image.SAVE)

# exiv2 (via pyexiv2) is the structured-metadata backend. It probes formats by
# content and raises for anything it does not understand, so these curated sets
# describe what actually works rather than what PIL merely recognises. They were
# verified empirically against this build; the read/write paths still catch and
# report backend errors, so an out-of-date entry degrades to a clear message
# rather than a crash.
#
# Formats exiv2 can read *and* write EXIF / IPTC / XMP for:
EXIV2_STRUCTURED_FORMATS = {'PNG', 'JPEG', 'MPO', 'TIFF', 'WEBP', 'JPEG2000',
                            'PSD'}
# ...of those, the ones that also accept a plain image *comment*:
EXIV2_COMMENT_FORMATS = {'PNG', 'JPEG', 'MPO'}
# Formats exiv2 cannot touch, but whose comment field PIL can read and write —
# this is where an A1111 parameter blob ends up for these containers:
PIL_COMMENT_FORMATS = {'GIF', 'JPEG2000'}

# Formats where exiv2 accepts an IPTC write but silently fails to persist it
# (WebP keeps keywords in XMP instead). For these, keyword tags are mirrored
# into XMP `dc.subject` so gThumb-style tags survive a round-trip.
_IPTC_UNRELIABLE_FORMATS = {'WEBP'}

# Formats where opening with pyexiv2 raises outright; skip it and lean on PIL so
# a clean read does not turn into a scary warning.
_EXIV2_SKIP = {'GIF'}

# Where the A1111 parameter blob lives inside EXIF, in read-preference order.
_EXIF_DESCRIPTION_KEY = 'Exif.Image.ImageDescription'
_EXIF_USERCOMMENT_KEY = 'Exif.Photo.UserComment'


def image_format(path):
    """Detect a file's PIL format id, falling back to its extension."""
    try:
        with Image.open(path) as img:
            if img.format:
                return img.format
    except Exception:
        pass
    ext = os.path.splitext(path)[1].lstrip('.').upper()
    return {'JPG': 'JPEG', 'JPE': 'JPEG', 'TIF': 'TIFF', 'JP2': 'JPEG2000',
            'J2K': 'JPEG2000', 'JPX': 'JPEG2000'}.get(ext, ext)


def metadata_capabilities(fmt):
    """What metadata stores a PIL format id can carry, as bool flags.

    - ``structured``: EXIF / IPTC / XMP via exiv2.
    - ``comment``:    a plain image comment we can write (exiv2 or PIL).
    - ``params``:     an A1111 parameter blob can be persisted *somewhere*
                      durable (a text chunk, EXIF description, or comment).
    """
    fmt = (fmt or '').upper()
    structured = fmt in EXIV2_STRUCTURED_FORMATS
    comment = (fmt in EXIV2_COMMENT_FORMATS or fmt in PIL_COMMENT_FORMATS)
    return {'structured': structured,
            'comment': comment,
            'params': structured or comment or fmt == 'PNG'}


# ===========================================================================
# Granular helpers (comment + IPTC keyword tags + A1111 prompt)
# ===========================================================================
def readComment(imagePath):
    with pyexiv2.Image(imagePath) as img:
        return img.read_comment()


def writeComment(imagePath, comment):
    with pyexiv2.Image(imagePath) as img:
        img.modify_comment(comment)


def _load_iptc(img):
    iptc = img.read_iptc()
    if len(iptc) == 0:
        iptc['Iptc.Application2.Keywords'] = []
        iptc['Iptc.Application2.RecordVersion'] = '4'
    elif 'Iptc.Application2.Keywords' not in iptc:
        iptc['Iptc.Application2.Keywords'] = []
    return iptc


def readTags(imagePath):
    try:
        with pyexiv2.Image(imagePath) as img:
            return _load_iptc(img)['Iptc.Application2.Keywords']
    except Exception as err:
        print(f"Failed to read tags from {imagePath}: {err}")
        exit(1)


def setTags(imagePath, tags):
    try:
        with pyexiv2.Image(imagePath) as img:
            iptc = _load_iptc(img)
            iptc['Iptc.Application2.Keywords'] = tags
            img.modify_iptc(iptc)
    except Exception as err:
        print(f"Failed to set tags in {imagePath}: {err}")
        exit(1)


def addTag(imagePath, tag):
    try:
        with pyexiv2.Image(imagePath) as img:
            iptc = _load_iptc(img)
            if tag in iptc['Iptc.Application2.Keywords']:
                print(f"{tag} already there")
                return
            iptc['Iptc.Application2.Keywords'].append(tag)
            img.modify_iptc(iptc)
    except Exception as err:
        print(f"Failed to add tag {tag} in {imagePath}: {err}")
        exit(1)


def removeTag(imagePath, tag):
    try:
        with pyexiv2.Image(imagePath) as img:
            iptc = _load_iptc(img)
            if tag not in iptc['Iptc.Application2.Keywords']:
                print(f"{tag} not found")
                return
            iptc['Iptc.Application2.Keywords'].remove(tag)
            img.modify_iptc(iptc)
    except Exception as err:
        print(f"Failed to remove tag {tag} in {imagePath}: {err}")
        exit(1)


def read_prompt(image_path):
    """Read the A1111 prompt from any format `read_image_metadata` supports."""
    params = get_a1111_params(read_image_metadata(image_path))
    if not params:
        return None
    prompt, _, _ = parse_a1111_params(params)
    return prompt


def read_model(image_path):
    """Read the A1111 model name from any format `read_image_metadata` supports."""
    params = get_a1111_params(read_image_metadata(image_path))
    if not params:
        return None
    _, _, settings = parse_a1111_params(params)
    return settings.get('Model')


# ===========================================================================
# Whole-image layer
# ===========================================================================
def empty_metadata():
    """A metadata dict with every store present and empty."""
    return {'png_text': {}, 'exif': {}, 'iptc': {}, 'xmp': {}, 'comment': ''}


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------
def _extract_png_text(info):
    """Keep only real, string-valued text chunks from a PIL info dict."""
    out = {}
    for key, value in info.items():
        if key in _PNG_SKIP or key.startswith('Raw profile type'):
            continue
        if isinstance(value, str):
            out[key] = value
    return out


def _pil_comment(img):
    """Best-effort plain-text comment from a PIL image (GIF / JPEG-2000)."""
    value = img.info.get('comment')
    if isinstance(value, bytes):
        value = value.decode('utf-8', 'replace')
    return value or ''


def read_image_metadata(path):
    """Read every metadata store from an image into a structured dict.

    Works across every format PIL can open. Structured EXIF/IPTC/XMP comes from
    exiv2 where supported; the plain comment is taken from exiv2 when available
    and otherwise from PIL's comment field (GIF / JPEG-2000). Backend failures
    are reported, never swallowed.
    """
    meta = empty_metadata()
    meta['_file'] = os.path.basename(path)
    meta['_format'] = None
    pil_comment = ''
    try:
        with Image.open(path) as img:
            meta['_format'] = img.format
            if img.format == 'PNG':
                meta['png_text'] = _extract_png_text(img.info)
            pil_comment = _pil_comment(img)
    except Exception as err:
        print(f"Warning: PIL could not read {path}: {err}")
    fmt = (meta['_format'] or image_format(path) or '').upper()
    if fmt not in _EXIV2_SKIP:
        try:
            with pyexiv2.Image(path) as img:
                meta['exif'] = img.read_exif()
                meta['iptc'] = img.read_iptc()
                meta['xmp'] = img.read_xmp()
                meta['comment'] = img.read_comment() or ''
        except Exception as err:
            print(f"Warning: pyexiv2 could not read {path}: {err}")
    if not meta['comment'] and pil_comment:
        meta['comment'] = pil_comment
    return meta


# ---------------------------------------------------------------------------
# A1111 parameter helpers
# ---------------------------------------------------------------------------
def _looks_like_a1111(text):
    """True if `text` looks like an A1111 parameter blob."""
    return bool(text) and ('Steps:' in text or 'Negative prompt:' in text)


def get_a1111_params(meta):
    """Return the raw A1111 parameter string from wherever the format kept it.

    Checked in order: the PNG `parameters` text chunk, the EXIF UserComment /
    ImageDescription (JPEG / WebP / TIFF), then the plain comment field (GIF /
    JPEG-2000). The EXIF charset prefix is stripped when present.
    """
    params = meta.get('png_text', {}).get('parameters')
    if params:
        return params
    exif = meta.get('exif', {})
    candidates = (exif.get(_EXIF_USERCOMMENT_KEY, ''),
                  exif.get(_EXIF_DESCRIPTION_KEY, ''),
                  meta.get('comment', ''))
    for raw in candidates:
        if not raw:
            continue
        text = re.sub(r'^charset=\S+\s*', '', str(raw)).strip('\x00 ')
        if _looks_like_a1111(text):
            return text
    return None


def parse_a1111_params(text):
    """Split an A1111 parameter string into (prompt, negative, settings dict)."""
    lines = text.strip().split('\n')
    settings = {}
    # The trailing line is the settings line if it is a run of "Key: value"
    # pairs. Pull it off before separating prompt from negative prompt.
    if len(lines) > 1 and re.search(r'\b(Steps|Sampler|Seed|CFG scale):', lines[-1]):
        for key, value in re.findall(r'([^:,]+):\s*("[^"]*"|[^,]*)', lines[-1]):
            settings[key.strip()] = value.strip().strip('"')
        lines = lines[:-1]
    prompt_lines, negative_lines, in_negative = [], [], False
    for line in lines:
        if line.startswith('Negative prompt:'):
            in_negative = True
            line = line[len('Negative prompt:'):].strip()
        (negative_lines if in_negative else prompt_lines).append(line)
    return ('\n'.join(prompt_lines).strip(),
            '\n'.join(negative_lines).strip(), settings)


def get_tags(meta):
    """Return the gThumb keyword tags from a metadata dict (IPTC, then XMP)."""
    tags = meta.get('iptc', {}).get('Iptc.Application2.Keywords')
    if not tags:
        tags = meta.get('xmp', {}).get('Xmp.iptc.Keywords') \
            or meta.get('xmp', {}).get('Xmp.dc.subject')
    if isinstance(tags, str):
        tags = [tags]
    return tags or []


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------
def _write_pyexiv2_group(clear_fn, modify_fn, data, label):
    """Clear a metadata group then write `data`, tolerating rejected keys."""
    clear_fn()
    if not data:
        return
    try:
        modify_fn(data)
    except Exception:
        # Some keys are structural/read-only; write survivors one at a time.
        for key, value in data.items():
            try:
                modify_fn({key: value})
            except Exception as err:
                print(f"  skipped {label} key {key}: {err}")


def _write_png_text(path, png_text):
    """Rewrite a PNG with `png_text` as its text chunks (drops EXIF/IPTC/XMP)."""
    with Image.open(path) as img:
        info = PngImagePlugin.PngInfo()
        for key, value in png_text.items():
            info.add_text(key, value)
        img.save(path, format='PNG', pnginfo=info)


def _write_pil_comment(path, fmt, text):
    """Persist a comment via PIL for a format exiv2 can't write (GIF / JP2)."""
    text = text or ''
    with Image.open(path) as img:
        if getattr(img, 'n_frames', 1) > 1:
            print(f"  warning: {path} is a multi-frame {fmt}; not rewriting it "
                  f"to store a comment.")
            return
        img.load()
        img.save(path, format=fmt,
                 comment=text.encode('utf-8') if isinstance(text, str) else text)


def write_image_metadata(path, meta):
    """Replace all metadata in the image at `path` with `meta` (in place).

    Existing metadata in each store is cleared first, so this is a true replace,
    not a merge. Pixel data is preserved.

    The write is format-aware: EXIF/IPTC/XMP go through exiv2 where the container
    supports them, and the A1111 parameter blob is routed to a store the target
    format can actually hold — the PNG text chunk for PNG, EXIF ImageDescription
    for JPEG/WebP/TIFF, or a PIL comment for GIF/JPEG-2000. Whenever a store
    cannot be carried by the target format, that is reported rather than dropped
    silently or raised.

    Returns True if any store was written, False if the target format can hold
    no metadata at all (so the caller can report accurately).
    """
    fmt = (image_format(path) or '').upper()
    caps = metadata_capabilities(fmt)
    png_text = meta.get('png_text', {})
    params = get_a1111_params(meta)

    if fmt == 'PNG':
        # PIL re-save rewrites the file and drops the EXIF/IPTC/XMP chunks, so
        # do it first, then let pyexiv2 restore those from `meta` below.
        _write_png_text(path, png_text)
    elif png_text:
        dropped = [k for k in png_text if k != 'parameters']
        if dropped:
            print(f"  note: dropping PNG-only text chunks ({', '.join(dropped)}); "
                  f"{path} is {fmt}")

    # GIF: exiv2 can't touch it at all, so everything goes through PIL, and only
    # a comment survives.
    if fmt == 'GIF':
        for store in ('exif', 'iptc', 'xmp'):
            if meta.get(store):
                print(f"  note: {fmt} cannot store {store.upper()}; dropped.")
        text = params or meta.get('comment', '')
        if text:
            _write_pil_comment(path, fmt, text)
        return True

    if not caps['structured']:
        # BMP and other bare-pixel formats: exiv2 refuses to write anything.
        if any(meta.get(k) for k in ('exif', 'iptc', 'xmp')) \
                or meta.get('comment') or params:
            print(f"  warning: {fmt} cannot store metadata via the available "
                  f"backends; nothing written for {path}.")
        return False

    # Structured formats (PNG, JPEG, WebP, TIFF, JP2, ...): exiv2 handles the
    # EXIF/IPTC/XMP stores. Fold the A1111 blob into EXIF ImageDescription so it
    # survives even where the plain comment field is rejected (WebP, TIFF, JP2).
    exif = dict(meta.get('exif', {}))
    if params and fmt != 'PNG' and not (
            _looks_like_a1111(str(exif.get(_EXIF_USERCOMMENT_KEY, '')))
            or _looks_like_a1111(str(exif.get(_EXIF_DESCRIPTION_KEY, '')))):
        exif[_EXIF_DESCRIPTION_KEY] = params

    xmp = dict(meta.get('xmp', {}))
    if fmt in _IPTC_UNRELIABLE_FORMATS:
        keywords = meta.get('iptc', {}).get('Iptc.Application2.Keywords')
        if keywords and not (xmp.get('Xmp.dc.subject')
                             or xmp.get('Xmp.iptc.Keywords')):
            xmp['Xmp.dc.subject'] = keywords

    with pyexiv2.Image(path) as img:
        _write_pyexiv2_group(img.clear_exif, img.modify_exif, exif, 'exif')
        _write_pyexiv2_group(img.clear_iptc, img.modify_iptc,
                             meta.get('iptc', {}), 'iptc')
        _write_pyexiv2_group(img.clear_xmp, img.modify_xmp, xmp, 'xmp')
        img.clear_comment()
        comment = meta.get('comment', '')
        if comment:
            if caps['comment']:
                try:
                    img.modify_comment(comment)
                except Exception as err:
                    print(f"  skipped comment: {err}")
            else:
                print(f"  note: {fmt} rejects a plain comment; the A1111 blob was "
                      f"stored in EXIF ImageDescription instead.")
    return True
