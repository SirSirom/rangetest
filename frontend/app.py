"""
frontend/app.py — Flask app.
Serves the UI and proxies API calls to data-service and heatmap-service
so the browser only ever talks to one origin.
"""
import os
import requests
from flask import Flask, Response, jsonify, render_template, request, stream_with_context

app = Flask(__name__)

DATA_URL    = os.getenv("DATA_SERVICE_URL",    "http://localhost:5001")
HEATMAP_URL = os.getenv("HEATMAP_SERVICE_URL", "http://localhost:5002")

PROXY_TIMEOUT = 60


def _proxy(method: str, url: str, **kwargs) -> Response:
    """Generic proxy — forward request, stream response back."""
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
    return render_template("index.html")


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


# ── Heatmap-service proxy ─────────────────────────────────────────────────────

@app.route("/api/heatmap", methods=["POST"])
def proxy_heatmap():
    return _proxy("POST", f"{HEATMAP_URL}/compute", json=request.get_json())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
