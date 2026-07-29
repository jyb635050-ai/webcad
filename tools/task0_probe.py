from __future__ import annotations

import subprocess
import sys
import time

from playwright.sync_api import sync_playwright


ROOT = r"D:\blender\webcad"
URL = "http://127.0.0.1:8765/minimal.html"


def main() -> int:
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "http.server",
            "8765",
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
            page = browser.new_page()
            messages: list[str] = []
            page.on(
                "console",
                lambda message: messages.append(f"{message.type}: {message.text}"),
            )
            response = page.goto(URL, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_function(
                "document.documentElement.dataset.result === 'pass' || "
                "document.documentElement.dataset.result === 'fail'",
                timeout=60_000,
            )
            print(f"HTTP {response.status if response else 0}")
            result = page.locator("#status").inner_text()
            print(f"RESULT {result}")
            print(page.locator("#details").inner_text())
            for message in messages:
                print(message)
            browser.close()
            return 0 if result == "PASS" else 1
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
