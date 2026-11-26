"""Persistent cache for credential-free, read-only Overpass interpreter requests."""
from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import math
import os
import sqlite3
import threading
import time
import urllib.parse
from pathlib import Path

ENDPOINTS = {
    ("overpass-api.de", "/api/interpreter"),
    ("overpass.private.coffee", "/api/interpreter"),
    ("maps.mail.ru", "/osm/tools/overpass/api/interpreter"),
}


class OverpassCache:
    def __init__(self, path, *, ttl=30 * 86400, refresh=7 * 86400, clock=time.time):
        if not (math.isfinite(ttl) and math.isfinite(refresh) and 0 < refresh <= ttl):
            raise ValueError("Overpass cache requires 0 < refresh interval <= TTL")
        self.path = Path(path)
        self.ttl, self.refresh, self.clock = ttl, refresh, clock
        self.guard = threading.Lock()
        self.locks = {}

    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        connection = sqlite3.connect(self.path, timeout=2)
        os.chmod(self.path, 0o600)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("""CREATE TABLE IF NOT EXISTS responses (
            key TEXT PRIMARY KEY, request TEXT NOT NULL, response BLOB NOT NULL,
            fetched REAL NOT NULL, attempted REAL NOT NULL, used REAL NOT NULL)""")
        return contextlib.closing(connection)

    @staticmethod
    def identity(url, method, body, headers, redirects):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != "https" or parsed.port not in (None, 443)
                or (parsed.hostname, parsed.path) not in ENDPOINTS
                or parsed.username or parsed.password or parsed.fragment
                or method not in {"GET", "POST"}):
            return None
        # Never persist credentials or merge requests with provider-specific headers.
        safe_headers = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
        if set(safe_headers) - {"content-type", "accept", "user-agent"}:
            return None
        if len(body or b"") > 65536 or len(parsed.query) > 65536:
            return None
        request = {"url": url, "method": method,
                   "body": base64.b64encode(body or b"").decode(),
                   "headers": safe_headers, "redirects": redirects}
        # Mirrors represent the same public dataset. Preserve exact query bytes,
        # encoding, method and headers rather than rounding coordinates or QL.
        logical = {**request, "url": "overpass-interpreter?" + parsed.query, "schema": 1}
        key = hashlib.sha256(json.dumps(logical, sort_keys=True).encode()).hexdigest()
        return key, request

    @contextlib.contextmanager
    def lock(self, key, check):
        with self.guard:
            entry = self.locks.setdefault(key, [threading.Lock(), 0])
            entry[1] += 1
        acquired = False
        try:
            while not acquired:
                check()
                acquired = entry[0].acquire(timeout=0.1)
            yield
        finally:
            if acquired:
                entry[0].release()
            with self.guard:
                entry[1] -= 1
                if not entry[1]:
                    del self.locks[key]

    def read(self, key):
        with self.connect() as db:
            row = db.execute("SELECT response,fetched FROM responses WHERE key=?", (key,)).fetchone()
            if not row or self.clock() - row[1] >= self.ttl:
                return None
            result = json.loads(row[0])
            db.execute("UPDATE responses SET used=? WHERE key=?", (self.clock(), key))
            db.commit()
        return (result["status"], result["headers"], base64.b64decode(result["body"], validate=True), result["url"], 0, 0.0)

    @staticmethod
    def successful(result):
        if result[0] != 200 or len(result[2]) > 16 * 1024 * 1024:
            return False
        try:
            data = json.loads(result[2])
        except (ValueError, UnicodeError):
            return False
        return (isinstance(data, dict) and isinstance(data.get("elements"), list)
                and not any(key in data for key in ("remark", "error", "errors")))

    def save(self, key, request, result, *, touch=True):
        if not self.successful(result):
            return
        # Only response headers relevant to decoding are retained, not cookies.
        headers = {k: v for k, v in result[1].items()
                   if k.lower() in {"content-type", "content-encoding"}}
        response = json.dumps({"status": result[0], "headers": headers,
                               "body": base64.b64encode(result[2]).decode(), "url": result[3]})
        now = self.clock()
        with self.connect() as db:
            db.execute("""INSERT INTO responses VALUES (?,?,?,?,?,?) ON CONFLICT(key)
                DO UPDATE SET request=excluded.request,response=excluded.response,
                fetched=excluded.fetched,attempted=excluded.attempted,
                used=CASE WHEN ? THEN excluded.used ELSE responses.used END""",
                (key, json.dumps(request), response, now, now, now, touch))
            db.commit()

    def fetch(self, url, method, body, headers, redirects, send, check, *, force=False):
        identity = self.identity(url, method, body, headers, redirects)
        if identity is None:
            return send(), "bypass"
        key, request = identity
        # Serve a valid snapshot immediately even while background refresh owns
        # the network lane for this key. No model request waits for refresh.
        if not force:
            try:
                cached = self.read(key)
                if cached is not None:
                    check()
                    return cached, "hit"
            except (OSError, sqlite3.Error, ValueError, KeyError):
                pass
        with self.lock(key, check):
            try:
                if not force:
                    cached = self.read(key)
                    if cached is not None:
                        check()
                        return cached, "hit"
            except (OSError, sqlite3.Error, ValueError, KeyError):
                # Cache is optional; a broken cache must not block ordinary fetches.
                pass
            result = send()
            try:
                self.save(key, request, result, touch=not force)
            except (OSError, sqlite3.Error):
                pass
            return result, "refresh" if force else "miss"

    def refresh_due(self, send, *, limit=50, pause=5, stop=None):
        now = self.clock()
        with self.connect() as db:
            # Unused/expired records are not refreshed forever. Failed refreshes
            # retain old successes and are tried again no sooner than tomorrow.
            rows = db.execute("""SELECT key,request FROM responses WHERE fetched<=?
                AND attempted<=? AND used>? ORDER BY attempted LIMIT ?""",
                (now-self.refresh, now-86400, now-self.ttl, limit)).fetchall()
        refreshed = 0
        for key, raw in rows:
            if stop is not None and stop.is_set():
                break
            with self.connect() as db:
                db.execute("UPDATE responses SET attempted=? WHERE key=?", (self.clock(), key))
                db.commit()
            try:
                request = json.loads(raw)
                self.fetch(request["url"], request["method"], base64.b64decode(request["body"]),
                           request["headers"], request["redirects"],
                           lambda: send(request), lambda: None, force=True)
                refreshed += 1
            except Exception:
                # Failed background traffic must not kill the maintenance loop.
                pass
            if stop is not None:
                if stop.wait(pause):
                    break
            elif pause:
                time.sleep(pause)
        return refreshed
