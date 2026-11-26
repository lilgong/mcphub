"""Persistent, exact-request cache for public arXiv Atom query responses."""
from __future__ import annotations

import base64
from concurrent.futures import Future, TimeoutError as FutureTimeout, CancelledError
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET
import zlib

MAX_BYTES = 16 * 1024 * 1024
ATOM = '{http://www.w3.org/2005/Atom}'
SEARCH = '{http://a9.com/-/spec/opensearch/1.1/}'
PARAMETERS = {'search_query', 'id_list', 'start', 'max_results', 'sortBy', 'sortOrder'}


class ArxivQueryCache:
    def __init__(self, path, *, ttl=86400, clock=time.time):
        if not math.isfinite(ttl) or ttl <= 0:
            raise ValueError('arXiv cache TTL must be positive and finite')
        self.path, self.ttl, self.clock = Path(path), ttl, clock
        self.guard, self.flights = threading.Lock(), {}

    @staticmethod
    def identity(url, method, body, headers, redirects):
        parsed = urllib.parse.urlsplit(url)
        safe = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
        if (parsed.scheme != 'https' or parsed.hostname not in {'export.arxiv.org', 'arxiv.org', 'www.arxiv.org'}
                or parsed.path != '/api/query' or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.fragment
                or set(safe) - {'content-type', 'accept', 'user-agent', 'host', 'connection',
                                'accept-encoding', 'content-length'}
                or len(parsed.query) > 65536 or len(body or b'') > 65536):
            return None
        if method == 'GET':
            if body:
                return None
        elif method == 'POST':
            if safe.get('content-type', '').split(';')[0].strip().lower() != 'application/x-www-form-urlencoded':
                return None
        else:
            return None
        try:
            pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
            if body:
                pairs += urllib.parse.parse_qsl(body.decode('utf-8'), keep_blank_values=True)
        except UnicodeError:
            return None
        # Do not persist unknown query parameters that might contain credentials.
        if not pairs or any(name not in PARAMETERS for name, _ in pairs):
            return None
        request = {'url': url, 'method': method, 'body': base64.b64encode(body or b'').decode(),
                   'headers': safe, 'redirects': redirects, 'schema': 1}
        # Preserve exact encoding, parameter order, pagination and sort semantics.
        return hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()

    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        db = sqlite3.connect(self.path, timeout=2)
        try:
            os.chmod(self.path, 0o600)
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, response TEXT NOT NULL, fetched REAL NOT NULL)')
            db.execute('CREATE INDEX IF NOT EXISTS responses_fetched ON responses(fetched)')
        except BaseException:
            db.close()
            raise
        return contextlib.closing(db)

    def read(self, key):
        with self.connect() as db:
            row = db.execute('SELECT response,fetched FROM responses WHERE key=?', (key,)).fetchone()
        if not row or self.clock() - row[1] >= self.ttl:
            return None
        value = json.loads(row[0])
        return (value['status'], value['headers'], base64.b64decode(value['body'], validate=True),
                value['url'], 0, 0.0)

    @staticmethod
    def successful(result):
        if result[0] != 200 or len(result[2]) > MAX_BYTES:
            return False
        raw = result[2]
        headers = {k.lower(): v for k, v in result[1].items()}
        encoding = headers.get('content-encoding', '').strip().lower()
        try:
            if encoding in {'gzip', 'deflate'}:
                decoder = zlib.decompressobj(31 if encoding == 'gzip' else 15)
                raw = decoder.decompress(raw, MAX_BYTES + 1)
                if len(raw) > MAX_BYTES or not decoder.eof or decoder.unused_data:
                    return False
            elif encoding not in {'', 'identity'}:
                return False
            if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
                return False
            feed = ET.fromstring(raw)
            if feed.tag != ATOM + 'feed':
                return False
            for field in ['totalResults', 'startIndex', 'itemsPerPage']:
                if int(feed.findtext(SEARCH + field, '-1')) < 0:
                    return False
            if not feed.findtext(ATOM + 'id') or not feed.findtext(ATOM + 'updated'):
                return False
            total, start, size = (int(feed.findtext(SEARCH + field)) for field in ['totalResults', 'startIndex', 'itemsPerPage'])
            entries = feed.findall(ATOM + 'entry')
            if len(entries) != min(size, max(0, total - start)):
                return False
            for entry in entries:
                identity = entry.findtext(ATOM + 'id', '')
                if not identity or '/api/errors' in identity:
                    return False
            return True
        except (ET.ParseError, ValueError, zlib.error):
            return False

    def save(self, key, result):
        if not self.successful(result):
            return
        headers = {k: v for k, v in result[1].items()
                   if k.lower() in {'content-type', 'content-encoding'}}
        value = json.dumps({'status': result[0], 'headers': headers,
                            'body': base64.b64encode(result[2]).decode(), 'url': result[3]})
        now = self.clock()
        with self.connect() as db:
            db.execute('DELETE FROM responses WHERE fetched<=?', (now - self.ttl,))
            db.execute('INSERT OR REPLACE INTO responses VALUES (?,?,?)', (key, value, now))
            db.commit()

    def fetch(self, url, method, body, headers, redirects, send, check):
        key = self.identity(url, method, body, headers, redirects)
        if key is None:
            return send(), 'bypass'
        try:
            cached = self.read(key)
        except (OSError, sqlite3.Error, ValueError, KeyError):
            cached = None
        if cached is not None:
            check()
            return cached, 'hit'
        with self.guard:
            leader = key not in self.flights
            flight = self.flights.setdefault(key, Future())
        if not leader:
            while True:
                check()
                try:
                    result = flight.result(timeout=.1)
                    check()
                    # Shared errors are not stored and are not cache hits.
                    return (*result[:4], 0, 0.0), 'coalesced'
                except FutureTimeout:
                    if flight.done():
                        raise
                except CancelledError:
                    # One disconnected caller must not cancel other callers.
                    return self.fetch(url, method, body, headers, redirects, send, check)
        try:
            check()
            try:
                cached = self.read(key)
            except (OSError, sqlite3.Error, ValueError, KeyError):
                cached = None
            if cached is not None:
                flight.set_result(cached)
                return cached, 'hit'
            result = send()
            try:
                self.save(key, result)
            except (OSError, sqlite3.Error, ValueError):
                pass
            flight.set_result(result)
            return result, 'miss'
        except BaseException as error:
            if type(error).__name__ == 'RelayRequestCancelled':
                with self.guard:
                    if self.flights.get(key) is flight:
                        self.flights.pop(key)
                flight.cancel()
            else:
                flight.set_exception(error)
            raise
        finally:
            with self.guard:
                if self.flights.get(key) is flight:
                    self.flights.pop(key)
