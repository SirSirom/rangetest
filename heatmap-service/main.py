"""
heatmap-service — FastAPI microservice  (port 5002)

Serves the SNR heatmap as Web Mercator XYZ PNG tiles (EPSG:3857).
Color scale and invert are passed as query parameters so
the frontend never needs to re-request data just to change appearance.

Endpoints
─────────
  GET  /tiles/{z}/{x}/{y}.png   XYZ tiles
                                  ?colorscale=rdylbu|viridis|plasma|greens
                                  &invert=0|1
  GET  /tiles/metadata.json     TileJSON 2.2 descriptor
  POST /invalidate              drop data + tile cache
  GET  /health
"""

import io
import logging
import math
import os
import threading
from typing import Optional

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image
from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator
from scipy.ndimage import gaussian_filter
from scipy.spatial import ConvexHull
from matplotlib.path import Path as MplPath

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("heatmap")

DATA_URL = os.getenv("DATA_SERVICE_URL", "http://localhost:5001")

app = FastAPI(title="Meshtastic Heatmap Service")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


# ── Color scales — match JS COLOR_SCALES exactly ──────────────────────────────

COLOR_SCALES: dict[str, list[tuple[int, int, int]]] = {
    "rdylbu":  [(215,48,39),(252,141,89),(254,224,144),(145,191,219),(69,117,180)],
    "viridis": [(68,1,84),(58,82,139),(32,144,140),(94,201,97),(253,231,37)],
    "plasma":  [(13,8,135),(126,3,167),(204,71,120),(248,149,64),(240,249,33)],
    "greens":  [(247,252,245),(199,233,192),(116,196,118),(35,139,69),(0,68,27)],
}
DEFAULT_SCALE = "rdylbu"


def _colormap(norm: np.ndarray, scale: str, invert: bool) -> np.ndarray:
    """Map normalised [0,1] array → RGBA uint8 (H×W×4)."""
    stops = COLOR_SCALES.get(scale, COLOR_SCALES[DEFAULT_SCALE])
    n     = len(stops) - 1
    h, w  = norm.shape
    out   = np.zeros((h, w, 4), dtype=np.uint8)

    t = norm.copy()
    if invert:
        t = 1.0 - t

    idx  = np.clip(t * n, 0, n)
    lo   = np.floor(idx).astype(int)
    hi   = np.minimum(lo + 1, n)
    frac = (idx - lo)[..., np.newaxis]

    lo_rgb = np.array(stops, dtype=np.float32)[lo]
    hi_rgb = np.array(stops, dtype=np.float32)[hi]
    rgb    = np.clip(lo_rgb + frac * (hi_rgb - lo_rgb), 0, 255).astype(np.uint8)

    out[:, :, :3] = rgb
    out[:, :,  3] = 255
    return out


# ── Data cache ────────────────────────────────────────────────────────────────
#
# We store not just the points list but also the global convex hull path and
# the global SNR min/max.  These are computed once and reused by every tile
# render so that the hull is never recalculated from a per-tile subset
# (which would produce holes and broken polygons at high zoom).

class _DataCache:
    points:    list[dict]          # [{lat, lon, snr}, ...]
    lons:      np.ndarray
    lats:      np.ndarray
    snrs:      np.ndarray
    vmin:      float
    vmax:      float
    hull_path: Optional[MplPath]   # None when < 3 points or degenerate


_cache:      Optional[_DataCache] = None
_cache_lock  = threading.Lock()


