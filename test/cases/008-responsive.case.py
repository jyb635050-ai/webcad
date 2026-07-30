from __future__ import annotations

import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(sys.argv[1]).resolve()
    handler = partial(QuietHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    passed = 0
    failed = 0

    def check(label: str, actual: int, expected: int) -> None:
        nonlocal passed, failed
        if actual == expected:
            passed += 1
            state = "PASS"
        else:
            failed += 1
            state = "FAIL"
        print(f"ASSERT {state} {label} actual={actual} expected={expected}")

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            page = browser.new_page(viewport={"width": 1536, "height": 1024})
            url = f"http://127.0.0.1:{server.server_port}/index.html"
            page.goto(url, wait_until="domcontentloaded", timeout=120_000)
            page.wait_for_function(
                "document.documentElement.dataset.appReady === 'true'",
                timeout=30_000,
            )
            desktop_overflow = page.evaluate(
                "document.documentElement.scrollWidth - window.innerWidth"
            )
            desktop_example_buttons = page.locator(
                '[data-action="example"]:visible'
            ).count()
            check("1536px桌面横向溢出", desktop_overflow, 0)
            check("桌面示例入口可见数", desktop_example_buttons, 0)

            page.set_viewport_size({"width": 390, "height": 844})
            page.reload(wait_until="domcontentloaded", timeout=120_000)
            page.wait_for_function(
                "document.documentElement.dataset.appReady === 'true'",
                timeout=30_000,
            )
            mobile_overflow = page.evaluate(
                "document.documentElement.scrollWidth - window.innerWidth"
            )
            mobile_example_buttons = page.locator(
                '[data-action="example"]:visible'
            ).count()
            check("390px手机横向溢出", mobile_overflow, 0)
            check("手机示例入口可见数", mobile_example_buttons, 0)
            browser.close()
    except Exception as error:
        failed += 1
        print(
            f"ASSERT FAIL 响应式检查异常 actual={type(error).__name__} expected=none"
        )
        print(str(error).replace("\ufffd", "?"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    print(f"SELFTEST_CASE pass={passed} fail={failed} skip=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
