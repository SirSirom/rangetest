"""
data-service — FastAPI + SQLite CRUD microservice
Handles measurement storage, deduplication, and visibility toggling.
"""
import io
import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse

from models import ImportResult, Measurement, MeasurementPatch

DB_PATH = Path(os.getenv("DB_PATH", "rangetest.db"))

REQUIRED_CSV_COLS = {
    "date", "time", "from", "sender name",
    "sender lat", "sender long",
    "rx lat", "rx long", "rx snr",
}

COL_MAP = {
    "from":          "sender_id",
    "sender name":   "sender_name",
    "sender lat":    "sender_lat",
    "sender long":   "sender_lon",
    "rx lat":        "rx_lat",
    "rx long":       "rx_lon",
    "rx elevation":  "rx_elevation",
    "rx snr":        "rx_snr",
    "distance(m)":   "distance_m",
    "hop limit":     "hop_limit",
}


# ── DB helpers ────────────────────────────────────────────────────────────────

def get_conn() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS measurements (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                date         TEXT    NOT NULL,
                time         TEXT    NOT NULL,
                sender_id    TEXT    NOT NULL,
                sender_name  TEXT    NOT NULL,
                sender_lat   REAL    NOT NULL,
                sender_lon   REAL    NOT NULL,
                rx_lat       REAL    NOT NULL,
                rx_lon       REAL    NOT NULL,
                rx_elevation INTEGER,
                rx_snr       REAL    NOT NULL,
                distance_m   INTEGER,
                hop_limit    INTEGER,
                payload      TEXT,
                hidden       INTEGER NOT NULL DEFAULT 0,
                UNIQUE (date, time, rx_lat, rx_lon)
            )
        """)
        # Non-destructive migration for existing DBs
        try:
            conn.execute(
                "ALTER TABLE measurements ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"
            )
        except Exception:
            pass
        conn.commit()


def row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["hidden"] = bool(d.get("hidden", 0))
    return d


# ── App lifecycle ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(title="Meshtastic Data Service", lifespan=lifespan)


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


# ── Measurements — collection ─────────────────────────────────────────────────

@app.get("/measurements", response_model=list[Measurement])
def list_measurements(
    hidden: Optional[bool] = Query(None, description="Filter by hidden flag"),
    sender_id: Optional[str] = Query(None),
    limit: int = Query(10_000, le=100_000),
    offset: int = Query(0, ge=0),
):
    """
    List measurements with optional filters.
    hidden=true  → only hidden rows
    hidden=false → only visible rows
    hidden omitted → all rows
    """
    clauses, params = [], []
    if hidden is not None:
        clauses.append("hidden = ?")
        params.append(1 if hidden else 0)
    if sender_id is not None:
        clauses.append("sender_id = ?")
        params.append(sender_id)

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params += [limit, offset]

    with get_conn() as conn:
        rows = conn.execute(
            f"SELECT * FROM measurements {where} ORDER BY date, time, id LIMIT ? OFFSET ?",
            params,
        ).fetchall()
    return [row_to_dict(r) for r in rows]


@app.post("/measurements/import", response_model=ImportResult)
async def import_csv(file: UploadFile = File(...)):
    """
    Parse and import a Meshtastic range-test CSV.
    Duplicate rows (same date+time+rx_lat+rx_lon) are silently skipped.
    """
    raw = await file.read()
    try:
        df = pd.read_csv(io.BytesIO(raw))
    except Exception as e:
        raise HTTPException(422, f"Cannot parse CSV: {e}")

    missing = REQUIRED_CSV_COLS - set(df.columns)
    if missing:
        raise HTTPException(422, f"CSV missing columns: {sorted(missing)}")

    df = df.rename(columns=COL_MAP)

    for col in ["rx_lat", "rx_lon", "sender_lat", "sender_lon", "rx_snr"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["rx_lat", "rx_lon", "sender_lat", "sender_lon", "rx_snr"])
    df = df[(df["rx_lat"] != 0) & (df["rx_lon"] != 0)]

    if df.empty:
        raise HTTPException(422, "No valid GPS+SNR rows found in CSV.")

    for col in ["rx_elevation", "distance_m", "hop_limit", "payload"]:
        if col not in df.columns:
            df[col] = None

    inserted = skipped = 0
    with get_conn() as conn:
        for row in df.to_dict(orient="records"):
            try:
                conn.execute("""
                    INSERT INTO measurements
                        (date, time, sender_id, sender_name,
                         sender_lat, sender_lon, rx_lat, rx_lon,
                         rx_elevation, rx_snr, distance_m, hop_limit, payload)
                    VALUES
                        (:date, :time, :sender_id, :sender_name,
                         :sender_lat, :sender_lon, :rx_lat, :rx_lon,
                         :rx_elevation, :rx_snr, :distance_m, :hop_limit, :payload)
                """, row)
                inserted += 1
            except sqlite3.IntegrityError:
                skipped += 1
        conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM measurements").fetchone()[0]
    return ImportResult(inserted=inserted, skipped=skipped, total=total)


@app.delete("/measurements", status_code=204)
def delete_all():
    """Wipe all measurements."""
    with get_conn() as conn:
        conn.execute("DELETE FROM measurements")
        conn.commit()


# ── Measurements — single resource ────────────────────────────────────────────

@app.get("/measurements/{measurement_id}", response_model=Measurement)
def get_measurement(measurement_id: int):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM measurements WHERE id = ?", (measurement_id,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "Measurement not found")
    return row_to_dict(row)


@app.patch("/measurements/{measurement_id}", response_model=Measurement)
def patch_measurement(measurement_id: int, patch: MeasurementPatch):
    """Toggle the hidden flag on a single measurement."""
    with get_conn() as conn:
        result = conn.execute(
            "UPDATE measurements SET hidden = ? WHERE id = ?",
            (1 if patch.hidden else 0, measurement_id),
        )
        conn.commit()
        if result.rowcount == 0:
            raise HTTPException(404, "Measurement not found")
        row = conn.execute(
            "SELECT * FROM measurements WHERE id = ?", (measurement_id,)
        ).fetchone()
    return row_to_dict(row)


@app.delete("/measurements/{measurement_id}", status_code=204)
def delete_measurement(measurement_id: int):
    """Hard-delete a single measurement."""
    with get_conn() as conn:
        result = conn.execute(
            "DELETE FROM measurements WHERE id = ?", (measurement_id,)
        )
        conn.commit()
    if result.rowcount == 0:
        raise HTTPException(404, "Measurement not found")


# ── Stats endpoint (used by frontend sidebar) ─────────────────────────────────

@app.get("/stats")
def stats():
    with get_conn() as conn:
        total   = conn.execute("SELECT COUNT(*) FROM measurements").fetchone()[0]
        visible = conn.execute("SELECT COUNT(*) FROM measurements WHERE hidden=0").fetchone()[0]
        hidden  = conn.execute("SELECT COUNT(*) FROM measurements WHERE hidden=1").fetchone()[0]
        senders = conn.execute(
            "SELECT sender_id, sender_name, sender_lat, sender_lon, COUNT(*) as count "
            "FROM measurements GROUP BY sender_id"
        ).fetchall()
    return {
        "total":   total,
        "visible": visible,
        "hidden":  hidden,
        "senders": [dict(r) for r in senders],
    }
