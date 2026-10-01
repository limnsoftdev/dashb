"""
canvas_data.py — pure data layer, no Streamlit dependency.

Surfaces assignments that meet EITHER condition:
  - Due within the next 48 hours, OR
  - Marked high-priority (Canvas important_dates flag)

Excludes assignments already submitted or graded.

Import:
    from canvas_data import get_actionable_assignments

CLI (prints JSON to stdout):
    python canvas_data.py
"""

import json
import os
import sys
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

load_dotenv()

CANVAS_TOKEN = os.getenv("CANVAS_TOKEN")
CANVAS_BASE_URL = os.getenv("CANVAS_BASE_URL", "https://canvas.instructure.com").rstrip("/")

if not CANVAS_TOKEN:
    raise EnvironmentError("CANVAS_TOKEN is not set. Add it to your .env file.")

HEADERS = {"Authorization": f"Bearer {CANVAS_TOKEN}"}

SUBMITTED_STATES = {"submitted", "graded", "complete"}
WINDOW_HOURS = 48


def _paginate(url: str, params: dict | None = None) -> list:
    results = []
    params = params or {}
    while url:
        resp = requests.get(url, headers=HEADERS, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list):
            results.extend(data)
        else:
            errors = data.get("errors")
            if errors:
                raise RuntimeError(f"Canvas API error: {errors}")
            results.append(data)
        url = resp.links.get("next", {}).get("url")
        params = {}
    return results


def _active_courses() -> list[dict]:
    url = f"{CANVAS_BASE_URL}/api/v1/courses"
    params = {"enrollment_state": "active", "per_page": 100}
    courses = _paginate(url, params)
    return [c for c in courses if not c.get("access_restricted_by_date")]


def _assignments_for_course(course_id: int) -> list[dict]:
    url = f"{CANVAS_BASE_URL}/api/v1/courses/{course_id}/assignments"
    params = {
        "per_page": 100,
        "order_by": "due_at",
        "include[]": "submission",   # includes per-student submission state
    }
    return _paginate(url, params)


def _is_submitted(assignment: dict) -> bool:
    submission = assignment.get("submission") or {}
    return submission.get("workflow_state") in SUBMITTED_STATES


def _hours_until(due_iso: str) -> float:
    due = datetime.fromisoformat(due_iso)
    delta = (due - datetime.now(timezone.utc)).total_seconds()
    return delta / 3600


def get_actionable_assignments() -> list[dict]:
    """
    Return assignments that are:
      - NOT already submitted/graded
      - Due within 48 hours OR flagged as important_dates in Canvas

    Returns a list of plain, JSON-serializable dicts sorted soonest-first.
    Assignments with no due date but flagged high-priority are appended at the end.

    Keys per item:
        course_id         int
        course_name       str
        id                int
        name              str
        due_at            str | None   ISO-8601 UTC
        hours_until       float | None
        points_possible   float | None
        submission_types  list[str]
        high_priority     bool         True when Canvas important_dates flag is set
        urgency           "critical" | "high" | "normal"
        html_url          str
    """
    now = datetime.now(timezone.utc)
    within_window: list[dict] = []
    high_priority_no_due: list[dict] = []

    for course in _active_courses():
        course_id = course["id"]
        course_name = course.get("name", str(course_id))

        try:
            assignments = _assignments_for_course(course_id)
        except (requests.HTTPError, RuntimeError):
            continue

        for a in assignments:
            # Skip anything the student already turned in
            if _is_submitted(a):
                continue

            due_at = a.get("due_at")
            high_priority = bool(a.get("important_dates"))

            if due_at:
                hours = _hours_until(due_at)
                # Skip already past-due
                if hours <= 0:
                    continue
                # Include only if within 48h window OR high-priority
                if hours > WINDOW_HOURS and not high_priority:
                    continue

                if hours <= 24:
                    urgency = "critical"
                elif hours <= WINDOW_HOURS:
                    urgency = "high"
                else:
                    urgency = "normal"  # high-priority but outside 48h

                within_window.append({
                    "course_id": course_id,
                    "course_name": course_name,
                    "id": a["id"],
                    "name": a.get("name", "Untitled"),
                    "due_at": due_at,
                    "hours_until": round(hours, 2),
                    "points_possible": a.get("points_possible"),
                    "submission_types": a.get("submission_types") or [],
                    "high_priority": high_priority,
                    "urgency": urgency,
                    "html_url": a.get("html_url", ""),
                })

            elif high_priority:
                # No due date but flagged important — surface it
                high_priority_no_due.append({
                    "course_id": course_id,
                    "course_name": course_name,
                    "id": a["id"],
                    "name": a.get("name", "Untitled"),
                    "due_at": None,
                    "hours_until": None,
                    "points_possible": a.get("points_possible"),
                    "submission_types": a.get("submission_types") or [],
                    "high_priority": True,
                    "urgency": "normal",
                    "html_url": a.get("html_url", ""),
                })

    within_window.sort(key=lambda x: x["hours_until"])
    return within_window + high_priority_no_due


if __name__ == "__main__":
    try:
        assignments = get_actionable_assignments()
        print(json.dumps(assignments, indent=2))
    except Exception as e:
        json.dump({"error": str(e)}, sys.stdout, indent=2)
        sys.exit(1)
