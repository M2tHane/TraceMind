"""Download the four example papers from arXiv into examples/pdfs/ and verify their SHA-256.

The PDFs are not redistributed with this repository (copyright stays with the authors).
    python3 scripts/fetch_papers.py
"""
import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "examples"


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    for document in manifest["documents"]:
        target = ROOT / document["pdf_path"]
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == document["sha256"]:
            print(f"ok      {target.name}")
            continue
        request = urllib.request.Request(document["versioned_url"], headers={"User-Agent": "TraceMind example fetcher"})
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != document["sha256"]:
            raise SystemExit(f"{target.name}: checksum mismatch for {document['versioned_url']}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(f"fetched {target.name} ({len(data) // 1024} KB)")


if __name__ == "__main__":
    main()
