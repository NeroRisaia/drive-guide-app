"""アプリアイコン（深緑地に、橙の丸と白の「観」）を作る。

    python -I tools/make_icons.py icons
"""
import sys

from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
GREEN = (36, 69, 58, 255)
ORANGE = (194, 87, 26, 255)
WHITE = (255, 255, 255, 255)
FONT_CANDIDATES = ["YuGothB.ttc", "meiryob.ttc"]  # OS のフォントフォルダから探す


def font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def make(size, path):
    img = Image.new("RGBA", (size, size), GREEN)
    d = ImageDraw.Draw(img)
    pad = size // 10
    d.ellipse([pad, pad, size - pad, size - pad], fill=ORANGE)
    d.text((size / 2, size / 2), "観", font=font(int(size * 0.5)), fill=WHITE, anchor="mm")
    img.save(path)


make(192, f"{OUT}/icon-192.png")
make(512, f"{OUT}/icon-512.png")
print("ok")
