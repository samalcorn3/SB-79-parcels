#!/usr/bin/env python3
"""Pull the current text of Gov. Code §§ 65912.155–65912.162 (SB 79, as amended)
from the Legislative Counsel's official leginfo database export and compare it
with the copy the site's standards were built from.

leginfo.legislature.ca.gov blocks scripted access, but the Legislative Counsel
publishes the same database at https://downloads.leginfo.legislature.ca.gov/.
Only the needed members of the 1.2 GB session archive are read, using HTTP
range requests.

    python3 scripts/statute.py            # check: exit 0 if unchanged, 3 if amended
    python3 scripts/statute.py --update   # rewrite data/statute/* from leginfo

Standard library only.
"""
import hashlib
import html
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

ARCHIVE = "https://downloads.leginfo.legislature.ca.gov/pubinfo_2025.zip"
SECTIONS = [f"65912.{n}" for n in range(155, 163)]
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "statute")
UA = {"User-Agent": "sb79-parcels-statute-check"}


class HttpRangeFile(io.RawIOBase):
    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, method="HEAD", headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            self.size = int(r.headers["Content-Length"])
            self.modified = r.headers.get("Last-Modified")

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, b):
        if not len(b) or self.pos >= self.size:
            return 0
        end = min(self.pos + len(b), self.size) - 1
        req = urllib.request.Request(self.url, headers={**UA, "Range": f"bytes={self.pos}-{end}"})
        with urllib.request.urlopen(req, timeout=180) as r:
            data = r.read()
        b[: len(data)] = data
        self.pos += len(data)
        return len(data)


def lob_to_text(raw):
    t = raw.decode("utf-8", "ignore")
    t = re.sub(r"<(/p|br)[^>]*>", "\n", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t)
    t = re.sub(r"[ \t]+", " ", t)
    # leginfo wraps long paragraphs; rejoin lines that do not start a new subdivision
    t = re.sub(r"\n(?!\()", " ", t)
    return "\n".join(line.strip() for line in t.split("\n") if line.strip())


def fetch():
    src = HttpRangeFile(ARCHIVE)
    zf = zipfile.ZipFile(io.BufferedReader(src, buffer_size=1 << 20))
    table = zf.read("LAW_SECTION_TBL.dat").decode("utf-8", "ignore")
    out = {}
    for row in table.split("\n"):
        cols = [c.strip("`") for c in row.split("\t")]
        if len(cols) < 15 or cols[1] != "GOV" or cols[2].rstrip(".") not in SECTIONS:
            continue
        sec = cols[2].rstrip(".")
        text = lob_to_text(zf.read(cols[14]))
        out[sec] = {
            "section": sec,
            "history": cols[13],
            "effective": cols[6][:10],
            "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "text": text,
        }
    missing = [s for s in SECTIONS if s not in out]
    if missing:
        raise SystemExit(f"Sections not found in leginfo export: {missing}")
    return out, src.modified


def main():
    update = "--update" in sys.argv
    current, modified = fetch()
    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    if update:
        os.makedirs(OUT_DIR, exist_ok=True)
        for sec, d in current.items():
            with open(os.path.join(OUT_DIR, f"{sec}.txt"), "w") as f:
                f.write(f"Government Code § {sec}\n{d['history']}\n\n{d['text']}\n")
        manifest = {
            "source": "Legislative Counsel of California — leginfo database export",
            "archive": ARCHIVE,
            "archiveLastModified": modified,
            "retrieved": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "web": "https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=GOV&division=1.&title=7.&part=&chapter=4.1.5.&article=",
            "sections": {s: {k: v for k, v in d.items() if k != "text"} for s, d in current.items()},
        }
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        print(f"Wrote {len(current)} sections to data/statute/ (archive last modified {modified})")
        return 0
    with open(manifest_path) as f:
        known = json.load(f)["sections"]
    changed = [s for s in SECTIONS if known.get(s, {}).get("sha256") != current[s]["sha256"]]
    report = [f"## Statute check — Gov. Code §§ 65912.155–65912.162 (leginfo export, {modified})", ""]
    if changed:
        report.append("**Amended since the site's standards were built:**")
        report += [f"- § {s}: {current[s]['history']}" for s in changed]
        report += ["", "Review data/standards.json against the new text, then run `python3 scripts/statute.py --update`."]
    else:
        report.append("No change. All sections match data/statute/manifest.json.")
    text = "\n".join(report)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(text + "\n")
    if os.environ.get("STATUTE_REPORT_FILE"):
        with open(os.environ["STATUTE_REPORT_FILE"], "w") as f:
            f.write(text)
    return 3 if changed else 0


if __name__ == "__main__":
    sys.exit(main())
