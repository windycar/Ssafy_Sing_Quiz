# SCX data recovery notes

The supplied `.scx` is a 99,279,334-byte StarCraft MPQ archive. It is protected: the normal listfile and internal filenames are replaced with synthetic names. Read-only inspection found 3,244 archive entries and a 2,869,552-byte valid `scenario.chk` payload beginning with the standard `VER ` section.

The CHK contains valid UTF-8 song strings embedded in trigger data. `tools/extract-scx-song-text.py` recovered 171 complete `artist - title` records without extracting or copying any embedded audio. A few source strings are incomplete in the map itself, so `data/songs.recovered.json` must be reviewed before production use.

The SCX does not provide web-playable URLs. Hosts must supply licensed media URLs and 5–15 second `clipStart`/`clipEnd` values. All recovered records intentionally leave those fields empty.

Run the text recovery after extracting the CHK with a StormLib-compatible MPQ tool:

```powershell
python tools/extract-scx-song-text.py scenario.chk data/songs.recovered.json
```

