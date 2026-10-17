"""Takeaway — pick a sample video, digest it, get a practical finding."""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections import OrderedDict
from pathlib import Path

import requests
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

from niche import get_scenario, lesson_for_filename, scenario_ids
from vss_client import VSSClient, VSSError

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8080"))
NICHE_ID = os.environ.get("NICHE_ID", "bike")

app = Flask(__name__)
_vss: VSSClient | None = None


def vss() -> VSSClient:
    global _vss
    if _vss is None:
        _vss = VSSClient()
    return _vss


def _scenario():
    return get_scenario(
        request.args.get("scenario")
        or request.headers.get("X-Scenario")
        or NICHE_ID
    )


def _sample(ch: dict, lesson: dict | None = None) -> dict:
    preview = ch.get("preview_source")
    filename = ch.get("filename") or (ch.get("original_video") or "").split("/")[-1]
    lesson = lesson or lesson_for_filename(filename) or {}
    return {
        "filename": filename,
        "title": lesson.get("title") or filename,
        "theme": lesson.get("theme") or "",
        "cue": lesson.get("cue") or "scan",
        "look": lesson.get("look") or "",
        "move": lesson.get("move") or "",
        "avoid": lesson.get("avoid") or "",
        "scenario": lesson.get("scenario"),
        "original_video": ch.get("original_video"),
        "preview_source": preview,
        "location": ch.get("location"),
        "capture_type": ch.get("capture_type"),
        "camera_id": ch.get("camera_id"),
        "scene": (ch.get("reasoning_content") or "")[:500],
        "group": lesson.get("group") or "",
        "camera": lesson.get("camera") or "",
    }


def _curated_samples(scenario_id: str) -> list[dict]:
    scenario = get_scenario(scenario_id)
    lessons = scenario.get("lessons") or []
    found: dict[str, dict] = {}
    offset = 0
    while len(found) < len(lessons) and offset < 240:
        explore = vss().explore(limit=24, offset=offset, location=scenario.get("location"))
        chunks = explore.get("chunks") or []
        if not chunks:
            break
        for ch in chunks:
            filename = ch.get("filename") or ""
            lesson = lesson_for_filename(filename, scenario["id"])
            if lesson and lesson["match"] not in found:
                found[lesson["match"]] = _sample(ch, lesson)
        offset += 24
    return [found[row["match"]] for row in lessons if row["match"] in found]


@app.get("/health")
def health():
    status = {"ok": True, "niche": NICHE_ID, "product": "Takeaway"}
    try:
        me = vss().me()
        status["vss"] = {"ok": True, "user": me.get("username")}
    except Exception as exc:  # noqa: BLE001
        status["ok"] = False
        status["vss"] = {"ok": False, "error": str(exc)}
    status["wandb"] = bool(os.environ.get("WANDB_API_KEY"))
    status["voice"] = bool(os.environ.get("ELEVENLABS_API_KEY"))
    return jsonify(status), (200 if status["ok"] else 503)


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/styles.css")
def styles():
    return send_from_directory(ROOT, "styles.css")


@app.get("/app.js")
def app_js():
    return send_from_directory(ROOT, "app.js")


@app.get("/api/scenarios")
def api_scenarios():
    rows = []
    for sid in scenario_ids():
        scenario = get_scenario(sid)
        rows.append({"id": scenario["id"], "label": scenario["label"], "starter": scenario["starter"]})
    return jsonify({"scenarios": rows, "active": _scenario()["id"]})


@app.get("/api/samples")
def api_samples():
    scenario = _scenario()
    try:
        samples = _curated_samples(scenario["id"])
        return jsonify(
            {
                "scenario": {
                    "id": scenario["id"],
                    "label": scenario["label"],
                    "starter": scenario["starter"],
                },
                "total": len(samples),
                "samples": samples,
            }
        )
    except VSSError as exc:
        return jsonify({"error": str(exc)}), 502


ACTORS = ("person", "bicycle", "car", "truck", "bus", "motorcycle")


