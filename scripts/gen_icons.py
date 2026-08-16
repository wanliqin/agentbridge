#!/usr/bin/env python3
"""生成 AgentBridge 扩展图标（16/48/128）：纯色圆角方块 + 白色字母 A。
只用 stdlib（zlib/struct）手写 PNG 编码，无需 PIL。一次性工具脚本。"""

import struct
import zlib
from pathlib import Path

BG = (37, 99, 235)    # 蓝色底
FG = (255, 255, 255)  # 白色字母

# 5x7 点阵 "A"
GLYPH_A = [
    ".###.",
    "#...#",
    "#...#",
    "#####",
    "#...#",
    "#...#",
    "#...#",
]


def render(size: int) -> bytes:
    px = bytearray()
    margin = size // 8
    glyph_w, glyph_h = 5, 7
    scale = max(1, (size - 2 * margin) // glyph_h)
    ox = (size - glyph_w * scale) // 2
    oy = (size - glyph_h * scale) // 2
    radius = size // 5  # 圆角半径

    for y in range(size):
        px.append(0)  # 每行 filter type 0
        for x in range(size):
            # 圆角判定：角部超出半径的像素透明
            in_corner = False
            for cx, cy in ((radius, radius), (size - radius - 1, radius),
                           (radius, size - radius - 1), (size - radius - 1, size - radius - 1)):
                in_x = (x < radius and cx < size // 2) or (x >= size - radius and cx > size // 2)
                in_y = (y < radius and cy < size // 2) or (y >= size - radius and cy > size // 2)
                if in_x and in_y and (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                    # 只当像素确实落在最近那个角的外侧才算
                    nearest_cx = radius if x < size // 2 else size - radius - 1
                    nearest_cy = radius if y < size // 2 else size - radius - 1
                    if cx == nearest_cx and cy == nearest_cy:
                        in_corner = True
            if in_corner:
                px += bytes((0, 0, 0, 0))
                continue
            gx, gy = (x - ox) // scale, (y - oy) // scale
            on = (0 <= gx < glyph_w and 0 <= gy < glyph_h and GLYPH_A[gy][gx] == "#")
            r, g, b = FG if on else BG
            px += bytes((r, g, b, 255))
    return bytes(px)


def encode_png(size: int, raw: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


out = Path(__file__).resolve().parent.parent / "extension" / "icons"
out.mkdir(parents=True, exist_ok=True)
for size in (16, 48, 128):
    (out / f"icon{size}.png").write_bytes(encode_png(size, render(size)))
    print(f"生成 icons/icon{size}.png")
