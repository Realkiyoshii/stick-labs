"""Stick Labs icon: dark rounded tile, orange outer ring, blue crosshair + dot."""
from PIL import Image, ImageDraw

S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded tile
d.rounded_rectangle([4, 4, S - 4, S - 4], radius=52, fill=(11, 13, 18, 255))

cx = cy = S // 2
# orange outer ring (outer threshold nod)
d.ellipse([cx - 88, cy - 88, cx + 88, cy + 88], outline=(245, 181, 68, 255), width=10)
# blue crosshair circle
d.ellipse([cx - 58, cy - 58, cx + 58, cy + 58], outline=(79, 157, 255, 255), width=9)
# crosshair ticks
d.line([cx - 78, cy, cx - 64, cy], fill=(139, 147, 167, 255), width=7)
d.line([cx + 64, cy, cx + 78, cy], fill=(139, 147, 167, 255), width=7)
d.line([cx, cy - 78, cx, cy - 64], fill=(139, 147, 167, 255), width=7)
d.line([cx, cy + 64, cx, cy + 78], fill=(139, 147, 167, 255), width=7)
# center stick dot
d.ellipse([cx - 17, cy - 17, cx + 17, cy + 17], fill=(79, 157, 255, 255))

img.save("build/icon.png")
img.save("build/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon written")