async def _get_cache() -> Optional[_DataCache]:
    global _cache
    with _cache_lock:
        if _cache is not None:
            return _cache

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            f"{DATA_URL}/measurements",
            params={"hidden": "false", "limit": 100_000},
        )
        resp.raise_for_status()

    # Aggregate per unique RX location
    by_loc: dict[tuple, list[float]] = {}
    for r in resp.json():
        lat = r.get("rx_lat") or 0.0
        lon = r.get("rx_lon") or 0.0
        snr = r.get("rx_snr")
        if abs(lat) < 1e-4 and abs(lon) < 1e-4:
            continue
        if snr is None:
            continue
        key = (round(lat, 7), round(lon, 7))
        by_loc.setdefault(key, []).append(float(snr))

    if not by_loc:
        with _cache_lock:
            _cache = None
        return None

    points = [
        {"lat": lat, "lon": lon, "snr": sum(v) / len(v)}
        for (lat, lon), v in by_loc.items()
    ]

    lons_a = np.array([p["lon"] for p in points])
    lats_a = np.array([p["lat"] for p in points])
    snrs_a = np.array([p["snr"] for p in points])

    # Build the global convex hull once from ALL points
    hull_path: Optional[MplPath] = None
    if len(points) >= 3:
        pts_2d = np.column_stack([lons_a, lats_a])
        try:
            hull      = ConvexHull(pts_2d)
            hull_path = MplPath(pts_2d[hull.vertices])
        except Exception as e:
            log.warning("ConvexHull failed: %s", e)

    dc            = _DataCache()
    dc.points     = points
    dc.lons       = lons_a
    dc.lats       = lats_a
    dc.snrs       = snrs_a
    dc.vmin       = float(snrs_a.min())
    dc.vmax       = float(snrs_a.max())
    dc.hull_path  = hull_path

    with _cache_lock:
        _cache = dc

    log.info("cached %d aggregated points, vmin=%.1f vmax=%.1f", len(points), dc.vmin, dc.vmax)
    return dc


def _invalidate():
    global _cache
    with _cache_lock:
        _cache = None
    _invalidate_tiles()
    log.info("data + tile cache cleared")


# ── Tile cache ────────────────────────────────────────────────────────────────

_tile_cache: dict[tuple, bytes] = {}
_tile_lock   = threading.Lock()
MAX_TILES    = 8000


def _invalidate_tiles():
    with _tile_lock:
        _tile_cache.clear()


def _evict():
    with _tile_lock:
        if len(_tile_cache) >= MAX_TILES:
            for k in list(_tile_cache.keys())[:MAX_TILES // 4]:
                del _tile_cache[k]


# ── Web Mercator ──────────────────────────────────────────────────────────────

def _tile_bounds(tx: int, ty: int, z: int) -> tuple[float, float, float, float]:
    n = 2 ** z

    def _y2lat(y):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))

    return (
        tx / n * 360.0 - 180.0,
        _y2lat(ty + 1),
        (tx + 1) / n * 360.0 - 180.0,
        _y2lat(ty),
    )


# ── Tile renderer ─────────────────────────────────────────────────────────────

TILE_SIZE  = 256


_EMPTY_PNG: Optional[bytes] = None


def _empty_png() -> bytes:
    global _EMPTY_PNG
    if _EMPTY_PNG is None:
        buf = io.BytesIO()
        Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0)).save(buf, "PNG")
        _EMPTY_PNG = buf.getvalue()
    return _EMPTY_PNG


