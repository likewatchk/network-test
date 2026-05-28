"""Synthetic JPEG frame generator for streaming.

Each frame contains:
- Big timestamp + frame# text (visible)
- A moving rotating square (freeze detection)
- A noise tile to give JPEG real high-frequency content
- Configurable target byte size: padding is returned separately so
  bandwidth measurement is honest while the browser still decodes the JPEG.
"""
from __future__ import annotations

import io
import math
import os
import random
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFont

RESOLUTIONS = {
    "480p": (854, 480),
    "720p": (1280, 720),
    "1080p": (1920, 1080),
}


def _load_font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
        "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


@dataclass
class FrameConfig:
    resolution: str = "720p"
    fps: int = 30
    target_kbps: int = 500  # KB/s (per the user's spec "500KB/s default")
    jpeg_quality: int = 80

    @property
    def size(self) -> tuple[int, int]:
        return RESOLUTIONS.get(self.resolution, RESOLUTIONS["720p"])

    @property
    def target_bytes_per_frame(self) -> int:
        return max(1024, int(self.target_kbps * 1024 / max(1, self.fps)))


class FrameGenerator:
    def __init__(self) -> None:
        self._noise_tile = self._make_noise_tile(256, 256)

    @staticmethod
    def _make_noise_tile(w: int, h: int) -> Image.Image:
        raw = bytes(random.getrandbits(8) for _ in range(w * h * 3))
        return Image.frombytes("RGB", (w, h), raw)

    def render(self, cfg: FrameConfig, seq: int, server_ts_us: int) -> tuple[bytes, int]:
        """Return (payload, jpeg_len) where payload == jpeg_bytes + padding.

        The browser decodes the first jpeg_len bytes; padding is purely for
        bandwidth measurement honesty.
        """
        w, h = cfg.size
        img = Image.new("RGB", (w, h), (8, 12, 20))
        draw = ImageDraw.Draw(img)

        t = server_ts_us / 1_000_000.0
        bar_h = max(8, h // 20)
        for i in range(0, h, bar_h):
            phase = (i / h + t * 0.15) % 1.0
            r = int(40 + 60 * math.sin(phase * math.tau))
            g = int(60 + 60 * math.sin(phase * math.tau + 2.0))
            b = int(90 + 60 * math.sin(phase * math.tau + 4.0))
            draw.rectangle(
                [0, i, w, i + bar_h],
                fill=(max(0, r), max(0, g), max(0, b)),
            )

        angle = (t * 0.6) % math.tau
        cx = int(w * 0.75 + math.cos(angle) * w * 0.15)
        cy = int(h * 0.55 + math.sin(angle * 1.3) * h * 0.15)
        sq = min(w, h) // 8
        draw.rectangle(
            [cx - sq, cy - sq, cx + sq, cy + sq],
            fill=(255, 220, 60),
            outline=(0, 0, 0),
            width=4,
        )

        ts_ms = server_ts_us // 1000
        big_px = max(28, h // 14)
        sub_px = max(20, h // 24)
        title_font = _load_font(big_px)
        sub_font = _load_font(sub_px)
        draw.text((24, 24), f"server_ts_ms: {ts_ms}", fill=(255, 255, 255), font=title_font)
        draw.text((24, 24 + big_px + 8), f"frame#: {seq}", fill=(220, 255, 220), font=sub_font)
        draw.text(
            (24, 24 + big_px + 8 + sub_px + 6),
            f"{cfg.resolution} @ {cfg.fps}fps  target {cfg.target_kbps} KB/s",
            fill=(220, 220, 255),
            font=sub_font,
        )

        target = cfg.target_bytes_per_frame
        quality = max(20, min(95, cfg.jpeg_quality))

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality, optimize=False)
        jpeg = buf.getvalue()

        if len(jpeg) < target:
            ox = random.randint(0, max(1, w - self._noise_tile.width))
            oy = random.randint(0, max(1, h - self._noise_tile.height))
            img.paste(self._noise_tile, (ox, oy))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=min(95, quality + 10), optimize=False)
            jpeg = buf.getvalue()

        if len(jpeg) >= target:
            return jpeg, len(jpeg)

        pad = os.urandom(target - len(jpeg))
        return jpeg + pad, len(jpeg)
