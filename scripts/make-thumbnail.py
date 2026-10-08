"""Stick Labs YouTube thumbnail 1280x720 — AMOLED black, blue/orange system."""
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
ARIAL = "C:/Windows/Fonts/arialbd.ttf"
ARIAL_BLACK = "C:/Windows/Fonts/arblack.ttf"

import os
black = ARIAL_BLACK if os.path.exists(ARIAL_BLACK) else ARIAL

img = Image.new("RGB", (W, H), (0, 0, 0))
d = ImageDraw.Draw(img)

# faint grid
for x in range(0, W, 80):
    d.line([x, 0, x, H], fill=(14, 14, 17))
for y in range(0, H, 80):
    d.line([0, y, W, y], fill=(14, 14, 17))

# orange outer ring (right side motif)
cx, cy, r = 1010, 360, 250
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(245, 181, 68), width=14)
d.ellipse([cx - r + 40, cy - r + 40, cx + r - 40, cy + r - 40], outline=(35, 35, 40), width=4)
# blue crosshair
d.ellipse([cx - 120, cy - 120, cx + 120, cy + 120], outline=(79, 157, 255), width=12)
d.line([cx - 170, cy, cx - 135, cy], fill=(139, 147, 167), width=12)
d.line([cx + 135, cy, cx + 170, cy], fill=(139, 147, 167), width=12)
d.line([cx, cy - 170, cx, cy - 135], fill=(139, 147, 167), width=12)
d.line([cx, cy + 135, cx, cy + 170], fill=(139, 147, 167), width=12)
d.ellipse([cx - 34, cy - 34, cx + 34, cy + 34], fill=(79, 157, 255))

# paste app icon top-left of text block
icon = Image.open("build/icon.png").convert("RGBA").resize((150, 150))
img.paste(icon, (70, 90), icon)

f_title = ImageFont.truetype(black, 150)
f_sub = ImageFont.truetype(ARIAL, 72)
f_tag = ImageFont.truetype(ARIAL, 44)

d.text((250, 80), "STICK LABS", font=f_title, fill=(245, 245, 247))
d.text((72, 300), "8K AIM TUNER", font=f_sub, fill=(79, 157, 255))
d.text((72, 400), "G7 PRO 8K  •  G7 PRO  •  TARANTULA", font=f_tag, fill=(161, 161, 166))

# FREE badge
bx0, by0, bx1, by1 = 70, 520, 330, 620
d.rounded_rectangle([bx0, by0, bx1, by1], radius=18, fill=(62, 207, 142))
f_badge = ImageFont.truetype(ARIAL, 60)
d.text((bx0 + 48, by0 + 12), "FREE", font=f_badge, fill=(0, 0, 0))

f_handle = ImageFont.truetype(ARIAL, 44)
d.text((370, 532), "@realkiyoshi", font=f_handle, fill=(110, 110, 115))

img.save("stick-labs-thumbnail.png")
print("saved")
