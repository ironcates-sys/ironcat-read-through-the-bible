#!/usr/bin/env python3
"""Generate simple placeholder PWA icons (no dependencies): a cream cross on deep blue.
Replace public/icons/* with real artwork any time."""
import struct, zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
BG = (31, 42, 58)
FG = (238, 228, 205)
RING = (176, 150, 96)

def render(size, scale):
    """scale = fraction of the canvas used by the artwork (maskable uses a smaller safe zone)."""
    ss = 3  # supersample
    n = size * ss
    c = n / 2
    r_out = n * scale / 2
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    px, py = (x * ss + sx) + 0.5 - c, (y * ss + sy) + 0.5 - c
                    col = BG
                    d = (px * px + py * py) ** 0.5
                    if r_out * 0.92 <= d <= r_out * 0.96:
                        col = RING
                    # cross (vertical bar + upper-set horizontal bar)
                    bw = r_out * 0.12
                    if abs(px) <= bw and -r_out * 0.62 <= py <= r_out * 0.62:
                        col = FG
                    if abs(py + r_out * 0.17) <= bw and abs(px) <= r_out * 0.38:
                        col = FG
                    for i in range(3):
                        acc[i] += col[i]
            row += bytes(int(v / (ss * ss)) for v in acc)
        rows.append(b"\x00" + bytes(row))
    raw = b"".join(rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

for name, size, scale in [("icon-192.png", 192, 0.9), ("icon-512.png", 512, 0.9),
                          ("maskable-512.png", 512, 0.6), ("apple-touch-icon.png", 180, 0.78)]:
    (OUT / name).write_bytes(render(size, scale))
    print("wrote", name)
