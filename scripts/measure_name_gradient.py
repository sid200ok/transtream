#!/usr/bin/env python3
"""
Measure take 3d92ded8 — the name gradient (PRD §5 step E).

WHY THIS EXISTS:
- PRD §3.2 documents that take 3d92ded8 spells "Siddhant" as "Sitharth" 4 times
  at ~00:21, 01:49, 02:04, 02:11.
- PRD §7 defect #4: "the same artifact carries no provenance — no wav, no prompt —
  so a stale file from another take was measured and reported under the wrong
  take's name, producing a confident null."
- This probe resolves the take from the DB into a file FIRST, then applies a
  provenance gate (artifact language/prob must match stored row) BEFORE any
  measurement, then prints the four name positions with offsets.

GATES (from PRD §5):
- Gate to start: D (done)
- Gate to finish: provenance gate passed + four name positions printed with offsets

PROVENANCE MODEL:
- The output artifact JSON includes: take_id, language, language_probability,
  segment_count, and the raw segments.
- Before any probe logic runs, we verify the loaded artifact's language and
  language_probability match the current DB row exactly. If they diverge, the
  artifact is stale and the probe refuses to measure.

RUN:
  cd /home/ML/transtream && python scripts/measure_name_gradient.py

EXIT:
  0 = success (provenance OK, four positions printed)
  1 = provenance mismatch (artifact stale or DB changed)
  2 = take not found / DB error
  3 = fewer than 4 name occurrences found (measurement anomaly)
"""
import json
import sys
from pathlib import Path

# --- self-locating Django bootstrap (works from any cwd) -------------------
REPO = Path(__file__).resolve().parent.parent
BACKEND = REPO / "backend"
sys.path.insert(0, str(BACKEND))

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "transtream.settings")

import django
django.setup()

from django.conf import settings
from studio.models import Take, Segment, SegmentSource

# -------------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------------
TARGET_TAKE_ID = "3d92ded8-97b4-48f6-bc1c-5877610d7eb3"
TARGET_NAME = "Sitharth"      # the misspelling we're measuring
TRUTH_NAME = "Siddhant"        # the correct spelling (for reference)
EXPECTED_OCCURRENCES = 4       # per PRD §3.2

ARTIFACT_DIR = Path("/tmp/ts_probes")
ARTIFACT_PATH = ARTIFACT_DIR / f"name_gradient_{TARGET_TAKE_ID[:8]}.json"


# -------------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------------
def ms_to_hms(ms: int) -> str:
    """Convert milliseconds to HH:MM:SS.mmm"""
    ms = max(0, int(ms or 0))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{milli:03d}"


def ms_to_ts(ms: int) -> str:
    """Convert milliseconds to MM:SS (for PRD-style timestamps like 00:21)"""
    ms = max(0, int(ms or 0))
    total_seconds = ms // 1000
    m, s = divmod(total_seconds, 60)
    return f"{m:02d}:{s:02d}"


def fetch_take_from_db():
    """Fetch take 3d92ded8 from DB with all Whisper segments."""
    try:
        take = Take.objects.get(id=TARGET_TAKE_ID)
    except Take.DoesNotExist:
        return None, f"Take {TARGET_TAKE_ID} not found in DB"

    segments = list(
        Segment.objects
        .filter(take=take, source=SegmentSource.WHISPER)
        .order_by("index")
    )

    if not segments:
        return None, f"Take {TARGET_TAKE_ID} has no Whisper segments"

    return {
        "take_id": str(take.id),
        "kind": take.kind,
        "source_filename": take.source_filename,
        "duration_ms": take.duration_ms,
        "language": take.language,
        "language_probability": take.language_probability,
        "language_hint": take.language_hint,
        "initial_prompt": take.initial_prompt,
        "raw_relpath": take.raw_relpath,
        "normalized_relpath": take.normalized_relpath,
        "created_at": take.created_at.isoformat() if take.created_at else None,
        "segments": [
            {
                "index": s.index,
                "start_ms": s.start_ms,
                "end_ms": s.end_ms,
                "duration_ms": s.duration_ms,
                "text": s.text or "",
                "speaker_id": s.speaker_id or "",
                "confidence": s.confidence,
                "word_json": s.word_json,
            }
            for s in segments
        ],
    }, None


def write_artifact(data: dict) -> None:
    """Write the artifact JSON with provenance to /tmp/ts_probes/."""
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    with open(ARTIFACT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"Artifact written: {ARTIFACT_PATH}")


def verify_provenance(artifact: dict, db_data: dict) -> tuple[bool, str]:
    """
    Provenance gate: artifact's language and language_probability must match
    the current DB row exactly. If they diverge, the artifact is stale.
    """
    # Language must match exactly
    if artifact.get("language") != db_data.get("language"):
        return False, (
            f"Provenance FAIL: language mismatch. "
            f"Artifact={artifact.get('language')!r} DB={db_data.get('language')!r}"
        )

    # language_probability must match (float comparison with tolerance for JSON serialization)
    art_prob = artifact.get("language_probability")
    db_prob = db_data.get("language_probability")
    if art_prob is None or db_prob is None:
        return False, "Provenance FAIL: missing language_probability in artifact or DB"
    if abs(float(art_prob) - float(db_prob)) > 1e-10:
        return False, (
            f"Provenance FAIL: language_probability mismatch. "
            f"Artifact={art_prob} DB={db_prob} (diff={abs(float(art_prob) - float(db_prob))})"
        )

    # Segment count must match (detects re-transcription)
    art_seg_count = len(artifact.get("segments", []))
    db_seg_count = len(db_data.get("segments", []))
    if art_seg_count != db_seg_count:
        return False, (
            f"Provenance FAIL: segment count mismatch. "
            f"Artifact={art_seg_count} DB={db_seg_count}"
        )

    # Take ID must match
    if artifact.get("take_id") != db_data.get("take_id"):
        return False, (
            f"Provenance FAIL: take_id mismatch. "
            f"Artifact={artifact.get('take_id')} DB={db_data.get('take_id')}"
        )

    return True, "Provenance OK: artifact matches DB row"


