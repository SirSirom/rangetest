"""
worker.py — Heatmap computation worker.

Reads a JSON payload from stdin, writes a JSON result to stdout.
Run as a subprocess so heavy scipy work is isolated and can be
killed / resource-limited independently.

Input JSON schema:
{
    "points": [{"lat": f, "lon": f, "snr": f}, ...],
    "resolution": int          // grid cells per axis (20–200)
}

Output JSON schema:
{
    "grid_cells": [
        {"snr": f, "bounds": [[lat_min, lon_min], [lat_max, lon_max]]},
        ...
    ],
    "triangles": [
        {"coords": [[lat, lon], ...], "snr": f},
        ...
    ],
    "snr_min": f,
    "snr_max": f
}
"""
import json
import sys

import numpy as np
from matplotlib.path import Path as MplPath
from scipy.interpolate import LinearNDInterpolator
from scipy.spatial import ConvexHull, Delaunay


def compute(points: list[dict], resolution: int) -> dict:
    if len(points) < 2:
        return {"grid_cells": [], "triangles": [], "snr_min": 0, "snr_max": 0}

    lats = np.array([p["lat"] for p in points])
    lons = np.array([p["lon"] for p in points])
    snrs = np.array([p["snr"] for p in points])

    snr_min = float(snrs.min())
    snr_max = float(snrs.max())

    triangles = _delaunay(lats, lons, snrs)
    grid_cells = _grid(lats, lons, snrs, resolution) if len(points) >= 3 else []

    return {
        "grid_cells": grid_cells,
        "triangles":  triangles,
        "snr_min":    round(snr_min, 2),
        "snr_max":    round(snr_max, 2),
    }


def _delaunay(lats, lons, snrs) -> list[dict]:
    if len(lats) < 3:
        return []
    try:
        tri = Delaunay(np.column_stack([lons, lats]))
    except Exception:
        return []
    return [
        {
            "coords": [[float(lats[i]), float(lons[i])] for i in s],
            "snr":    round(float(snrs[s].mean()), 2),
        }
        for s in tri.simplices
    ]


def _grid(lats, lons, snrs, resolution: int) -> list[dict]:
    pts = np.column_stack([lons, lats])
    try:
        hull     = ConvexHull(pts)
        hull_path = MplPath(pts[hull.vertices])
    except Exception:
        return []

    pad      = 0.001
    grid_lat = np.linspace(lats.min() - pad, lats.max() + pad, resolution)
    grid_lon = np.linspace(lons.min() - pad, lons.max() + pad, resolution)
    glon, glat = np.meshgrid(grid_lon, grid_lat)

    interp   = LinearNDInterpolator(list(zip(lons, lats)), snrs)
    grid_snr = interp(glon, glat)

    flat   = np.column_stack([glon.ravel(), glat.ravel()])
    inside = hull_path.contains_points(flat).reshape(glon.shape)
    grid_snr[~inside] = np.nan

    dlat = (grid_lat[1] - grid_lat[0]) / 2
    dlon = (grid_lon[1] - grid_lon[0]) / 2

    cells = []
    for i in range(len(grid_lat)):
        for j in range(len(grid_lon)):
            v = grid_snr[i, j]
            if np.isnan(v):
                continue
            cells.append({
                "snr": round(float(v), 2),
                "bounds": [
                    [float(grid_lat[i] - dlat), float(grid_lon[j] - dlon)],
                    [float(grid_lat[i] + dlat), float(grid_lon[j] + dlon)],
                ],
            })
    return cells


if __name__ == "__main__":
    payload = json.loads(sys.stdin.read())
    result  = compute(
        points=payload["points"],
        resolution=max(20, min(200, int(payload.get("resolution", 80)))),
    )
    sys.stdout.write(json.dumps(result))
