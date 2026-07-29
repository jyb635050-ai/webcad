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

    def check(label: str, actual: int, predicate: bool, expected: str) -> None:
        nonlocal passed, failed
        if predicate:
            passed += 1
            state = "PASS"
        else:
            failed += 1
            state = "FAIL"
        print(f"ASSERT {state} {label} actual={actual} expected={expected}")

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            page = browser.new_page(viewport={"width": 1536, "height": 900})
            page.goto(
                f"http://127.0.0.1:{server.server_port}/index.html",
                wait_until="domcontentloaded",
                timeout=120_000,
            )
            page.wait_for_function(
                "document.documentElement.dataset.appReady === 'true'",
                timeout=30_000,
            )
            page.locator('[data-tool="rectangle"]').first.click()
            overlay = page.locator("#sketch-overlay")
            bounds = overlay.bounding_box()
            if bounds is None:
                raise RuntimeError("草图画布没有可点击区域")

            start_x = bounds["x"] + 120
            start_y = bounds["y"] + 110
            end_x = bounds["x"] + 480
            end_y = bounds["y"] + 250
            page.mouse.move(start_x, start_y)
            page.mouse.down()
            page.mouse.move(end_x, end_y, steps=12)
            page.mouse.up()
            page.locator('[data-feature="extrude"]').first.click()
            page.wait_for_function(
                "Number(document.documentElement.dataset.triangleCount) > 0",
                timeout=120_000,
            )

            triangle_count = int(
                page.locator("html").get_attribute("data-triangle-count") or "0"
            )
            samples = page.evaluate("window.__webcadQA.sampleCanvas(20, 10)")
            check("按坐标绘制并拉伸三角形数", triangle_count, triangle_count > 0, ">0")
            check(
                "Canvas采样像素数",
                int(samples["sampled"]),
                int(samples["sampled"]) >= 200,
                ">=200",
            )
            check(
                "Canvas采样颜色种数",
                int(samples["unique"]),
                int(samples["unique"]) > 1,
                ">1",
            )
            browser.close()
    except Exception as error:
        failed += 1
        print(f"ASSERT FAIL UI流程异常 actual={type(error).__name__} expected=none")
        print(str(error))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    print(f"SELFTEST_CASE pass={passed} fail={failed} skip=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
