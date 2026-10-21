"""CroDJ local server: music library, analysis queue and spotDL import."""
import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import mutagen
from flask import Flask, Response, abort, jsonify, request, send_file

import analysis

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
CONFIG_FILE = DATA / "config.json"
CACHE_FILE = DATA / "analysis.json"
AUDIO_EXT = {".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac"}
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

app = Flask(__name__, static_folder=None)
lock = threading.RLock()


def load_json(path, default):
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def save_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), "utf-8")
    tmp.replace(path)


config = load_json(CONFIG_FILE, {})
config.setdefault("folders", [str(ROOT / "music")])
config.setdefault("downloadFolder", str(ROOT / "music" / "Spotify"))
Path(config["downloadFolder"]).mkdir(parents=True, exist_ok=True)
save_json(CONFIG_FILE, config)

cache = load_json(CACHE_FILE, {})
tracks = {}  # id -> track dict
analysis_queue = queue.Queue()
queued = set()


def track_id(path):
    return hashlib.sha1(str(path).lower().encode()).hexdigest()[:16]


def read_tags(path):
    info = {"title": path.stem, "artist": "", "album": "", "genre": "", "year": "",
            "duration": 0, "tagBpm": None}
    try:
        f = mutagen.File(path, easy=True)
    except Exception:
        f = None
    if f is not None:
        def tag(k):
            v = f.get(k) if f.tags is not None else None
            return str(v[0]) if v else ""
        info["title"] = tag("title") or path.stem
        info["artist"] = tag("artist")
        info["album"] = tag("album")
        info["genre"] = tag("genre")
        info["year"] = tag("date")[:4]
        try:
            info["tagBpm"] = float(tag("bpm")) or None
        except ValueError:
            pass
        if f.info is not None:
            info["duration"] = round(getattr(f.info, "length", 0), 2)
    if not info["artist"] and " - " in path.stem:
        info["artist"], info["title"] = path.stem.split(" - ", 1)
    return info


def scan():
    found = {}
    for folder in config["folders"]:
        base = Path(folder)
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if p.suffix.lower() not in AUDIO_EXT or not p.is_file():
                continue
            tid = track_id(p)
            mtime = p.stat().st_mtime
            prev = tracks.get(tid)
            if prev and prev["mtime"] == mtime:
                found[tid] = prev
                continue
            t = {"id": tid, "path": str(p), "mtime": mtime,
                 "source": "spotify" if Path(config["downloadFolder"]) in p.parents else "local",
                 "added": mtime, **read_tags(p)}
            found[tid] = t
    with lock:
        tracks.clear()
        tracks.update(found)
        for t in tracks.values():
            c = cache.get(t["id"])
            if c and c.get("mtime") == t["mtime"]:
                t.update(c["result"])
                t["analyzed"] = True
            else:
                t["analyzed"] = False
                if t["id"] not in queued:
                    queued.add(t["id"])
                    analysis_queue.put(t["id"])


def write_bpm_tag(path, result):
    """Store detected BPM/key back into the file so other DJ apps see it too."""
    try:
        f = mutagen.File(path, easy=True)
        if f is None or f.tags is None:
            return
        f["bpm"] = str(round(result["bpm"]))
        try:
            f["initialkey"] = result["key"]
        except (KeyError, ValueError):
            pass
        f.save()
    except Exception:
        pass


def analysis_worker():
    while True:
        tid = analysis_queue.get()
        with lock:
            t = tracks.get(tid)
        queued.discard(tid)
        if not t:
            continue
        try:
            result = analysis.analyze(t["path"])
        except Exception as e:
            result = {"bpm": t.get("tagBpm") or 0, "firstBeat": 0, "key": "", "camelot": "",
                      "energy": 5, "error": str(e)}
        if t["source"] == "spotify" and not result.get("error"):
            write_bpm_tag(t["path"], result)
        mtime = Path(t["path"]).stat().st_mtime if Path(t["path"]).exists() else t["mtime"]
        with lock:
            t.update(result, analyzed=True, mtime=mtime)
            cache[tid] = {"mtime": mtime, "result": result}
            save_json(CACHE_FILE, cache)


# ---------------------------------------------------------------- spotDL jobs
jobs = {}


def run_spotdl(job):
    out = str(Path(config["downloadFolder"]) / "{artists} - {title}.{output-ext}")
    cmd = [str(Path(sys.executable).with_name("spotdl.exe")), "download", job["url"],
           "--output", out, "--format", "mp3", "--bitrate", "320k"]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace",
                                creationflags=NO_WINDOW,
                                env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        for line in proc.stdout:
            line = line.strip()
            if line:
                job["log"].append(line)
                job["log"] = job["log"][-200:]
        proc.wait()
        job["status"] = "done" if proc.returncode == 0 else "error"
    except Exception as e:
        job["log"].append(str(e))
        job["status"] = "error"
    job["finished"] = time.time()
    scan()


