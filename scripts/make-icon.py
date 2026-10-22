"""Stick Labs icon: dark rounded tile, light stick ring with a gap, green S breaking out of it."""
import base64
import io
import struct

from PIL import Image, ImageDraw

TILE = (13, 15, 18, 255)
RING = (229, 231, 235, 255)
GREEN = (34, 197, 94, 255)


def bezier(p0, p1, p2, p3, n=400):
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        yield (u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
               u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1])


def render(size, bold=False):
    """Drawn on a 140-unit grid (same as the SVG mark), 8x supersampled."""
    k = size * 8 / 140
    img = Image.new("RGBA", (size * 8, size * 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, 140 * k - 1, 140 * k - 1], radius=30 * k, fill=TILE)
    ring, curve, dot = (9, 15, 11) if bold else (5, 11, 8.5)
    r = 46
    d.arc([(70 - r) * k, (70 - r) * k, (70 + r) * k, (70 + r) * k], start=-21, end=290, fill=RING, width=round(ring * k))
    # the S: top bowl from the gap, across the middle, bottom bowl to bottom-left
    segs = [((100, 38), (84, 26), (52, 30), (52, 48)), ((52, 48), (52, 66), (88, 64), (88, 88)), ((88, 88), (88, 110), (56, 112), (42, 100))]
    pts = [q for seg in segs for q in bezier(*seg)]
    w = curve * k
    # stamp round dots along the densely sampled path: a smooth, round-capped stroke
    for x, y in pts:
        d.ellipse([x * k - w / 2, y * k - w / 2, x * k + w / 2, y * k + w / 2], fill=GREEN)
    x, y = pts[0]
    d.ellipse([(x - dot) * k, (y - dot) * k, (x + dot) * k, (y + dot) * k], fill=GREEN)
    return img.resize((size, size), Image.LANCZOS)


def write_ico(path, frames):
    """ICO with classic 32-bit bitmap entries below 256 px and PNG only at 256:
    Explorer's desktop and Start icons stay blank when small entries are PNG."""
    blobs = []
    for im in frames:
        w, h = im.size
        if w >= 256:
            buf = io.BytesIO()
            im.save(buf, format="PNG")
            blobs.append(buf.getvalue())
            continue
        px = im.convert("RGBA").tobytes("raw", "BGRA", 0, -1)  # bottom-up rows
        mask_row = ((w + 31) // 32) * 4
        header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(px) + mask_row * h, 0, 0, 0, 0)
        blobs.append(header + px + bytes(mask_row * h))
    out = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    for im, blob in zip(frames, blobs):
        w, h = im.size
        out += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(out + b"".join(blobs))


big = render(256)
big.save("build/icon.png")
big.save("src/web/icon.png")
sizes = [16, 24, 32, 48, 64, 128, 256]
frames = [render(s, bold=s <= 32) for s in sizes]
for path in ("build/icon.ico", "src/web/icon.ico"):
    write_ico(path, frames)

buf = io.BytesIO()
big.save(buf, format="PNG", optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode()
with open("src/main/trayIcon.ts", "w", encoding="utf-8", newline="\n") as f:
    f.write("﻿// Tray icon, embedded from build/icon.png so the close-to-tray icon exists in dev and\n")
    f.write("// in the packaged app alike (build/ resources are not guaranteed inside the asar).\n")
    f.write("// Regenerate with scripts/make-icon.py.\n")
    f.write(f"export const TRAY_ICON_PNG_BASE64 =\n  '{b64}'\n")
print("icon written")
