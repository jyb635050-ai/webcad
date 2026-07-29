from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import threading
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "test" / "cases"
OUT = ROOT / "out"
SUMMARY_PREFIX = "SELFTEST "
PYTHON_PREFIX = "SELFTEST_CASE "


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


def parse_counts(line: str, prefix: str) -> tuple[int, int, int]:
    if not line.startswith(prefix):
        raise ValueError(f"缺少协议前缀：{prefix}")
    fields = {}
    for chunk in line[len(prefix) :].strip().split():
        key, value = chunk.split("=", 1)
        fields[key.lower()] = int(value)
    return fields["pass"], fields["fail"], fields["skip"]


def save_artifact(name: str, payload_base64: str) -> None:
    safe_name = Path(name).name
    if not safe_name or safe_name != name:
        raise ValueError(f"非法产物名：{name}")
    OUT.mkdir(exist_ok=True)
    (OUT / safe_name).write_bytes(base64.b64decode(payload_base64, validate=True))


def browser_cases(target_url: str | None) -> tuple[int, int, int]:
    case_names = sorted(path.name for path in CASES.glob("*.case.js"))
    if not case_names:
        return 0, 1, 0

    server: ThreadingHTTPServer | None = None
    server_thread: threading.Thread | None = None
    if target_url:
        base = target_url.rstrip("/")
        page_url = (
            base
            if base.endswith("/test/selftest.html")
            else f"{base}/test/selftest.html"
        )
    else:
        handler = partial(QuietHandler, directory=str(ROOT))
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        page_url = f"http://127.0.0.1:{server.server_port}/test/selftest.html"

    query = urllib.parse.urlencode({"cases": ",".join(case_names)})
    console_lines: list[str] = []
    page_errors: list[str] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            page = browser.new_page()
            page.expose_function("__selftestEmitArtifact", save_artifact)
            page.on("console", lambda message: console_lines.append(message.text))
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            response = page.goto(
                f"{page_url}?{query}",
                wait_until="domcontentloaded",
                timeout=120_000,
            )
            if response is None or response.status != 200:
                raise RuntimeError(
                    f"selftest 页面 HTTP {response.status if response else 0}"
                )
            page.wait_for_function(
                "document.documentElement.dataset.selftestDone === 'true'",
                timeout=120_000,
            )
            browser.close()
    except Exception as error:
        print(f"BROWSER ERROR {error}")
        for page_error in page_errors:
            print(f"PAGE ERROR {page_error}")
        return 0, 1, 0
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
        if server_thread is not None:
            server_thread.join(timeout=5)

    summaries = [line for line in console_lines if line.startswith(SUMMARY_PREFIX)]
    for line in console_lines:
        if line.startswith(("CASE ", "ASSERT ", "SELFTEST ")):
            print(line)
    if len(summaries) != 1:
        print(f"BROWSER ERROR SELFTEST summary count={len(summaries)}")
        return 0, 1, 0
    try:
        return parse_counts(summaries[0], SUMMARY_PREFIX)
    except (KeyError, TypeError, ValueError) as error:
        print(f"BROWSER ERROR invalid summary: {error}")
        return 0, 1, 0


def python_cases() -> tuple[int, int, int]:
    totals = [0, 0, 0]
    for case_path in sorted(CASES.glob("*.case.py")):
        completed = subprocess.run(
            [sys.executable, str(case_path), str(ROOT)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        output_lines = completed.stdout.splitlines()
        for line in output_lines:
            print(line)
        if completed.stderr.strip():
            print(completed.stderr.strip())
        summaries = [line for line in output_lines if line.startswith(PYTHON_PREFIX)]
        if completed.returncode != 0 or len(summaries) != 1:
            print(
                f"PYTHON CASE ERROR file={case_path.name} "
                f"exit={completed.returncode} summaries={len(summaries)}"
            )
            totals[1] += 1
            continue
        try:
            counts = parse_counts(summaries[0], PYTHON_PREFIX)
        except (KeyError, TypeError, ValueError) as error:
            print(f"PYTHON CASE ERROR file={case_path.name} summary={error}")
            totals[1] += 1
            continue
        for index, count in enumerate(counts):
            totals[index] += count
    return tuple(totals)


def main() -> int:
    parser = argparse.ArgumentParser(description="构形 WebCAD 自检")
    parser.add_argument(
        "--url",
        help="线上站点根地址，或完整的 test/selftest.html 地址",
    )
    args = parser.parse_args()

    browser = browser_cases(args.url)
    python = python_cases()
    passed = browser[0] + python[0]
    failed = browser[1] + python[1]
    skipped = browser[2] + python[2]
    print(f"PASS={passed} FAIL={failed} SKIP={skipped}")
    return 0 if failed == 0 and skipped == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
