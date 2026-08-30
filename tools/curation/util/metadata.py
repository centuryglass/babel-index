"""Read, dump, and transplant image metadata (A1111 params + gThumb tags).

A thin CLI over `lib.image_metadata`, which does the actual reading/writing of
every metadata store (PNG text chunks, EXIF, IPTC, XMP, comment). Run from the
repo root.

    # Pretty-print all metadata, with A1111 params and gThumb tags called out:
    python util/metadata.py img.png

    # Dump everything to JSON in a programmatic-friendly layout:
    python util/metadata.py img.png -out img_out.json

    # Pretty-print a previously dumped JSON the same way as an image:
    python util/metadata.py img_out.json

    # List which image formats can be read and which can carry metadata:
    python util/metadata.py -formats

    # Replace all metadata in out_file with the metadata from in_file. Either
    # side may be an image or a JSON dump; both must already exist. -y/--yes
    # skips the confirmation prompt (for bulk jobs):
    python util/metadata.py -update in_file out_file [-y]

The JSON dump layout is `lib.image_metadata`'s metadata dict, so a dump can stand
in for an image anywhere in-file/out-file are accepted.
"""
import os
import sys
import json
import argparse

from lib.image_metadata import (read_image_metadata, write_image_metadata,
                                 get_a1111_params, parse_a1111_params, get_tags,
                                 metadata_capabilities,
                                 PIL_READ_FORMATS, PIL_WRITE_FORMATS,
                                 EXIV2_STRUCTURED_FORMATS, PIL_COMMENT_FORMATS,
                                 METADATA_KEYS,
                                 _EXIF_USERCOMMENT_KEY, _EXIF_DESCRIPTION_KEY)


def load_metadata(path):
    """Load metadata from either an image or a previously dumped JSON file."""
    if not os.path.exists(path):
        print(f"File not found: {path}")
        sys.exit(1)
    if path.lower().endswith('.json'):
        with open(path, encoding='utf-8') as fp:
            meta = json.load(fp)
        # Tolerate partial dumps by filling in the expected stores.
        for key in METADATA_KEYS:
            meta.setdefault(key, {} if key != 'comment' else '')
        meta.setdefault('_file', os.path.basename(path))
        meta.setdefault('_format', 'JSON')
        return meta
    return read_image_metadata(path)


# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------
def _section(title):
    print(f"\n── {title} " + "─" * max(2, 60 - len(title)))


def _dump_dict(data):
    if not data:
        print("  (none)")
        return
    width = max(len(str(k)) for k in data)
    for key, value in data.items():
        if isinstance(value, list):
            value = ', '.join(str(v) for v in value)
        print(f"  {str(key).ljust(width)} : {value}")


def _capability_note(fmt):
    """One-line summary of which metadata stores a format can carry."""
    caps = metadata_capabilities(fmt)
    if caps['structured']:
        held = "EXIF/IPTC/XMP" + (", comment" if caps['comment'] else "")
    elif caps['comment']:
        held = "comment only"
    elif caps['params']:
        held = "A1111 params only"
    else:
        held = "none"
    return f"metadata support: {held}"


def format_metadata(meta):
    """Print all metadata, spotlighting A1111 params and gThumb tags."""
    fmt = meta.get('_format', '?')
    print(f"File: {meta.get('_file', '?')} ({fmt})")
    if fmt and fmt != 'JSON':
        print(f"  {_capability_note(fmt)}")

    params = get_a1111_params(meta)
    if params:
        prompt, negative, settings = parse_a1111_params(params)
        _section("Stable Diffusion (A1111)")
        print("Prompt:")
        print(f"  {prompt or '(empty)'}")
        if negative:
            print("Negative prompt:")
            print(f"  {negative}")
        if settings:
            print("Settings:")
            _dump_dict(settings)

    tags = get_tags(meta)
    if tags:
        _section("gThumb tags")
        print("  " + ', '.join(tags))

    _section("EXIF")
    _dump_dict(meta.get('exif', {}))

    _section("IPTC")
    _dump_dict(meta.get('iptc', {}))

    _section("XMP")
    _dump_dict(meta.get('xmp', {}))

    other = {k: v for k, v in meta.get('png_text', {}).items() if k != 'parameters'}
    _section("Other PNG text")
    _dump_dict(other)

    _section("Comment")
    print(f"  {meta.get('comment') or '(empty)'}")


# ---------------------------------------------------------------------------
# Single-field A1111 param edits
# ---------------------------------------------------------------------------
def _format_a1111_settings(settings):
    parts = []
    for key, value in settings.items():
        value = str(value)
        if ',' in value or '"' in value:
            value = '"' + value.replace('"', '\\"') + '"'
        parts.append(f"{key}: {value}")
    return ', '.join(parts)


def _rebuild_a1111_params(prompt, negative, settings):
    lines = [prompt]
    if negative:
        lines.append(f"Negative prompt: {negative}")
    text = '\n'.join(lines)
    settings_line = _format_a1111_settings(settings)
    if settings_line:
        text += '\n' + settings_line
    return text


