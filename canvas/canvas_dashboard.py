import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import streamlit as st
from dotenv import load_dotenv

from canvas_data import get_actionable_assignments

load_dotenv()
LOCAL_TZ = os.getenv("LOCAL_TZ", "America/New_York")

URGENCY_LABEL = {
    "critical": "🔴 Critical",
    "high":     "🟠 High",
    "normal":   "🟢 Normal",
}


@st.cache_data(ttl=300)
def _cached() -> list[dict]:
    return get_actionable_assignments()


def _fmt_due(due_at: str | None, tz_str: str) -> str:
    if not due_at:
        return "—"
    due = datetime.fromisoformat(due_at).astimezone(ZoneInfo(tz_str))
    return due.strftime("%a %b %-d, %-I:%M %p")


def _fmt_countdown(hours: float | None) -> str:
    if hours is None:
        return "—"
    h = int(hours)
    m = int((hours - h) * 60)
    if h >= 24:
        d = h // 24
        rem_h = h % 24
        return f"{d}d {rem_h}h {m}m"
    return f"{h}h {m}m"


def main() -> None:
    st.set_page_config(page_title="Canvas Due Dates", page_icon="📚", layout="wide")
    st.title("📚 Canvas — Actionable Assignments")
    st.caption(
        "Showing assignments due within **48 hours** or marked **high-priority** "
        "— already submitted work is excluded."
    )

    with st.sidebar:
        st.header("Options")
        if st.button("Force refresh"):
            st.cache_data.clear()
            st.rerun()
        st.markdown("---")
        st.markdown(
            "**Urgency key**\n\n"
            "🔴 Critical — due < 24 h\n\n"
            "🟠 High — due within 48 h\n\n"
            "🟢 Normal — high-priority flag, outside 48 h"
        )

    try:
        with st.spinner("Fetching assignments…"):
            rows = _cached()
    except EnvironmentError as e:
        st.error(f"**Configuration error:** {e}")
        st.stop()
    except Exception as e:
        st.error(f"**Canvas API error:** {e}")
        st.stop()

    if not rows:
        st.success("Nothing actionable right now — no assignments due within 48 hours.")
        return

    # Build a display table — one uniform row per assignment
    table_data = []
    for a in rows:
        table_data.append({
            "Urgency":          URGENCY_LABEL[a["urgency"]],
            "Course":           a["course_name"],
            "Assignment":       a["name"],
            "Due":              _fmt_due(a["due_at"], LOCAL_TZ),
            "Time Left":        _fmt_countdown(a["hours_until"]),
            "Points":           f"{a['points_possible']:.0f}" if a["points_possible"] is not None else "—",
            "Type":             ", ".join(a["submission_types"]) or "—",
            "High Priority":    "★" if a["high_priority"] else "",
            "Link":             a["html_url"],
        })

    st.markdown(f"### {len(rows)} assignment{'s' if len(rows) != 1 else ''} need attention")

    # Render the unified table
    # We separate Link out so it stays clickable
    import pandas as pd

    df = pd.DataFrame(table_data)
    link_col = df.pop("Link")

    st.dataframe(
        df,
        use_container_width=True,
        hide_index=True,
        column_config={
            "Urgency":       st.column_config.TextColumn("Urgency",      width="small"),
            "Course":        st.column_config.TextColumn("Course",       width="medium"),
            "Assignment":    st.column_config.TextColumn("Assignment",   width="large"),
            "Due":           st.column_config.TextColumn("Due",          width="medium"),
            "Time Left":     st.column_config.TextColumn("Time Left",    width="small"),
            "Points":        st.column_config.TextColumn("Pts",          width="small"),
            "Type":          st.column_config.TextColumn("Type",         width="medium"),
            "High Priority": st.column_config.TextColumn("★",            width="small"),
        },
    )

    # Clickable links below the table
    st.markdown("#### Assignment Links")
    for a, link in zip(table_data, link_col):
        if link:
            st.markdown(f"- [{a['Assignment']} — {a['Course']}]({link})")

    st.markdown(
        "<div style='text-align:center;color:#555;font-size:0.75rem;margin-top:2rem;'>"
        "Cached 5 min · auto-reloads every 60 s"
        "</div>",
        unsafe_allow_html=True,
    )

    st.markdown(
        "<script>setTimeout(()=>window.location.reload(), 60000)</script>",
        unsafe_allow_html=True,
    )


if __name__ == "__main__":
    main()
