from __future__ import annotations

import math
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

    def check(label: str, actual: object, condition: bool, expected: str) -> None:
        nonlocal passed, failed
        state = "PASS" if condition else "FAIL"
        passed += int(condition)
        failed += int(not condition)
        print(f"ASSERT {state} {label} actual={actual} expected={expected}")

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            page = browser.new_page(viewport={"width": 1536, "height": 1024})
            page.goto(
                f"http://127.0.0.1:{server.server_port}/index.html",
                wait_until="domcontentloaded",
                timeout=120_000,
            )
            page.wait_for_function(
                "document.documentElement.dataset.appReady === 'true'",
                timeout=30_000,
            )
            datum = page.evaluate(
                "window.__webcadQA.getDatumScreenPoint('XY')"
            )
            page.mouse.click(datum["x"], datum["y"])
            page.locator('[data-action="start-sketch"]').first.click()
            overlay = page.locator("#sketch-overlay").bounding_box()
            if overlay is None:
                raise RuntimeError("草图画布没有可点击区域")
            start_x = overlay["x"] + 160
            start_y = overlay["y"] + 160
            page.mouse.move(start_x, start_y)
            page.mouse.down()
            page.mouse.move(start_x + 360, start_y + 140, steps=12)
            page.mouse.up()
            page.locator('[data-action="finish-sketch"]').first.click()
            page.locator('[data-feature="extrude"]').first.click()
            page.wait_for_function(
                "document.documentElement.dataset.workflowStage === 'extrude-preview'"
            )

            diagnostics = page.evaluate(
                "window.__webcadQA.getGizmoDiagnostics()"
            )
            check(
                "箭头测试点射线交点数",
                int(diagnostics["hitCount"]),
                int(diagnostics["hitCount"]) > 0,
                ">0",
            )
            check(
                "箭头测试点顶层DOM",
                diagnostics["topElement"],
                diagnostics["topElement"] == "cad-canvas",
                "cad-canvas",
            )
            first_distance = float(diagnostics["firstDistance"])
            check(
                "箭头射线首交距离",
                first_distance,
                math.isfinite(first_distance) and first_distance > 0,
                "有限正数",
            )
            before = float(diagnostics["previewDistance"])
            check(
                "箭头拖动前长度",
                before,
                math.isclose(before, 20, abs_tol=1e-9),
                "20",
            )

            point = diagnostics["point"]
            page.mouse.move(point["x"], point["y"])
            page.mouse.down()
            page.mouse.move(point["x"], point["y"] - 48, steps=12)
            page.mouse.up()
            after = float(
                page.evaluate("window.__webcadQA.getState().pendingExtrude")
            )
            check(
                "箭头真实拖动后长度",
                after,
                after > 20,
                ">20",
            )
            check(
                "箭头48px拖动换算值",
                after,
                math.isclose(after, 32, abs_tol=0.1),
                "32±0.1",
            )
            browser.close()
    except Exception as error:
        failed += 1
        print(
            f"ASSERT FAIL 箭头拾取稳定性异常 "
            f"actual={type(error).__name__} expected=none"
        )
        print(str(error).replace("�", "?"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    print(f"SELFTEST_CASE pass={passed} fail={failed} skip=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())