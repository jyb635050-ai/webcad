from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots"
URL = "http://127.0.0.1:8876/index.html"


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "http.server",
            "8876",
            "--bind",
            "127.0.0.1",
        ],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(0.8)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            context = browser.new_context(
                viewport={"width": 1536, "height": 1024},
                accept_downloads=True,
            )
            page = context.new_page()
            page.goto(URL, wait_until="domcontentloaded", timeout=120_000)
            page.wait_for_function(
                "document.documentElement.dataset.appReady === 'true'",
                timeout=30_000,
            )
            page.screenshot(path=OUTPUT / "01-empty-start.png")

            page.locator('[data-action="example"]').first.click()
            page.wait_for_function(
                "Number(document.documentElement.dataset.triangleCount) > 100",
                timeout=120_000,
            )
            page.screenshot(path=OUTPUT / "02-plate-extruded.png")

            with page.expect_download(timeout=180_000):
                page.locator('[data-export="3mf"]').first.click()
            page.locator("#toast-title").filter(has_text="导出成功").wait_for(
                state="visible",
                timeout=30_000,
            )
            page.screenshot(path=OUTPUT / "03-export-success.png")
            print(f"SCREENSHOT {OUTPUT / '01-empty-start.png'}")
            print(f"SCREENSHOT {OUTPUT / '02-plate-extruded.png'}")
            print(f"SCREENSHOT {OUTPUT / '03-export-success.png'}")
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
