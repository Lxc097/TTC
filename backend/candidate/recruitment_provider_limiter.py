"""Provider concurrency caps shared by all workers using the recruitment data directory.

Each active call owns a short SQLite lease. A heartbeat extends long-running
requests; a crashed worker's lease expires instead of blocking the queue forever.
The local semaphore avoids unnecessary database contention in a single worker.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .recruitment_store import data_dir

_schema_lock = threading.Lock()
_ready_paths: set[Path] = set()


class SharedProviderLimit:
    """Reusable context manager with process-local and SQLite-wide limits."""

    def __init__(self, kind: str, limit: int, *, database_path: Path | None = None,
                 lease_seconds: float = 120.0, retry_seconds: float = 0.05):
        if not kind or limit < 1 or lease_seconds <= 0 or retry_seconds <= 0:
            raise ValueError("Invalid provider concurrency limit.")
        self.kind = kind
        self.limit = limit
        self.database_path = database_path
        self.lease_seconds = lease_seconds
        self.retry_seconds = retry_seconds
        self._local_limit = threading.BoundedSemaphore(limit)
        self._held = threading.local()
        self._active: dict[str, Path] = {}
        self._active_lock = threading.Lock()
        self._heartbeat_wakeup = threading.Event()
        self._heartbeat_thread: threading.Thread | None = None

    def _path(self) -> Path:
        configured = os.getenv("PROVIDER_LIMIT_DB_PATH", "").strip()
        path = self.database_path or (Path(configured) if configured else
                                      data_dir() / "provider_limits.sqlite3")
        path = path.resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    @staticmethod
    def _connect(path: Path) -> sqlite3.Connection:
        return sqlite3.connect(path, timeout=10.0)

    @classmethod
    def _ensure_schema(cls, path: Path) -> None:
        with _schema_lock:
            if path in _ready_paths:
                return
            connection = cls._connect(path)
            try:
                connection.execute("""CREATE TABLE IF NOT EXISTS provider_leases (
                    token TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at REAL NOT NULL
                )""")
                connection.execute("CREATE INDEX IF NOT EXISTS provider_leases_kind "
                                   "ON provider_leases(kind, expires_at)")
                connection.commit()
            finally:
                connection.close()
            _ready_paths.add(path)

    def _claim(self, path: Path, token: str) -> bool:
        connection = self._connect(path)
        try:
            connection.execute("BEGIN IMMEDIATE")
            now = time.time()
            connection.execute("DELETE FROM provider_leases WHERE expires_at <= ?", (now,))
            occupied = connection.execute(
                "SELECT COUNT(*) FROM provider_leases WHERE kind = ?", (self.kind,)
            ).fetchone()[0]
            if occupied >= self.limit:
                connection.rollback()
                return False
            connection.execute("INSERT INTO provider_leases(token, kind, expires_at) "
                               "VALUES (?, ?, ?)", (token, self.kind, now + self.lease_seconds))
            connection.commit()
            return True
        finally:
            connection.close()

    def _renew(self, path: Path, token: str) -> None:
        connection = self._connect(path)
        try:
            connection.execute("UPDATE provider_leases SET expires_at = ? WHERE token = ?",
                               (time.time() + self.lease_seconds, token))
            connection.commit()
        finally:
            connection.close()

    def _release(self, path: Path, token: str) -> None:
        connection = self._connect(path)
        try:
            connection.execute("DELETE FROM provider_leases WHERE token = ?", (token,))
            connection.commit()
        finally:
            connection.close()

    def _heartbeat(self) -> None:
        while True:
            self._heartbeat_wakeup.wait(max(0.1, self.lease_seconds / 3))
            with self._active_lock:
                if not self._active:
                    self._heartbeat_thread = None
                    self._heartbeat_wakeup.clear()
                    return
                self._heartbeat_wakeup.clear()
                active = list(self._active.items())
            for token, path in active:
                try:
                    self._renew(path, token)
                except sqlite3.Error:
                    logging.warning("Could not renew %s provider lease", self.kind, exc_info=True)

    def _acquire_slot(self) -> tuple[Path, str]:
        self._local_limit.acquire()
        token = uuid.uuid4().hex
        claimed = False
        try:
            path = self._path()
            self._ensure_schema(path)
            while not self._claim(path, token):
                time.sleep(self.retry_seconds)
            claimed = True
            with self._active_lock:
                self._active[token] = path
                self._heartbeat_wakeup.clear()
                if self._heartbeat_thread is None:
                    self._heartbeat_thread = threading.Thread(
                        target=self._heartbeat, name=f"{self.kind}-provider-lease", daemon=True)
                    self._heartbeat_thread.start()
            return path, token
        except BaseException:
            if claimed:
                with self._active_lock:
                    self._active.pop(token, None)
                try:
                    self._release(path, token)
                except sqlite3.Error:
                    logging.warning("Could not release failed %s provider lease",
                                    self.kind, exc_info=True)
            self._local_limit.release()
            raise

    def _release_slot(self, path: Path, token: str) -> None:
        with self._active_lock:
            self._active.pop(token, None)
            heartbeat = self._heartbeat_thread if not self._active else None
            if heartbeat is not None:
                self._heartbeat_wakeup.set()
        try:
            self._release(path, token)
        except sqlite3.Error:
            # A stale lease expires; never mask the original provider result.
            logging.warning("Could not release %s provider lease", self.kind, exc_info=True)
        finally:
            self._local_limit.release()
        if heartbeat is not None and heartbeat is not threading.current_thread():
            heartbeat.join(timeout=2.0)

    @contextmanager
    def lease(self) -> Iterator[SharedProviderLimit]:
        """Use for generators whose successive iterations may run on different threads."""
        path, token = self._acquire_slot()
        try:
            yield self
        finally:
            self._release_slot(path, token)

    def __enter__(self) -> SharedProviderLimit:
        self._held.stack = getattr(self._held, "stack", []) + [self._acquire_slot()]
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        path, token = self._held.stack.pop()
        self._release_slot(path, token)
