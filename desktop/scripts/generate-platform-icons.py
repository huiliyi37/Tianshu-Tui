#!/usr/bin/env python3
"""Generate platform-specific icon sources from the master icon-source.png.

macOS app icons are rounded squircles; Windows app icons are square with no
rounded mask. We keep one master asset (rounded) and generate a square Windows
source by filling the rounded corners with the nearest background color.
"""

from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
SOURCE = ICONS / "icon-source.png"


def make_square_source(img: Image.Image, scale: float = 0.90) -> Image.Image:
    """Create a square Windows-style source from the rounded master.

    Windows app icons are square tiles. We scale the rounded master down slightly
    and center it on a distinctive square background so the tile shape is clear
    on the Windows taskbar / Start menu, while keeping the same constellation
    logo.
    """
    size = img.size[0]
    new_size = int(size * scale)
    scaled = img.resize((new_size, new_size), Image.Resampling.LANCZOS)

    arr = np.array(img)
    # Sample the purple glow from the bottom-left corner of the master and
    # brighten it a little so the square tile is visible against dark surfaces.
    bg = arr[size * 5 // 6 :, : size // 6, :3].mean(axis=(0, 1)).astype(np.uint8)
    bg = np.clip(bg.astype(float) * 1.2 + np.array([5, 0, 15]), 0, 255).astype(np.uint8)
    bg_rgba = tuple(bg.tolist()) + (255,)

    square = Image.new("RGBA", (size, size), bg_rgba)
    offset = (size - new_size) // 2
    square.paste(scaled, (offset, offset), scaled)
    return square


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Source icon not found: {SOURCE}")

    master = Image.open(SOURCE).convert("RGBA")
    if master.size != (1024, 1024):
        master = master.resize((1024, 1024), Image.Resampling.LANCZOS)

    macos_src = ICONS / "icon-source-macos.png"
    windows_src = ICONS / "icon-source-windows.png"

    master.save(macos_src)

    square = make_square_source(master)
    square.save(windows_src)

    print(f"Generated {macos_src}")
    print(f"Generated {windows_src}")


if __name__ == "__main__":
    main()
