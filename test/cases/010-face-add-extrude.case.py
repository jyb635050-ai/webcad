from __future__ import annotations

import math
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


def draw_rectangle(
    page: Page, width_pixels: int, height_pixels: int
) -> None:
    overlay = page.locator("#sketch-overlay")
    bounds = overlay.bounding_box()
    if bounds is None:
        raise RuntimeError("草图画布没有可点击区域")
    start_x = bounds["x"] + 190
    start_y = bounds["y"] + 180
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(
        start_x + width_pixels,
        start_y + height_pixels,
        steps=12,
    )
    page.mouse.up()


def finish_and_extrude(page: Page, distance: float) -> None:
    page.locator('[data-action="finish-sketch"]').first.click()
    page.locator('[data-feature="extrude"]').first.click()
    distance_input = page.locator("#extrude-distance")
    distance_input.fill(str(distance))
    distance_input.dispatch_event("input")
    page.locator('[data-action="confirm-extrude"]').click()


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(sys.argv[1]).resolve()
    handler = partial(QuietHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    passed = 0
    failed = 0

    def check(
        label: str, actual: object, condition: bool, expected: str
    ) -> None:
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
            draw_rectangle(page, 320, 160)
            finish_and_extrude(page, 20)
            page.wait_for_function(
                "window.__webcadQA.getState().featureCount === 1",
                timeout=120_000,
            )

            top_face = page.evaluate(
                "window.__webcadQA.getTopFaceScreenPoint()"
            )
            page.mouse.click(top_face["x"], top_face["y"])
            page.wait_for_function(
                "window.__webcadQA.getState().selection?.label === '实体顶面'",
                timeout=30_000,
            )
            page.locator('[data-action="start-sketch"]').first.click()
            draw_rectangle(page, 120, 80)
            finish_and_extrude(page, 10)
            page.wait_for_function(
                "window.__webcadQA.getState().featureCount === 2",
                timeout=120_000,
            )

            state = page.evaluate("window.__webcadQA.getState()")
            volume = float(state["volume"])
            feature_count = int(state["featureCount"])
            total_height = float(state["bounds"]["max"][2])
            naked_edges = int(state["nakedEdgeCount"])
            triangle_count = int(state["triangleCount"])
            check(
                "实体顶面追加拉伸特征数",
                feature_count,
                feature_count == 2,
                "2",
            )
            check(
                "80×40×20加30×20×10体积",
                volume,
                math.isclose(volume, 70000, abs_tol=0.01),
                "70000±0.01",
            )
            check(
                "实体顶面追加拉伸总高度",
                total_height,
                math.isclose(total_height, 30, abs_tol=0.001),
                "30±0.001",
            )
            check(
                "追加拉伸水密开放边数",
                naked_edges,
                naked_edges == 0,
                "0",
            )
            check(
                "追加拉伸网格三角形数",
                triangle_count,
                triangle_count > 12,
                ">12",
            )
            browser.close()
    except Exception as error:
        failed += 1
        print(
            f"ASSERT FAIL 实体面追加拉伸异常 "
            f"actual={type(error).__name__} expected=none"
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
