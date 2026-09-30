#!/usr/bin/env python3
"""Generate short spoken announcement clips ("Isaiah, chapter one.") for every
book/chapter in public/data/plan.json using Piper TTS + ffmpeg.

Setup (one time, not needed to run the app):
  python3 -m venv .tts-venv && .tts-venv/bin/pip install piper-tts
  # download a voice (.onnx + .onnx.json) from https://huggingface.co/rhasspy/piper-voices
  PIPER_VOICE=/path/to/en_US-lessac-medium.onnx .tts-venv/bin/python scripts/generate-announcements.py

Output: public/announce/<bookid>-<chapter>.mp3 (and <bookid>.mp3 for single-chapter
books, plus silence.mp3 used for the optional pause between chapters).
"""
import json, os, subprocess, sys, tempfile, wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "announce"
plan = json.loads((ROOT / "public" / "data" / "plan.json").read_text())
voice_path = os.environ.get("PIPER_VOICE")
if not voice_path:
    sys.exit("Set PIPER_VOICE to a Piper .onnx voice file")

from piper import PiperVoice  # noqa: E402

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()

def words(n):
    if n < 20: return ONES[n]
    if n < 100: return TENS[n // 10] + ("" if n % 10 == 0 else "-" + ONES[n % 10])
    return str(n)

def clip_name(book_id, chapter, single):
    return f"{book_id.lower()}.mp3" if single else f"{book_id.lower()}-{chapter}.mp3"

voice = PiperVoice.load(voice_path)
OUT.mkdir(parents=True, exist_ok=True)
seen = set()
for day in plan["days"]:
    for it in day["items"]:
        single = plan["books"][it["book"]]["chapters"] == 1
        name = clip_name(it["bookId"], it["chapter"], single)
        if name in seen: continue
        seen.add(name)
        text = f"{it['book']}." if single else f"{it['book']}, chapter {words(it['chapter'])}."
        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "a.wav"
            with wave.open(str(wav), "wb") as wf:
                voice.synthesize_wav(text, wf)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav),
                            "-af", "apad=pad_dur=0.35", "-ac", "1", "-ar", "22050",
                            "-codec:a", "libmp3lame", "-b:a", "32k", str(OUT / name)], check=True)
        print(name, "<-", text)

# 1 second of silence, played N times for the optional pause after each chapter
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono",
                "-t", "1", "-codec:a", "libmp3lame", "-b:a", "16k", str(OUT / "silence.mp3")], check=True)
print("done:", len(seen), "clips")
