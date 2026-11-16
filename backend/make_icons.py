"""生成 PWA 图标（无需外部素材）。"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "icons"
)
os.makedirs(OUT, exist_ok=True)

BLUE = (42, 120, 214)
AQUA = (27, 175, 122)
YELLOW = (237, 161, 0)
INK = (252, 252, 251)


def rounded(size: int, radius_ratio: float, bg=BLUE) -> Image.Image:
    ss = 4  # 超采样
    img = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * ss * radius_ratio)
    d.rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=r, fill=bg)
    return img.resize((size, size), Image.LANCZOS)


def draw_glyph(img: Image.Image) -> Image.Image:
    """日历 + 三条班次条。"""
    size = img.size[0]
    d = ImageDraw.Draw(img)
    u = size / 100.0  # 单位

    # 日历卡
    card = [22 * u, 24 * u, 78 * u, 80 * u]
    d.rounded_rectangle(card, radius=8 * u, fill=INK)

    # 顶部色条
    d.rounded_rectangle([22 * u, 24 * u, 78 * u, 40 * u], radius=8 * u, fill=INK)
    d.rectangle([22 * u, 34 * u, 78 * u, 40 * u], fill=INK)

    # 两个装订环
    ring = (12 * u)
    d.rounded_rectangle([34 * u, 17 * u, 34 * u + ring * 0.8, 32 * u], radius=ring * 0.4, fill=INK)
    d.rounded_rectangle([58 * u, 17 * u, 58 * u + ring * 0.8, 32 * u], radius=ring * 0.4, fill=INK)

    # 三条班次条（不同色）
    bars = [
        (30 * u, 49 * u, 60 * u, 55 * u, BLUE),
        (30 * u, 61 * u, 72 * u, 67 * u, AQUA),
        (30 * u, 73 * u, 52 * u, 79 * u, YELLOW),
    ]
    for x0, y0, x1, y1, color in bars:
        d.rounded_rectangle([x0, y0, x1, y1], radius=(y1 - y0) / 2, fill=color)

    return img


def make(filename: str, size: int, maskable: bool = False) -> None:
    if maskable:
        # maskable：安全区内缩，满底色
        base = Image.new("RGBA", (size, size), BLUE)
        inner = int(size * 0.72)
        glyph = Image.new("RGBA", (inner, inner), (0, 0, 0, 0))
        d = ImageDraw.Draw(glyph)
        u = inner / 100.0
        d.rounded_rectangle([12 * u, 14 * u, 88 * u, 86 * u], radius=14 * u, fill=INK)
        d.rounded_rectangle([20 * u, 36 * u, 80 * u, 40 * u], radius=2 * u, fill=BLUE)
        for i, color in enumerate((BLUE, AQUA, YELLOW)):
            y = 46 + i * 12
            d.rounded_rectangle([20 * u, y * u, (72 - i * 12) * u, (y + 6) * u], radius=3 * u, fill=color)
        offset = (size - inner) // 2
        base.alpha_composite(glyph, (offset, offset))
        base.convert("RGB").save(os.path.join(OUT, filename), "PNG", optimize=True)
        return

    img = rounded(size, 0.22)
    draw_glyph(img)
    img.save(os.path.join(OUT, filename), "PNG", optimize=True)


if __name__ == "__main__":
    make("icon-192.png", 192)
    make("icon-512.png", 512)
    make("icon-maskable-512.png", 512, maskable=True)
    make("apple-touch-icon.png", 180)
    print("icons written to", OUT)
