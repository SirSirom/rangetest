"""
heatmap-service — FastAPI microservice.
Fetches visible points from data-service, spawns worker.py as a subprocess,
returns heatmap cells + triangles.
"""
import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

DATA_URL = os.getenv("DATA_SERVICE_URL", "http://localhost:5001")
WORKER   = [sys.executable, "worker.py"]
TIMEOUT  = 30  # seconds before worker is killed


class ComputeRequest(BaseModel):
    resolution: int = 80


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield

app = FastAPI(title="Meshtastic Heatmap Service", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/compute")
async def compute(req: ComputeRequest):
    """
    Fetch all visible (hidden=false) measurements from data-service,
    aggregate by location, then run scipy computation in a subprocess.
    """
    # 1. Fetch visible rows from data-service
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            resp = await client.get(
                f"{DATA_URL}/measurements",
                params={"hidden": "false", "limit": 100_000},
            )
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Data service unavailable: {e}")

    rows = resp.json()
    if not rows:
        return JSONResponse({"grid_cells": [], "triangles": [], "snr_min": 0, "snr_max": 0})

    # 2. Aggregate per unique RX location (mean SNR)
    by_loc: dict[tuple, list[float]] = {}
    for r in rows:
        key = (round(r["rx_lat"], 7), round(r["rx_lon"], 7))
        by_loc.setdefault(key, []).append(r["rx_snr"])

    points = [
        {"lat": lat, "lon": lon, "snr": sum(snrs) / len(snrs)}
        for (lat, lon), snrs in by_loc.items()
    ]

    # 3. Spawn worker subprocess
    payload = json.dumps({"points": points, "resolution": req.resolution})
    try:
        proc = await asyncio.create_subprocess_exec(
            *WORKER,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(payload.encode()),
            timeout=TIMEOUT,
        )
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(504, "Heatmap worker timed out")
    except Exception as e:
        raise HTTPException(500, f"Worker launch failed: {e}")

    if proc.returncode != 0:
        raise HTTPException(500, f"Worker error: {stderr.decode()[:500]}")

    try:
        result = json.loads(stdout.decode())
    except json.JSONDecodeError as e:
        raise HTTPException(500, f"Worker returned invalid JSON: {e}")

    return JSONResponse(result)
