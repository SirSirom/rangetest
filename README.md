# Meshtastic Coverage Map

Three-service architecture for visualising Meshtastic range-test data as an interactive heatmap.

```
┌──────────────────────────────────────────────────────────┐
│  Browser                                                 │
│  Leaflet map + sidebar + settings                        │
└───────────────────┬──────────────────────────────────────┘
                    │ HTTP
         ┌──────────┴──────────┐
         │ data API calls      │ tile requests
         ▼                     ▼
┌────────────────┐    ┌─────────────────────────────────────┐
│ frontend :5000 │    │ heatmap-service :5002               │
│ Flask          │    │ FastAPI                             │
│ Serves UI,     │    │ XYZ PNG tiles (EPSG:3857)           │
│ proxies data   │    │ TileJSON metadata                   │
│ API calls      │    │ Uses data-service for measurements  │
│               │    │ Direct browser access — no proxy    │
└───────┬────────┘    └─────────────────────────────────────┘
        ▼
┌────────────────────┐
│ data-service :5001 │
│ FastAPI + SQLite   │
│ CRUD, CSV import,  │
│ dedup              │
└────────────────────┘
```

The browser fetches tiles **directly** from heatmap-service on port 5002 — this means tile streaming does not pass through the frontend and works correctly from any device on the same network (phone, tablet).

The heatmap-service itself depends on the data-service for measurement data, so data-service must be available for tile rendering.

## Quick start

Use the images built by the CI pipeline from GitHub Container Registry.

```bash
docker compose up -d
```

### Example `docker-compose.yml`

```yml
services:
  frontend:
    image: ghcr.io/sirsirom/rangetest/frontend:latest
    ports:
      - "5000:5000"
    environment:
      - DATA_SERVICE_URL=http://data-service:5001
      - HEATMAP_SERVICE_URL=http://heatmap-service:5002
    depends_on:
      - data-service
      - heatmap-service

  data-service:
    image: ghcr.io/sirsirom/rangetest/data-service:latest
    environment:
      - DB_PATH=/data/rangetest.db
    volumes:
      - data:/data

  heatmap-service:
    image: ghcr.io/sirsirom/rangetest/heatmap-service:latest
    environment:
      - DATA_SERVICE_URL=http://data-service:5001

volumes:
  data:
```

## Quick start for local development

```bash
docker compose up --build -d
```

Open `http://localhost:5000`

From another device on the same network, use the host machine's LAN IP instead of `localhost`.

### Environment variables

| Variable              | Service                   | Default                  | Description                                                                                                                                                                                                     |
| --------------------- | ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_PATH`             | data-service              | `/app/data/rangetest.db` | SQLite database path                                                                                                                                                                                            |
| `DATA_SERVICE_URL`    | frontend, heatmap-service | `http://localhost:5001`  | Internal data-service address                                                                                                                                                                                   |
| `HEATMAP_SERVICE_URL` | frontend                  | `http://localhost:5002`  | Internal heatmap-service address                                                                                                                                                                                |
| `HEATMAP_PUBLIC_URL`  | frontend                  | _(auto)_                 | Public URL the **browser** uses to reach heatmap-service. Leave empty — JS defaults to `window.location.hostname:5002`. Set explicitly when running behind a reverse proxy. Example: `http://192.168.1.10:5002` |

## Services

| Service         | Port | Responsibility                 |
| --------------- | ---- | ------------------------------ |
| frontend        | 5000 | UI, data-service proxy         |
| data-service    | 5001 | SQLite CRUD, CSV import, dedup |
| heatmap-service | 5002 | XYZ tile rendering, TileJSON   |

## Data service API

| Method | Path                   | Description                                                        |
| ------ | ---------------------- | ------------------------------------------------------------------ |
| GET    | `/measurements`        | List all (supports `?hidden=true/false&sender_id=&limit=&offset=`) |
| POST   | `/measurements/import` | Upload CSV (multipart `file`)                                      |
| DELETE | `/measurements`        | Wipe all                                                           |
| GET    | `/measurements/{id}`   | Get one                                                            |
| PATCH  | `/measurements/{id}`   | Toggle `{"hidden": true/false}`                                    |
| DELETE | `/measurements/{id}`   | Hard delete one                                                    |
| GET    | `/stats`               | Row counts + sender list                                           |

## Heatmap service API

| Method | Path                     | Description              |
| ------ | ------------------------ | ------------------------ |
| GET    | `/tiles/{z}/{x}/{y}.png` | XYZ PNG tile (EPSG:3857) |
| GET    | `/tiles/metadata.json`   | TileJSON 2.2 descriptor  |
| POST   | `/invalidate`            | Drop data + tile cache   |
| GET    | `/health`                | Health check             |

### Tile query parameters

All rendering parameters are query strings on the tile URL, so changing appearance requires no server round-trip beyond fetching new tiles.

| Parameter    | Values                                  | Default  | Description                         |
| ------------ | --------------------------------------- | -------- | ----------------------------------- |
| `colorscale` | `rdylbu`, `viridis`, `plasma`, `greens` | `rdylbu` | Color scale                         |
| `invert`     | `0`, `1`                                | `0`      | Invert the color scale              |
| `opacity`    | `0.0` – `1.0`                           | `0.65`   | Tile opacity (baked into PNG alpha) |

Example:

```
http://192.168.1.10:5002/tiles/12/2197/1425.png?colorscale=viridis&opacity=0.8
```

### TileJSON / OsmAnd

The `/tiles/metadata.json` endpoint returns a [TileJSON 2.2](https://github.com/mapbox/tilejson-spec) descriptor. The tile URL template is also shown in the **Settings → External tile layer** panel in the UI.

To add the heatmap as an overlay in **OsmAnd**:

1. _Configure map → Overlay map → Add online source_
2. Use the URL from the export panel, replacing `{z}/{x}/{y}` with `{0}/{1}/{2}`

## CSV format

The importer expects the standard Meshtastic range-test CSV export:

```
date, time, from, sender name, sender lat, sender long, rx lat, rx long, rx elevation, rx snr, distance(m), hop limit, payload
```

Rows are deduplicated on `(date, time, rx_lat, rx_lon)` at the database level. Re-importing the same file is always safe.

## Persistence

Settings (map type, color scale, opacity, invert, show markers) are saved to `localStorage` and restored on reload.

Measurement data is stored in a SQLite database on a named Docker volume (`data-db`) and survives container restarts.

## Development without Docker

```bash
# Terminal 1 — data-service
cd data-service && pip install -r requirements.txt
DB_PATH=rangetest.db uvicorn main:app --port 5001

# Terminal 2 — heatmap-service
cd heatmap-service && pip install -r requirements.txt
DATA_SERVICE_URL=http://localhost:5001 uvicorn main:app --port 5002

# Terminal 3 — frontend
cd frontend && pip install -r requirements.txt
DATA_SERVICE_URL=http://localhost:5001 \
HEATMAP_SERVICE_URL=http://localhost:5002 \
python app.py
```
