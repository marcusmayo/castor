#!/usr/bin/env python3
"""orient.py -- normalise image orientation before anything reads it.

A phone photograph records its orientation in EXIF and stores the pixels
sideways. Tesseract ignores EXIF, and so does a raw upload to a vision model,
so both read a rotated page. The tag is not a guess: it is the camera stating
which way up the picture is.

  orient.py <in> <out>            apply the EXIF orientation, if any
  orient.py <in> <out> <degrees>  rotate clockwise by 90 | 180 | 270

Prints ONE line to stdout describing what it did:

  none                  nothing to do; <out> was not written
  exif-orientation-<n>  EXIT tag n applied
  rotate-<n>            explicit rotation applied

Exits non-zero and writes nothing when Pillow is absent, so a caller that has
no imaging library behaves exactly as it did before this file existed.
"""
import sys

EXIF_ORIENTATION = 274


def main(argv):
    if len(argv) < 3:
        sys.stderr.write('usage: orient.py <in> <out> [90|180|270]\n')
        return 2
    src, dst = argv[1], argv[2]
    deg = int(argv[3]) if len(argv) > 3 else None

    try:
        from PIL import Image, ImageOps
    except ImportError:
        sys.stderr.write('Pillow not installed\n')
        return 3

    try:
        im = Image.open(src)
        im.load()
    except Exception as e:                                    # unreadable image
        sys.stderr.write('open failed: %s\n' % str(e)[:120])
        return 4

    if deg is not None:
        if deg not in (90, 180, 270):
            sys.stderr.write('rotation must be 90, 180 or 270\n')
            return 2
        # PIL rotates counter-clockwise; negate so the argument reads clockwise.
        im.rotate(-deg, expand=True).save(dst, format='PNG')
        print('rotate-%d' % deg)
        return 0

    tag = None
    try:
        tag = im.getexif().get(EXIF_ORIENTATION)
    except Exception:
        tag = None
    if not tag or tag == 1:
        print('none')
        return 0

    # exif_transpose handles all eight values, including the mirrored ones.
    ImageOps.exif_transpose(im).save(dst, format='PNG')
    print('exif-orientation-%d' % int(tag))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
