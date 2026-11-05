"""
TranStream Speaker Diarization Service (Phase 4).

Provides speaker diarization WITHOUT external ML dependencies by using
Silero VAD segment boundaries as the acoustic signal and grouping speech
regions into speaker turns based on silence-gap heuristics.

Algorithm (simple, dependency-free):
  1. Take VAD segments (start/end ms of speech regions).
  2. Merge adjacent segments separated by short silences (<= GAP_MS) into
     "utterances" — a single speaker rarely pauses mid-sentence for more
     than ~500 ms.
  3. Split utterances into speaker turns at long silences (> GAP_MS):
     consecutive utterances alternate between SPEAKER_00, SPEAKER_01, ...
  4. Map each Whisper segment to a speaker by temporal overlap with turns.

This is deliberately naive: it assumes speaker turns are separated by
noticeable silences, which holds for most turn-taking conversation. For
production-grade diarization (overlapping speech, similar voices), see
Phase 7 (NVIDIA Riva / pyannote).
"""

import logging

logger = logging.getLogger(__name__)

# Two speakers in a row separated by more than this many milliseconds of
# silence are treated as a speaker turn boundary.
GAP_MS = 1200

# Minimum utterance duration to consider as its own turn (filters clicks).
MIN_UTTERANCE_MS = 300


def diarize_vad_segments(vad_segments: list[dict], gap_ms: int = GAP_MS) -> list[dict]:
    """
    Group VAD speech segments into speaker turns.

    Args:
        vad_segments: list of {"start_ms", "end_ms", "duration_ms"} from Silero VAD.
        gap_ms: silence gap (ms) that triggers a speaker turn boundary.

    Returns:
        list of {"start_ms", "end_ms", "speaker": "SPEAKER_00" | "SPEAKER_01" | ...}
    """
    if not vad_segments:
        return []

    # Sort by start time, defensively.
    segs = sorted(vad_segments, key=lambda s: s["start_ms"])

    # Step 1: merge adjacent segments separated by short silences into utterances.
    utterances: list[dict] = []
    cur = {
        "start_ms": segs[0]["start_ms"],
        "end_ms": segs[0]["end_ms"],
    }
    for seg in segs[1:]:
        gap = seg["start_ms"] - cur["end_ms"]
        if gap <= gap_ms:
            cur["end_ms"] = seg["end_ms"]  # same utterance
        else:
            utterances.append(cur)
            cur = {"start_ms": seg["start_ms"], "end_ms": seg["end_ms"]}
    utterances.append(cur)

    # Filter out micro-utterances (clicks).
    utterances = [u for u in utterances if u["end_ms"] - u["start_ms"] >= MIN_UTTERANCE_MS]
    if not utterances:
        return []

    # Step 2: alternate speaker IDs across long silences.
    turns: list[dict] = []
    speaker_idx = 0
    for utt in utterances:
        turns.append({
            "start_ms": utt["start_ms"],
            "end_ms": utt["end_ms"],
            "speaker": f"SPEAKER_{speaker_idx:02d}",
        })
        speaker_idx = 1 - speaker_idx  # toggle 0 <-> 1 (two-speaker assumption)

    logger.info(
        "diarize: %d VAD segs -> %d utterances -> %d turns (speakers: %d)",
        len(vad_segments), len(utterances), len(turns), speaker_idx + 1,
    )
    return turns


def map_whisper_to_speakers(
    whisper_segments: list[dict],
    turns: list[dict],
) -> list[dict]:
    """
    Tag each Whisper segment with a speaker ID by temporal overlap.

    For each Whisper segment, find the turn with the largest overlap and
    assign that speaker. If no turn overlaps, leave speaker_id blank.

    Args:
        whisper_segments: list of {"start_ms", "end_ms", ...} from Whisper.
        turns: diarized turns from diarize_vad_segments().

    Returns:
        The same whisper_segments list with "speaker_id" added to each dict.
    """
    if not turns:
        for seg in whisper_segments:
            seg.setdefault("speaker_id", "")
        return whisper_segments

    for seg in whisper_segments:
        best_turn = None
        best_overlap = 0
        seg_start = seg["start_ms"]
        seg_end = seg["end_ms"]

        for turn in turns:
            overlap_start = max(seg_start, turn["start_ms"])
            overlap_end = min(seg_end, turn["end_ms"])
            overlap = max(0, overlap_end - overlap_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_turn = turn

        seg["speaker_id"] = best_turn["speaker"] if best_turn and best_overlap > 0 else ""

    return whisper_segments


def extract_speaker_names(text: str) -> list[str]:
    """
    Extract candidate speaker identity names from transcript text using
    regex patterns for self-introductions ("Hi, I am Siddhant").

    Returns a de-duplicated list of capitalized names in order of discovery.
    """
    import re

    names: list[str] = []
    patterns = [
        r"(?:hi|hello|hey)[, ]+i (?:am|'m)[, ]+([a-zA-Z]+)",
        r"my name is[, ]+([a-zA-Z]+)",
        r"this is[, ]+([a-zA-Z]+)",
        r"i'm[, ]+([a-zA-Z]+)",
    ]
    for pat in patterns:
        for match in re.finditer(pat, text, flags=re.IGNORECASE):
            name = match.group(1).capitalize()
            if name not in names:
                names.append(name)
    return names