def _render(z: int, tx: int, ty: int, dc: _DataCache,
            scale: str, invert: bool) -> bytes:

    if len(dc.points) < 3 or dc.hull_path is None:
        return _empty_png()

    lon_min, lat_min, lon_max, lat_max = _tile_bounds(tx, ty, z)

    # ── Hull overlap check ────────────────────────────────────────────────────
    # Probe a grid of points across the tile. At low zoom the entire dataset
    # fits inside one tile as a tiny cluster — corner-only probes miss it.
    probe_n    = 8
    probe_xs   = np.linspace(lon_min, lon_max, probe_n)
    probe_ys   = np.linspace(lat_min, lat_max, probe_n)
    pg, qg     = np.meshgrid(probe_xs, probe_ys)
    tile_probe = np.column_stack([pg.ravel(), qg.ravel()])
    if not dc.hull_path.contains_points(tile_probe).any():
        return _empty_png()

    # ── Always use ALL points for interpolation ───────────────────────────────
    # Context filtering was the source of zoom-out holes: at low zoom a tile
    # covers many degrees but the margin calculation still excluded points just
    # outside the expanded bbox, leaving the interpolator data-starved.
    # Using all points is cheap (datasets are small) and guarantees correct
    # results at every zoom level.
    lons_c, lats_c, snrs_c = dc.lons, dc.lats, dc.snrs

    # ── Build pixel grid ──────────────────────────────────────────────────────
    # Fixed 128-px internal grid — upscaled to 256 for the PNG.
    # Smooth enough at all zooms without per-zoom branching.
    res = 128
    glon, glat = np.meshgrid(
        np.linspace(lon_min, lon_max, res),
        np.linspace(lat_max, lat_min, res),   # lat decreases top→bottom
    )

    # ── Interpolate with linear, fill gaps with nearest ───────────────────────
    # LinearNDInterpolator leaves NaN outside its own convex hull of points.
    # NearestNDInterpolator fills those remaining NaNs so the gaussian blur
    # has a complete field to work with — hull masking removes the excess later.
    coords = list(zip(lons_c, lats_c))
    interp_lin  = LinearNDInterpolator(coords, snrs_c)
    interp_near = NearestNDInterpolator(coords, snrs_c)
    grid_snr    = interp_lin(glon, glat)
    nan_from_lin = np.isnan(grid_snr)
    if nan_from_lin.any():
        grid_snr[nan_from_lin] = interp_near(glon[nan_from_lin], glat[nan_from_lin])

    # ── Mask to global convex hull ────────────────────────────────────────────
    flat   = np.column_stack([glon.ravel(), glat.ravel()])
    inside = dc.hull_path.contains_points(flat).reshape(glon.shape)
    grid_snr[~inside] = np.nan

    if np.all(np.isnan(grid_snr)):
        return _empty_png()

    # ── Gaussian smooth ───────────────────────────────────────────────────────
    # Sigma scales with zoom: wide blur when zoomed out, tight when zoomed in.
    sigma    = max(1.0, 8.0 - z * 0.4)
    nan_mask = np.isnan(grid_snr)
    filled   = np.where(nan_mask, float(np.nanmean(grid_snr)), grid_snr)
    smoothed = gaussian_filter(filled, sigma=sigma)
    grid_snr = np.where(nan_mask, np.nan, smoothed)

    # ── Normalise using GLOBAL min/max ────────────────────────────────────────
    vmin, vmax = dc.vmin, dc.vmax
    norm = (
        np.clip((grid_snr - vmin) / (vmax - vmin), 0.0, 1.0)
        if vmax != vmin
        else np.where(nan_mask, np.nan, 0.5)
    )

    rgba = _colormap(np.where(nan_mask, 0.0, norm), scale, invert)
    rgba[nan_mask, 3] = 0   # transparent outside hull

    img = Image.fromarray(rgba, "RGBA")
    if res != TILE_SIZE:
        img = img.resize((TILE_SIZE, TILE_SIZE), Image.BILINEAR)

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/invalidate")
async def invalidate():
    _invalidate()
    return {"status": "cache cleared"}


@app.get("/tiles/metadata.json")
async def tile_metadata():
    dc = await _get_cache()
    if dc and dc.points:
        pad  = 0.05
        bbox = [
            float(dc.lons.min()) - pad, float(dc.lats.min()) - pad,
            float(dc.lons.max()) + pad, float(dc.lats.max()) + pad,
        ]
        center = [
            round((bbox[0]+bbox[2])/2, 5),
            round((bbox[1]+bbox[3])/2, 5),
            10,
        ]
    else:
        bbox   = [-180, -90, 180, 90]
        center = [0, 0, 2]

    return {
        "tilejson":    "2.2.0",
        "name":        "Meshtastic SNR Heatmap",
        "description": "Signal-to-noise ratio heatmap from Meshtastic range-test data",
        "version":     "1.0.0",
        "scheme":      "xyz",
        "tiles":       ["__TILE_BASE__/tiles/{z}/{x}/{y}.png"],
        "minzoom":     1,
        "maxzoom":     18,
        "bounds":      bbox,
        "center":      center,
        "format":      "png",
        "crs":         "EPSG:3857",
    }


@app.get("/tiles/{z}/{x}/{y}.png")
async def get_tile(
    z: int, x: int, y: int,
    colorscale: str = Query(DEFAULT_SCALE, alias="colorscale"),
    invert:     int = Query(0,             alias="invert"),
):
    if not (0 <= z <= 18):
        raise HTTPException(400, "zoom out of range")

    colorscale = colorscale if colorscale in COLOR_SCALES else DEFAULT_SCALE
    inv_bool   = bool(invert)

    cache_key = (z, x, y, colorscale, inv_bool)

    with _tile_lock:
        cached = _tile_cache.get(cache_key)
    if cached:
        return Response(cached, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=300"})

    dc  = await _get_cache()
    png = _render(z, x, y, dc, colorscale, inv_bool) \
          if dc else _empty_png()

    _evict()
    with _tile_lock:
        _tile_cache[cache_key] = png

    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=300"})
