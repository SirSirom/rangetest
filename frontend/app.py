"""
frontend/app.py — Flask app.
Serves the UI and proxies API calls to data-service only.
The browser talks directly to heatmap-service (:5002) for tiles —
no tile proxy needed, works from any device on the network.

HEATMAP_PUBLIC_URL is injected into the page so the browser knows
where to reach heatmap-service. Defaults to the same host as the
frontend but on port 5002, so it just works on a LAN without config.
"""
import os
import requests
from flask import Flask, Response, jsonify, render_template, request

app = Flask(__name__)

DATA_URL           = os.getenv("DATA_SERVICE_URL",    "http://localhost:5001")
HEATMAP_URL        = os.getenv("HEATMAP_SERVICE_URL", "http://localhost:5002")
# Public URL the *browser* uses to reach heatmap-service.
# Leave empty → JS will use window.location.hostname + :5002 (LAN-safe).
# Set explicitly if you run behind a reverse proxy or on a non-standard port.
# Example: HEATMAP_PUBLIC_URL=http://192.168.1.10:5002
HEATMAP_PUBLIC_URL = os.getenv("HEATMAP_PUBLIC_URL", "").rstrip("/")

PROXY_TIMEOUT = 60


def _proxy(method: str, url: str, **kwargs) -> Response:
    try:
        resp = requests.request(method, url, timeout=PROXY_TIMEOUT, **kwargs)
        return Response(
            resp.content,
            status=resp.status_code,
            content_type=resp.headers.get("content-type", "application/json"),
        )
    except requests.exceptions.ConnectionError:
        return jsonify({"error": "Upstream service unavailable"}), 502
    except requests.exceptions.Timeout:
        return jsonify({"error": "Upstream service timed out"}), 504


# ── UI ────────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html", heatmap_public_url=HEATMAP_PUBLIC_URL)


# ── Data-service proxies ──────────────────────────────────────────────────────

@app.route("/api/measurements", methods=["GET"])
def proxy_list_measurements():
    return _proxy("GET", f"{DATA_URL}/measurements", params=request.args)


@app.route("/api/measurements/import", methods=["POST"])
def proxy_import():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "No file"}), 400
    return _proxy("POST", f"{DATA_URL}/measurements/import",
                  files={"file": (f.filename, f.stream, f.mimetype)})


@app.route("/api/measurements", methods=["DELETE"])
def proxy_delete_all():
    return _proxy("DELETE", f"{DATA_URL}/measurements")


@app.route("/api/measurements/<int:mid>", methods=["GET", "PATCH", "DELETE"])
def proxy_single_measurement(mid: int):
    url = f"{DATA_URL}/measurements/{mid}"
    if request.method == "PATCH":
        return _proxy("PATCH", url, json=request.get_json())
    return _proxy(request.method, url)


@app.route("/api/stats", methods=["GET"])
def proxy_stats():
    return _proxy("GET", f"{DATA_URL}/stats")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
