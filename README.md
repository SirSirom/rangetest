# Meshtastic Coverage Map

Three-service architecture for visualising Meshtastic range-test data.

```
┌─────────────────────────────────────────────────────┐
│  Browser                                            │
│  Leaflet map + sidebar + settings                   │
└───────────────────┬─────────────────────────────────┘
                    │ HTTP (single origin)
┌───────────────────▼─────────────────────────────────┐
│  frontend  :5000  (Flask)                           │
│  Serves UI, proxies all API calls                   │
└──────────┬──────────────────────┬───────────────────┘
           │                      │
┌──────────▼──────────┐  ┌────────▼────────────────────┐
│  data-service :5001  │  │  heatmap-service :5002       │
│  FastAPI + SQLite    │  │  FastAPI                     │
│  Full CRUD for       │  │  POSTs points to worker.py   │
│  measurements        │  │  (subprocess) → scipy cells  │
└──────────────────────┘  └─────────────────────────────┘
```

## Quick start

```bash
docker compose up --build
```

Open http://localhost:5000

## Services

| Service | Port | Responsibility |
|---------|------|----------------|
| frontend | 5000 | UI + proxy |
| data-service | 5001 | SQLite CRUD, CSV import, dedup |
| heatmap-service | 5002 | Scipy interpolation via subprocess |

## Data service API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/measurements` | List all (supports `?hidden=true/false&sender_id=&limit=&offset=`) |
| POST | `/measurements/import` | Upload CSV (multipart `file`) |
| DELETE | `/measurements` | Wipe all |
| GET | `/measurements/{id}` | Get one |
| PATCH | `/measurements/{id}` | Toggle `{"hidden": true/false}` |
| DELETE | `/measurements/{id}` | Hard delete one |
| GET | `/stats` | Row counts + sender list |

## Heatmap service API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/compute` | `{"resolution": 80}` → grid cells + triangles |

The heatmap service fetches visible rows from data-service itself — the
frontend only needs to POST the resolution setting.

## Duplicate handling

Rows are deduplicated on `(date, time, rx_lat, rx_lon)` at the DB level.
Re-importing the same CSV is always safe.

## Development without Docker

```bash
# Terminal 1
cd data-service && pip install -r requirements.txt
DB_PATH=rangetest.db uvicorn main:app --port 5001

# Terminal 2
cd heatmap-service && pip install -r requirements.txt
DATA_SERVICE_URL=http://localhost:5001 uvicorn main:app --port 5002

# Terminal 3
cd frontend && pip install -r requirements.txt
DATA_SERVICE_URL=http://localhost:5001 \
HEATMAP_SERVICE_URL=http://localhost:5002 \
python app.py
```