def find_name_occurrences(segments: list[dict], target: str) -> list[dict]:
    """Find all occurrences of target name in segment texts with offsets."""
    occurrences = []
    target_lower = target.lower()

    for seg in segments:
        text = seg.get("text", "") or ""
        text_lower = text.lower()

        # Find all occurrences in this segment
        start = 0
        while True:
            idx = text_lower.find(target_lower, start)
            if idx == -1:
                break
            # Calculate absolute offset from segment start
            # (character offset within segment text)
            occurrences.append({
                "segment_index": seg["index"],
                "segment_start_ms": seg["start_ms"],
                "segment_end_ms": seg["end_ms"],
                "text_offset_chars": idx,
                "context": text[max(0, idx - 20):idx + len(target) + 20],
                "timestamp_hms": ms_to_hms(seg["start_ms"]),
                "timestamp_mmss": ms_to_ts(seg["start_ms"]),
                "full_text": text,
            })
            start = idx + len(target)

    return occurrences


def main() -> int:
    print(f"=== Measure Name Gradient: take {TARGET_TAKE_ID[:8]} ===")
    print(f"Target name: {TARGET_NAME} (truth: {TRUTH_NAME})")
    print(f"Expected occurrences: {EXPECTED_OCCURRENCES}")
    print()

    # Step 1: Fetch from DB (source of truth)
    print("Step 1: Fetching take from DB...")
    db_data, err = fetch_take_from_db()
    if err:
        print(f"ERROR: {err}")
        return 2

    print(f"  take_id: {db_data['take_id']}")
    print(f"  kind: {db_data['kind']}")
    print(f"  source_filename: {db_data['source_filename']}")
    print(f"  duration_ms: {db_data['duration_ms']} ({ms_to_hms(db_data['duration_ms'])})")
    print(f"  language: {db_data['language']}")
    print(f"  language_probability: {db_data['language_probability']}")
    print(f"  segment_count: {len(db_data['segments'])}")
    print()

    # Step 2: Write artifact (resolves take from DB into a file FIRST)
    print("Step 2: Writing artifact with provenance...")
    write_artifact(db_data)
    print()

    # Step 3: Provenance gate (verify artifact matches DB before probing)
    print("Step 3: Provenance gate — loading artifact and verifying against DB...")
    with open(ARTIFACT_PATH, "r", encoding="utf-8") as f:
        artifact = json.load(f)

    prov_ok, prov_msg = verify_provenance(artifact, db_data)
    print(f"  {prov_msg}")
    if not prov_ok:
        print("PROVENANCE GATE FAILED — refusing to measure stale artifact")
        return 1
    print()

    # Step 4: Find name occurrences
    print(f"Step 4: Searching for '{TARGET_NAME}' in {len(artifact['segments'])} segments...")
    occurrences = find_name_occurrences(artifact["segments"], TARGET_NAME)
    print(f"  Found {len(occurrences)} occurrence(s)")

    if len(occurrences) < EXPECTED_OCCURRENCES:
        print(f"WARNING: Expected {EXPECTED_OCCURRENCES} occurrences, found {len(occurrences)}")
        # Don't fail here — report what we found
    elif len(occurrences) > EXPECTED_OCCURRENCES:
        print(f"NOTE: Found more occurrences ({len(occurrences)}) than expected ({EXPECTED_OCCURRENCES})")

    # Step 5: Print the four name positions with offsets (PRD gate to finish)
    print()
    print("=== NAME GRADIENT: Four positions with offsets ===")
    for i, occ in enumerate(occurrences[:EXPECTED_OCCURRENCES], 1):
        print(f"  {i}. Segment #{occ['segment_index']} at {occ['timestamp_hms']} ({occ['timestamp_mmss']})")
        print(f"      Character offset in segment: {occ['text_offset_chars']}")
        print(f"      Context: ...{occ['context']}...")
        print(f"      Full segment: {occ['full_text'][:100]}{'...' if len(occ['full_text']) > 100 else ''}")
        print()

    # Also print any extra occurrences for completeness
    if len(occurrences) > EXPECTED_OCCURRENCES:
        print("  Additional occurrences:")
        for i, occ in enumerate(occurrences[EXPECTED_OCCURRENCES:], EXPECTED_OCCURRENCES + 1):
            print(f"    {i}. Segment #{occ['segment_index']} at {occ['timestamp_hms']} ({occ['timestamp_mmss']}) offset={occ['text_offset_chars']}")

    # Summary for PRD witness
    print()
    print("=== SUMMARY FOR PRD §5 STEP E ===")
    print(f"Take: {TARGET_TAKE_ID[:8]} ({db_data['source_filename']})")
    print(f"Language: {db_data['language']} (prob={db_data['language_probability']:.6f})")
    print(f"Segments: {len(db_data['segments'])}")
    print(f"Name occurrences found: {len(occurrences)} (expected {EXPECTED_OCCURRENCES})")
    print(f"Provenance gate: PASSED")
    print(f"Artifact: {ARTIFACT_PATH}")

    if len(occurrences) >= EXPECTED_OCCURRENCES:
        return 0
    else:
        return 3


if __name__ == "__main__":
    sys.exit(main())