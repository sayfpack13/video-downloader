"""Generate simple PNG icons for the Chrome extension."""

from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("Install Pillow: pip install pillow")
    raise

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

SIZES = [16, 48, 128]


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (26, 29, 35, 255))
    d = ImageDraw.Draw(img)
    margin = size // 8
    d.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=size // 6,
        fill=(59, 130, 246, 255),
    )
    tri = [
        (size * 0.38, size * 0.32),
        (size * 0.38, size * 0.68),
        (size * 0.72, size * 0.5),
    ]
    d.polygon(tri, fill=(255, 255, 255, 255))
    return img


for s in SIZES:
    draw_icon(s).save(OUT / f"icon{s}.png")
    print(f"Wrote icon{s}.png")