# ---------------------------------------------------------------- routes
@app.get("/")
def index():
    return send_file(WEB / "index.html")


@app.get("/<path:p>")
def static_files(p):
    f = (WEB / p).resolve()
    if WEB not in f.parents or not f.is_file():
        abort(404)
    return send_file(f)


@app.get("/api/tracks")
def api_tracks():
    with lock:
        items = [dict(t) for t in tracks.values()]
    pending = sum(1 for t in items if not t["analyzed"])
    return jsonify({"tracks": items, "pending": pending})


@app.post("/api/rescan")
def api_rescan():
    scan()
    return jsonify(ok=True, count=len(tracks))


@app.get("/api/config")
def api_config():
    return jsonify(config)


@app.post("/api/folders")
def api_folders():
    folder = (request.json or {}).get("folder", "").strip().strip('"')
    if not Path(folder).is_dir():
        return jsonify(error="Folder not found"), 400
    if folder not in config["folders"]:
        config["folders"].append(folder)
        save_json(CONFIG_FILE, config)
    scan()
    return jsonify(config)


@app.delete("/api/folders")
def api_folder_remove():
    folder = (request.json or {}).get("folder")
    if folder in config["folders"]:
        config["folders"].remove(folder)
        save_json(CONFIG_FILE, config)
    scan()
    return jsonify(config)


def get_track(tid):
    with lock:
        t = tracks.get(tid)
    if not t:
        abort(404)
    return t


@app.get("/audio/<tid>")
def audio(tid):
    return send_file(get_track(tid)["path"], conditional=True)


@app.get("/api/cover/<tid>")
def cover(tid):
    path = get_track(tid)["path"]
    try:
        f = mutagen.File(path)
    except Exception:
        f = None
    data, mime = None, "image/jpeg"
    if f is not None and f.tags is not None:
        if hasattr(f, "pictures") and f.pictures:  # FLAC
            data, mime = f.pictures[0].data, f.pictures[0].mime
        elif "covr" in f.tags:  # MP4
            data = bytes(f.tags["covr"][0])
        else:  # ID3
            for k in f.tags.keys():
                if k.startswith("APIC"):
                    data, mime = f.tags[k].data, f.tags[k].mime
                    break
    if not data:
        abort(404)
    return Response(data, mimetype=mime, headers={"Cache-Control": "max-age=86400"})


@app.post("/api/reveal/<tid>")
def reveal(tid):
    path = get_track(tid)["path"]
    subprocess.Popen(["explorer", "/select,", path])
    return jsonify(ok=True)


@app.post("/api/upload")
def api_upload():
    """Files dragged into the app from Explorer are copied to music/Imported."""
    dest = ROOT / "music" / "Imported"
    dest.mkdir(parents=True, exist_ok=True)
    if not any(Path(f) in dest.parents or Path(f) == dest for f in config["folders"]):
        config["folders"].append(str(dest))
        save_json(CONFIG_FILE, config)
    saved = []
    for f in request.files.getlist("files"):
        name = Path(f.filename or "").name
        if Path(name).suffix.lower() not in AUDIO_EXT:
            continue
        target = dest / name
        n = 1
        while target.exists():
            target = dest / f"{Path(name).stem} ({n}){Path(name).suffix}"
            n += 1
        f.save(target)
        saved.append(track_id(target))
    scan()
    return jsonify(ids=saved)


@app.post("/api/spotdl")
def api_spotdl():
    url = (request.json or {}).get("url", "").strip()
    if "spotify.com" not in url and not url.startswith("spotify:"):
        return jsonify(error="Paste a Spotify track, album or playlist link"), 400
    job = {"id": uuid.uuid4().hex[:8], "url": url, "status": "running",
           "log": [], "started": time.time()}
    jobs[job["id"]] = job
    threading.Thread(target=run_spotdl, args=(job,), daemon=True).start()
    return jsonify(job)


@app.get("/api/spotdl")
def api_spotdl_jobs():
    return jsonify(sorted(jobs.values(), key=lambda j: -j["started"]))


if __name__ == "__main__":
    Path(config["folders"][0]).mkdir(parents=True, exist_ok=True)
    scan()
    threading.Thread(target=analysis_worker, daemon=True).start()
    port = int(os.environ.get("PORT", 5180))
    print(f"CroDJ running at http://localhost:{port}")
    app.run(host="127.0.0.1", port=port, threaded=True)