def _tracks_payload(raw: dict) -> dict:
    shape = raw.get("video_shape") or [1080, 1920]
    height = float(shape[0] or 1)
    width = float(shape[1] or 1)
    frames = raw.get("frames") or []
    stride = max(1, len(frames) // 24)
    sampled = []
    for fr in frames[::stride]:
        objects = []
        for det in fr.get("detections") or []:
            label = det.get("label")
            if label not in ACTORS:
                continue
            conf = float(det.get("confidence") or 0)
            if conf < 0.4:
                continue
            box = det.get("bbox") or []
            if len(box) != 4:
                continue
            x1, y1, x2, y2 = [float(v) for v in box]
            objects.append(
                {
                    "label": label,
                    "conf": round(conf, 2),
                    "x": round(x1 / width, 4),
                    "y": round(y1 / height, 4),
                    "w": round(max(0.0, x2 - x1) / width, 4),
                    "h": round(max(0.0, y2 - y1) / height, 4),
                }
            )
        sampled.append({"t": fr.get("time_sec") or 0, "objects": objects})
    return {
        "width": width,
        "height": height,
        "fps": raw.get("fps"),
        "classes": raw.get("object_classes") or [],
        "frames": sampled,
    }


@app.get("/api/tracks")
def api_tracks():
    """Downsampled people and vehicles from the YOLO sidecar, in video time."""
    source = (request.args.get("source") or "").strip()
    if not source:
        return jsonify({"error": "source required"}), 400
    try:
        raw = vss().detections(source)
    except VSSError as exc:
        return jsonify({"frames": [], "note": str(exc)})
    return jsonify(_tracks_payload(raw))


@app.get("/api/signals")
def api_signals():
    """YOLO class counts for the clip preview — the 'what the camera saw' strip."""
    source = (request.args.get("source") or "").strip()
    if not source:
        return jsonify({"error": "source required"}), 400
    try:
        raw = vss().detections(source)
    except VSSError as exc:
        # Missing sidecar is common; the coach still works from the caption.
        return jsonify({"objects": [], "note": str(exc)})
    counts = raw.get("object_counts") or {}
    keep = ("person", "bicycle", "car", "truck", "bus", "motorcycle", "traffic light")
    objects = [
        {"label": name, "count": int(counts[name])}
        for name in keep
        if int(counts.get(name) or 0) > 0
    ]
    return jsonify(
        {
            "objects": objects,
            "detection_count": raw.get("detection_count"),
            "fps": raw.get("fps"),
        }
    )


def _short(text: str, limit: int = 110) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"


def _coach_lines(raw: str, fallback: dict) -> dict[str, str]:
    parsed = None
    text = (raw or "").strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            try:
                parsed = json.loads(match.group(0))
            except json.JSONDecodeError:
                parsed = None
    if not isinstance(parsed, dict):
        parsed = {}
    return {
        "look": _short(str(parsed.get("look") or fallback.get("look") or "")),
        "move": _short(str(parsed.get("move") or fallback.get("move") or "")),
        "avoid": _short(str(parsed.get("avoid") or fallback.get("avoid") or "")),
    }


@app.post("/api/ask")
def api_ask():
    body = request.get_json(force=True, silent=True) or {}
    question = (body.get("question") or "").strip()
    original = (body.get("original_video") or "").strip()
    if not question:
        return jsonify({"error": "question required"}), 400
    if not original:
        return jsonify({"error": "original_video required — ask only works on the selected clip"}), 400
    scenario = get_scenario(body.get("scenario") or _scenario()["id"])
    filename = original.split("/")[-1]
    lesson = lesson_for_filename(filename, scenario["id"]) or {}
    prefix = (scenario.get("coach_prefix") or "").strip()
    coached = f"{prefix}\n\nQuestion: {question}" if prefix else question
    try:
        raw = vss().ask(coached, original_video=original, top_k=int(body.get("top_k", 8)))
        lines = _coach_lines(raw.get("answer") or "", lesson)
        return jsonify({"question": question, **lines})
    except VSSError as exc:
        return jsonify({"error": str(exc)}), 502


_SPEAK_CACHE: OrderedDict[str, bytes] = OrderedDict()


def _speech_text(raw: str) -> str:
    cleaned = re.sub(r"\s+", " ", (raw or "")).strip()
    cleaned = re.sub(r"\b\d+(?:\.\d+)?\s+seconds?\b", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[^A-Za-z0-9 .,?'!-]", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .,")
    return cleaned[:420]


@app.get("/api/voice")
def api_voice():
    return jsonify({"eleven": bool(os.environ.get("ELEVENLABS_API_KEY"))})


@app.post("/api/speak")
def api_speak():
    """ElevenLabs audio for a short description. The key stays on the server."""
    body = request.get_json(force=True, silent=True) or {}
    text = _speech_text(body.get("text") or "")
    if len(text) < 2:
        return jsonify({"error": "text required"}), 400
    key = (os.environ.get("ELEVENLABS_API_KEY") or "").strip()
    if not key:
        return jsonify({"error": "voice unavailable"}), 503
    voice = (os.environ.get("ELEVENLABS_VOICE_ID") or "").strip() or "21m00Tcm4TlvDq8ikWAM"
    digest = hashlib.sha256(f"{voice}|{text}".encode()).hexdigest()
    cached = _SPEAK_CACHE.get(digest)
    if cached is None:
        try:
            upstream = requests.post(
                f"https://api.elevenlabs.io/v1/text-to-speech/{voice}",
                headers={
                    "xi-api-key": key,
                    "Accept": "audio/mpeg",
                    "Content-Type": "application/json",
                },
                json={
                    "text": text,
                    "model_id": "eleven_flash_v2_5",
                    "voice_settings": {"stability": 0.45, "similarity_boost": 0.8},
                },
                timeout=25,
            )
        except requests.RequestException:
            return jsonify({"error": "voice unavailable"}), 502
        if upstream.status_code >= 400 or not upstream.content:
            return jsonify({"error": "voice unavailable"}), 502
        cached = upstream.content
        _SPEAK_CACHE[digest] = cached
        while len(_SPEAK_CACHE) > 48:
            _SPEAK_CACHE.popitem(last=False)
    else:
        _SPEAK_CACHE.move_to_end(digest)
    return Response(cached, mimetype="audio/mpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.post("/api/hear")
def api_hear():
    """Turn the user's recording into text. The key stays on the server."""
    upload = request.files.get("audio")
    if upload is None:
        return jsonify({"error": "audio required"}), 400
    blob = upload.read(2_000_000)
    if len(blob) < 400:
        return jsonify({"error": "audio too short"}), 400
    key = (os.environ.get("ELEVENLABS_API_KEY") or "").strip()
    if not key:
        return jsonify({"error": "voice unavailable"}), 503
    name = upload.filename or "speech.webm"
    mime = upload.mimetype or "audio/webm"
    last_error = 502
    for model in ("scribe_v2", "scribe_v1"):
        try:
            upstream = requests.post(
                "https://api.elevenlabs.io/v1/speech-to-text",
                headers={"xi-api-key": key},
                files={"file": (name, blob, mime)},
                data={"model_id": model},
                timeout=30,
            )
        except requests.RequestException:
            return jsonify({"error": "voice unavailable"}), 502
        if upstream.status_code < 400:
            text = ""
            try:
                text = (upstream.json().get("text") or "").strip()
            except ValueError:
                text = ""
            return jsonify({"text": text[:400]})
        last_error = 502 if upstream.status_code >= 500 else 400
    return jsonify({"error": "voice unavailable"}), last_error


@app.get("/api/proxy")
def api_proxy():
    """Same-origin video proxy (presigned S3 hosts are often unreachable in the browser).

    Safari is strict: duplicate Accept-Ranges / Content-Range headers
    (e.g. ``bytes, bytes``) break HTML5 playback after the bytes=0-1 probe.
    """
    source = request.args.get("source")
    if not source:
        return jsonify({"error": "source required"}), 400
    try:
        upstream = vss().stream_url(source)
    except VSSError as exc:
        return jsonify({"error": str(exc)}), 502

    headers = {}
    if request.headers.get("Range"):
        headers["Range"] = request.headers["Range"]

    try:
        upstream_resp = requests.get(upstream, headers=headers, stream=True, timeout=120)
    except requests.RequestException as exc:
        return jsonify({"error": f"upstream: {exc}"}), 502

    # Rebuild a clean header set — never forward upstream casing duplicates.
    up = {k.lower(): v for k, v in upstream_resp.headers.items()}
    out_headers = {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
    }
    if "content-range" in up:
        # Take only the first value if a proxy already joined duplicates.
        out_headers["Content-Range"] = up["content-range"].split(",")[0].strip()
    if "content-length" in up:
        out_headers["Content-Length"] = up["content-length"].split(",")[0].strip()
    if "etag" in up:
        out_headers["ETag"] = up["etag"].split(",")[0].strip()

    return Response(
        stream_with_context(upstream_resp.iter_content(chunk_size=64 * 1024)),
        status=upstream_resp.status_code,
        headers=out_headers,
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=False)
