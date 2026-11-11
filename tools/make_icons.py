import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1]


def make(size, path):
    img = Image.new("RGBA", (size, size), (27, 58, 92, 255))
    d = ImageDraw.Draw(img)
    pad = size // 8
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=size // 10, fill=(255, 210, 74, 255))
    cx, cy = size // 2, int(size * 0.42)
    r = size // 6
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255))
    d.polygon([(cx - r * 0.6, cy + r * 0.5), (cx + r * 0.6, cy + r * 0.5), (cx, int(size * 0.72))],
              fill=(255, 255, 255, 255))
    d.ellipse([cx - r // 3, cy - r // 3, cx + r // 3, cy + r // 3], fill=(27, 58, 92, 255))
    img.save(path)


for size in (192, 512):
    make(size, f"{OUT}/icon-{size}.png")
