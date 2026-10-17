"""Thin VSS retrieval client (login, search, ask, explore, playback)."""

from __future__ import annotations

import os
import threading
import time
from typing import Any

import requests


class VSSError(RuntimeError):
    pass


class VSSClient:
    def __init__(
        self,
        base_url: str | None = None,
        username: str | None = None,
        password: str | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("VSS_URL") or os.environ.get("INGRESS_URL") or "").rstrip("/")
        self.username = username or os.environ.get("VSS_USERNAME") or os.environ.get("USERNAME") or ""
        self.password = password or os.environ.get("VSS_PASSWORD") or os.environ.get("PASSWORD") or ""
        self._token: str | None = None
        self._token_at = 0.0
        self._lock = threading.Lock()
        if not self.base_url:
            raise VSSError("VSS_URL / INGRESS_URL is not set")

    def _login(self) -> str:
        r = requests.post(
            f"{self.base_url}/api/v1/auth/login",
            json={"username": self.username, "password": self.password},
            timeout=30,
        )
        if r.status_code >= 400:
            raise VSSError(f"login failed: HTTP {r.status_code}")
        token = r.json().get("access_token")
        if not token:
            raise VSSError("login response missing access_token")
        self._token = token
        self._token_at = time.time()
        return token

    def token(self, force: bool = False) -> str:
        with self._lock:
            if force or not self._token or (time.time() - self._token_at) > 50 * 60:
                return self._login()
            return self._token

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token()}"}

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self.base_url}{path}"
        kwargs.setdefault("timeout", 90)
        headers = kwargs.pop("headers", {})
        headers = {**self._headers(), **headers}
        r = requests.request(method, url, headers=headers, **kwargs)
        if r.status_code == 401:
            headers["Authorization"] = f"Bearer {self.token(force=True)}"
            r = requests.request(method, url, headers=headers, **kwargs)
        if r.status_code >= 400:
            raise VSSError(f"{method} {path} → HTTP {r.status_code}: {r.text[:300]}")
        if not r.content:
            return None
        return r.json()

    def me(self) -> dict[str, Any]:
        return self._request("GET", "/api/v1/auth/me")

    def search(
        self,
        query: str,
        *,
        top_k: int = 12,
        llm_top_n: int = 3,
        min_similarity: float = 0.28,
        metadata_filters: dict[str, Any] | None = None,
        tags: list[str] | None = None,
        time_filter: str = "all",
        include_public: bool = True,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "query": query,
            "top_k": top_k,
            "llm_top_n": llm_top_n,
            "min_similarity": min_similarity,
            "time_filter": time_filter,
            "include_public": include_public,
            "metadata_filters": metadata_filters or {},
            "tags": tags or [],
        }
        return self._request("POST", "/api/v1/search", json=body)

    def ask(
        self,
        question: str,
        *,
        original_video: str | None = None,
        top_k: int = 10,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"question": question, "top_k": top_k}
        if original_video:
            body["original_video"] = original_video
        return self._request("POST", "/api/v1/agent/ask", json=body)

    def explore(
        self,
        *,
        scope: str = "all",
        limit: int = 24,
        offset: int = 0,
        location: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"scope": scope, "limit": limit, "offset": offset}
        if location:
            params["location"] = location
        return self._request("GET", "/api/v1/videos/explore", params=params)

    def dashboard(self) -> dict[str, Any]:
        return self._request("GET", "/api/v1/dashboard/stats")

    def playback_url(self, source: str, expires_in: int = 3600) -> dict[str, Any]:
        return self._request(
            "GET",
            "/api/v1/videos/playback-url",
            params={"source": source, "token": self.token(), "expires_in": expires_in},
        )

    def stream_url(self, source: str) -> str:
        from urllib.parse import quote

        return f"{self.base_url}/api/v1/videos/stream?source={quote(source, safe='')}&token={self.token()}"

    def detections(self, source: str) -> dict[str, Any]:
        return self._request("GET", "/api/v1/videos/detections", params={"source": source})

    def synthesize(
        self,
        original_video: str,
        *,
        question: str,
        max_segments: int = 40,
        system_prompt: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "original_video": original_video,
            "question": question,
            "max_segments": max_segments,
        }
        if system_prompt:
            body["system_prompt"] = system_prompt
        return self._request("POST", "/api/v1/videos/synthesize", json=body)
