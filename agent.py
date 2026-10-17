"""Agent layer: turn one-video digest evidence into a practical takeaway via W&B."""

from __future__ import annotations

import json
import os
import re
from typing import Any

import requests

from niche import get_niche


def _wandb_ready() -> bool:
    return bool(os.environ.get("WANDB_API_KEY"))


def _project_header() -> str | None:
    team = os.environ.get("WANDB_TEAM", "").strip()
    project = os.environ.get("WANDB_PROJECT", "").strip()
    if team and project:
        return f"{team}/{project}"
    return None


def list_models() -> list[str]:
    if not _wandb_ready():
        return []
    headers = {"Authorization": f"Bearer {os.environ['WANDB_API_KEY']}"}
    proj = _project_header()
    if proj:
        headers["OpenAI-Project"] = proj
    try:
        r = requests.get("https://api.inference.wandb.ai/v1/models", headers=headers, timeout=30)
        if r.status_code >= 400:
            return []
        data = r.json()
        items = data.get("data") if isinstance(data, dict) else data
        ids = []
        for m in items or []:
            mid = m.get("id") if isinstance(m, dict) else None
            if mid:
                ids.append(mid)
        return ids
    except requests.RequestException:
        return []


def _pick_model() -> str:
    preferred = os.environ.get("WANDB_MODEL", "").strip()
    if preferred:
        return preferred
    ids = list_models()
    for needle in (
        "meta-llama/Llama-3.1-8B-Instruct",
        "Llama-3.1-8B",
        "llama-3.1",
        "gpt-oss",
        "Qwen",
    ):
        for mid in ids:
            if needle.lower() in mid.lower():
                return mid
    return ids[0] if ids else "meta-llama/Llama-3.1-8B-Instruct"


def _extract_json(text: str) -> dict[str, Any] | None:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _heuristic_digest(question: str, digest_payload: dict[str, Any]) -> dict[str, Any]:
    answer = (digest_payload.get("answer") or "").strip()
    ask = (digest_payload.get("ask_answer") or "").strip()
    body = answer or ask
    if not body:
        return {
            "novel": "No digest yet for this clip.",
            "why_it_matters": "The index returned no usable summary for this parent video.",
            "practical_next_step": "Pick another sample, or re-ingest with a richer caption prompt.",
            "audience": "general",
            "confidence": "low",
            "moment_hint": "",
            "open_questions": ["Is this video fully indexed?"],
            "source": "heuristic",
        }
    first = body.split("\n")[0].strip()[:280]
    return {
        "novel": first,
        "why_it_matters": "Drawn from the whole-clip digest — treat as a starting hypothesis for ops review.",
        "practical_next_step": (
            "Review the clip with the team, confirm the finding on video, "
            "then turn it into one checklist or training note."
        ),
        "audience": "ops",
        "confidence": "medium" if len(body) > 120 else "low",
        "moment_hint": "",
        "open_questions": [question[:160]] if question else [],
        "source": "heuristic",
    }


def digest(
    question: str,
    digest_payload: dict[str, Any],
    *,
    niche_id: str | None = None,
    filename: str | None = None,
    location: str | None = None,
) -> dict[str, Any]:
    niche = get_niche(niche_id)
    if not _wandb_ready():
        out = _heuristic_digest(question, digest_payload)
        out["wandb"] = False
        return out

    user = {
        "niche": niche["title"],
        "filename": filename,
        "location": location,
        "lens_question": question,
        "whole_video_digest": (digest_payload.get("answer") or "")[:3500],
        "focused_answer": (digest_payload.get("ask_answer") or "")[:1500],
        "segment_count": digest_payload.get("segment_count"),
    }
    headers = {
        "Authorization": f"Bearer {os.environ['WANDB_API_KEY']}",
        "Content-Type": "application/json",
    }
    proj = _project_header()
    if proj:
        headers["OpenAI-Project"] = proj

    model = _pick_model()
    try:
        r = requests.post(
            "https://api.inference.wandb.ai/v1/chat/completions",
            headers=headers,
            json={
                "model": model,
                "temperature": 0.25,
                "messages": [
                    {"role": "system", "content": niche["agent_system"]},
                    {
                        "role": "user",
                        "content": (
                            "Extract one novel, practical takeaway from this single-video digest:\n"
                            + json.dumps(user)
                        ),
                    },
                ],
            },
            timeout=90,
        )
        if r.status_code >= 400:
            out = _heuristic_digest(question, digest_payload)
            out["wandb"] = False
            out["wandb_error"] = f"HTTP {r.status_code}"
            return out
        content = r.json()["choices"][0]["message"]["content"]
        parsed = _extract_json(content) or {
            "novel": content[:400],
            "why_it_matters": "Model returned non-JSON; stored raw takeaway.",
            "practical_next_step": "Validate on the clip, then brief the team.",
            "audience": "general",
            "confidence": "medium",
            "moment_hint": "",
            "open_questions": [],
        }
        parsed["source"] = "wandb"
        parsed["wandb"] = True
        parsed["model"] = model
        return parsed
    except (requests.RequestException, KeyError, IndexError, TypeError) as exc:
        out = _heuristic_digest(question, digest_payload)
        out["wandb"] = False
        out["wandb_error"] = str(exc)
        return out
