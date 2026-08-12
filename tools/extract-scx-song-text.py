"""Recover song/artist strings from an extracted StarCraft scenario.chk.

Usage:
    python tools/extract-scx-song-text.py scenario.chk data/songs.recovered.json

The protected source map uses synthetic MPQ filenames, so extract the largest
valid CHK payload with a StormLib-compatible MPQ reader first. This script does
not extract or copy audio; it only scans valid UTF-8 text runs.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

RUN = re.compile(r"[가-힣A-Za-z0-9()][가-힣A-Za-z0-9 .,_()!&+~:/\-'%]{3,}")
EXCLUDED = ("Terran", "Protoss", "Zerg", "Brood Wars", "TOP10", "TOP 10", "Music")


def clean_candidate(value: str) -> str | None:
    value = " ".join(value.split()).strip(" ._,-")
    if " - " not in value or not re.search(r"[가-힣]", value):
        return None
    if not 4 <= len(value) <= 120 or any(token in value for token in EXCLUDED):
        return None
    value = value.removeprefix("엔딩곡은 ").removesuffix(" 입니다")
    artist, title = value.split(" - ", 1)
    if not artist or not title or title.endswith("Feat"):
        return None
    return f"{artist.strip()} - {title.strip()}"


def recover(path: Path) -> list[dict[str, object]]:
    decoded = path.read_bytes().decode("utf-8", errors="ignore")
    seen: set[str] = set()
    songs: list[dict[str, object]] = []
    for match in RUN.finditer(decoded):
        candidate = clean_candidate(match.group())
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        artist, title = candidate.split(" - ", 1)
        songs.append({
            "id": f"scx-{len(songs) + 1:03d}",
            "artist": artist,
            "title": title,
            "aliases": [title],
            "mediaUrl": None,
            "clipStart": None,
            "clipEnd": None,
            "source": "scenario.chk UTF-8 recovery",
        })
    return songs


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: extract-scx-song-text.py INPUT.chk OUTPUT.json")
    source, output = map(Path, sys.argv[1:])
    songs = recover(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"count": len(songs), "songs": songs}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"recovered {len(songs)} song strings -> {output}")


if __name__ == "__main__":
    main()

