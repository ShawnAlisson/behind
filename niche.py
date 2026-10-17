"""Two Takeaway lessons: NYC bike coach, and SF intersection driving coach."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

DEFAULT_SCENARIO = "bike"

SCENARIOS: dict[str, dict[str, Any]] = {
    "bike": {
        "id": "bike",
        "label": "Bike",
        "location": "new_york",
        "starter": "What should the rider do next?",
        "coach_prefix": (
            "You coach a cyclist on this one clip. "
            "Reply with JSON only, keys look, move, avoid. "
            "Each value is one short sentence under 16 words. "
            "No markdown, no extra keys."
        ),
        "lessons": [
            {
                "match": "GX010001_chunk_0000",
                "title": "USPS parked in the lane",
                "theme": "Blocked lane",
                "cue": "truck-block",
                "look": "A mail truck is sitting in your lane.",
                "move": "Wait, then pass on the open side.",
                "avoid": "Don't squeeze between the truck and the curb.",
            },
            {
                "match": "GOPR0130_chunk_0001",
                "title": "Stopped behind the truck",
                "theme": "Close stop",
                "cue": "hold",
                "look": "You are stopped with a truck ahead.",
                "move": "Hold until the lane is actually open.",
                "avoid": "Don't roll up onto the bumper.",
            },
            {
                "match": "GOPR0130_chunk_0024",
                "title": "Night follow through traffic",
                "theme": "Night riding",
                "cue": "follow",
                "look": "A rider is ahead and cars are beside you.",
                "move": "Keep a gap and hold your line.",
                "avoid": "Don't swing out to pass in the dark.",
            },
            {
                "match": "IMG_0509_chunk_0020",
                "title": "Crowd owns the crossing",
                "theme": "Intersection",
                "cue": "crowd",
                "look": "The crosswalk is full and a van is in it.",
                "move": "Stop before the stripes.",
                "avoid": "Don't thread between people.",
            },
            {
                "match": "VID_20261006_171812_002_chunk_0007",
                "title": "Cone across the crosswalk",
                "theme": "Work zone",
                "cue": "cone",
                "look": "Someone is carrying a cone through the crossing.",
                "move": "Stop and let them clear the stripes.",
                "avoid": "Don't pass a work zone in the crosswalk.",
            },
            {
                "match": "GX050001_chunk_0000",
                "title": "Marked bike lane at dusk",
                "theme": "Bike lane",
                "cue": "lane",
                "look": "You are in a painted bike lane.",
                "move": "Stay in the lane and watch the door side.",
                "avoid": "Don't drift into the traffic lane.",
            },
        ],
    },
    "drive": {
        "id": "drive",
        "label": "Drive",
        "location": "san_francisco",
        "starter": "What should the driver do next?",
        "coach_prefix": (
            "You coach a driver at a San Francisco intersection. "
            "The cameras are separate views, not one synced instant. "
            "Reply with JSON only, keys look, move, avoid. "
            "Each value is one short sentence under 16 words. "
            "No markdown, no extra keys."
        ),
        "lessons": [
            {
                "match": "sf1_chunk_0002",
                "title": "Stop for the crossing",
                "theme": "Camera 1",
                "cue": "stop-line",
                "look": "People are in the crosswalk. Cars are holding.",
                "move": "Stay stopped until the stripes are empty.",
                "avoid": "Don't creep into the crossing.",
            },
            {
                "match": "sf2_chunk_0002",
                "title": "Right turn at the corner",
                "theme": "Camera 2",
                "cue": "right-turn",
                "look": "A box truck is turning across the corner.",
                "move": "Wait until that turn is finished.",
                "avoid": "Don't turn while someone is on the corner.",
            },
            {
                "match": "sf3_chunk_0000",
                "title": "Gap from the right",
                "theme": "Camera 3",
                "cue": "gap",
                "look": "A car is coming through from the right.",
                "move": "Look both ways, then take a clear gap.",
                "avoid": "Don't enter on a closing gap.",
            },
            {
                "match": "sf4_chunk_0000",
                "title": "Scan every corner",
                "theme": "Camera 4",
                "cue": "scan",
                "look": "Crosswalks sit on every side of the box.",
                "move": "Pick a lane and scan the corners.",
                "avoid": "Don't change lanes inside the intersection.",
            },
        ],
    },
    "highway": {
        "id": "highway",
        "label": "Highway",
        "location": "nashville",
        "starter": "What does the other camera show?",
        "coach_prefix": (
            "You watch one highway camera on I-24 scene 1. "
            "Other cameras are different angles of the same scene, not the same second. "
            "Reply with JSON only, keys look, move, avoid. "
            "Each value is one short sentence under 16 words."
        ),
        "lessons": [
            {
                "match": "scene1_p1c1_chunk_0002",
                "title": "Scene 1",
                "theme": "Camera 1",
                "group": "scene1",
                "camera": "1",
                "look": "Road-level view of both directions.",
                "move": "Switch camera if this angle hides the lanes.",
                "avoid": "Don't treat this as the only view of the scene.",
            },
            {
                "match": "scene1_p1c2_chunk_0002",
                "title": "Scene 1",
                "theme": "Camera 2",
                "group": "scene1",
                "camera": "2",
                "look": "Elevated view across the median.",
                "move": "Use this angle to see both carriageways.",
                "avoid": "Don't assume it is the same instant as camera 1.",
            },
            {
                "match": "scene1_p1c3_chunk_0002",
                "title": "Scene 1",
                "theme": "Camera 3",
                "group": "scene1",
                "camera": "3",
                "look": "Overhead view of the same highway scene.",
                "move": "Use this angle when a lane change is clearer from above.",
                "avoid": "Don't expect people on the roadway.",
            },
        ],
    },
}


def scenario_ids() -> list[str]:
    return list(SCENARIOS.keys())


def get_scenario(scenario_id: str | None = None) -> dict[str, Any]:
    sid = (scenario_id or DEFAULT_SCENARIO).strip().lower()
    if sid not in SCENARIOS:
        sid = DEFAULT_SCENARIO
    return deepcopy(SCENARIOS[sid])


def all_lessons() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for scenario in SCENARIOS.values():
        for lesson in scenario["lessons"]:
            row = dict(lesson)
            row["scenario"] = scenario["id"]
            rows.append(row)
    return rows


def lesson_for_filename(filename: str, scenario_id: str | None = None) -> dict[str, Any] | None:
    name = filename or ""
    lessons = all_lessons()
    if scenario_id:
        lessons = [row for row in lessons if row["scenario"] == scenario_id]
    for lesson in lessons:
        if lesson["match"] in name:
            return dict(lesson)
    return None