def set_a1111_field(path, field, value):
    """Rewrite a single A1111 parameter field in an image's metadata, in place.

    `field` is 'prompt', 'negative_prompt', or a settings key as it appears in
    the params blob (e.g. 'Seed', 'CFG scale', 'Model hash'). For a settings
    key, `value=None` removes it instead of setting it. Raises ValueError if
    the image has no A1111 parameters to update.
    """
    meta = read_image_metadata(path)
    params = get_a1111_params(meta)
    if not params:
        raise ValueError(f"{path} has no A1111 parameters to update")
    prompt, negative, settings = parse_a1111_params(params)
    if field == 'prompt':
        prompt = value
    elif field == 'negative_prompt':
        negative = value
    elif value is None:
        settings.pop(field, None)
    else:
        settings[field] = value
    new_params = _rebuild_a1111_params(prompt, negative, settings)

    if meta.get('png_text', {}).get('parameters'):
        meta['png_text']['parameters'] = new_params
    elif meta.get('exif', {}).get(_EXIF_USERCOMMENT_KEY):
        meta['exif'][_EXIF_USERCOMMENT_KEY] = new_params
    elif meta.get('exif', {}).get(_EXIF_DESCRIPTION_KEY):
        meta['exif'][_EXIF_DESCRIPTION_KEY] = new_params
    else:
        meta['comment'] = new_params
    write_image_metadata(path, meta)


# ---------------------------------------------------------------------------
# Dumping / updating
# ---------------------------------------------------------------------------
def dump_metadata(meta, out_path):
    """Write a metadata dict to a JSON file, preserving its provenance fields."""
    keys = ('_file', '_format') + METADATA_KEYS
    dump = {k: meta.get(k) for k in keys}
    with open(out_path, 'w', encoding='utf-8') as fp:
        json.dump(dump, fp, indent=2, ensure_ascii=False, default=str)


def apply_metadata(source, out_path):
    """Replace all metadata in out_path (image or JSON) with `source`."""
    if out_path.lower().endswith('.json'):
        keys = ('_file', '_format') + METADATA_KEYS
        dump = {k: source.get(k) for k in keys}
        dump['_file'] = os.path.basename(out_path)
        dump['_format'] = 'JSON'
        with open(out_path, 'w', encoding='utf-8') as fp:
            json.dump(dump, fp, indent=2, ensure_ascii=False, default=str)
        print(f"Wrote metadata to {out_path}")
        return
    if write_image_metadata(out_path, source):
        print(f"Replaced metadata in {out_path}")
    else:
        print(f"No metadata written to {out_path} (format cannot store it).")


def summarize(meta):
    """A short one-glance summary of what a metadata set contains."""
    lines = []
    params = get_a1111_params(meta)
    if params:
        prompt = parse_a1111_params(params)[0].replace('\n', ' ')
        lines.append(f"  A1111 prompt: {prompt[:70]}"
                     + ("…" if len(prompt) > 70 else ""))
    tags = get_tags(meta)
    if tags:
        lines.append(f"  tags: {', '.join(tags)}")
    lines.append(f"  exif={len(meta.get('exif', {}))} "
                 f"iptc={len(meta.get('iptc', {}))} "
                 f"xmp={len(meta.get('xmp', {}))} "
                 f"png_text={len(meta.get('png_text', {}))} "
                 f"comment={'yes' if meta.get('comment') else 'no'}")
    return '\n'.join(lines)


def list_formats():
    """Print which image formats can be read/written and what metadata survives."""
    def _row(label, items):
        print(f"{label:>22}: {', '.join(sorted(items)) or '(none)'}")

    metadata_capable = sorted(
        f for f in PIL_READ_FORMATS
        if metadata_capabilities(f)['params'])
    print("Image format support (via PIL + pyexiv2/exiv2):")
    _row("readable", PIL_READ_FORMATS)
    _row("writable", PIL_WRITE_FORMATS)
    _row("EXIF/IPTC/XMP", EXIV2_STRUCTURED_FORMATS)
    _row("comment via PIL", PIL_COMMENT_FORMATS)
    print()
    print("Per-format metadata capability (formats that can carry any metadata):")
    for fmt in metadata_capable:
        print(f"  {fmt:12} {_capability_note(fmt)}")


def do_update(in_path, out_path, skip_confirm):
    if not os.path.exists(in_path):
        print(f"Source not found: {in_path}")
        sys.exit(1)
    if not os.path.exists(out_path):
        print(f"Target not found: {out_path}")
        sys.exit(1)
    source = load_metadata(in_path)
    if not skip_confirm:
        print(f"Replace all metadata in {out_path} with metadata from {in_path}:")
        print(summarize(source))
        reply = input("Proceed? [y/N] ").strip().lower()
        if reply not in ('y', 'yes'):
            print("Aborted.")
            return
    apply_metadata(source, out_path)


# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Read, dump, and transplant image metadata.")
    parser.add_argument('paths', nargs='*',
            help="an image or JSON dump (two paths: in_file out_file, with -update)")
    parser.add_argument('-out', '-o', dest='out',
            help="dump the read metadata to this JSON file instead of printing")
    parser.add_argument('-update', '-u', dest='update', action='store_true',
            help="replace all metadata in out_file with metadata from in_file")
    parser.add_argument('-y', '--yes', action='store_true',
            help="skip the -update confirmation prompt (for bulk jobs)")
    parser.add_argument('-formats', '-f', dest='formats', action='store_true',
            help="list readable/writable formats and their metadata capability")
    args = parser.parse_args()

    if args.formats:
        list_formats()
        return

    if args.update:
        if len(args.paths) != 2:
            parser.error("-update needs exactly two paths: in_file out_file")
        do_update(args.paths[0], args.paths[1], args.yes)
        return

    if len(args.paths) != 1:
        parser.error("expected a single path (use -update for two)")
    meta = load_metadata(args.paths[0])
    if args.out:
        dump_metadata(meta, args.out)
        print(f"Wrote metadata from {args.paths[0]} to {args.out}")
    else:
        format_metadata(meta)


if __name__ == '__main__':
    main()
