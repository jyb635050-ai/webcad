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

            empty_state = page.evaluate("window.__webcadQA.getState()")
            example_count = page.locator('[data-action="example"]').count()
            check(
                "空白启动三角形数",
                int(empty_state["triangleCount"]),
                int(empty_state["triangleCount"]) == 0,
                "0",
            )
            check("示例入口数量", example_count, example_count == 0, "0")

            datum_point = page.evaluate(
                "window.__webcadQA.getDatumScreenPoint('XY')"
            )
            page.mouse.click(datum_point["x"], datum_point["y"])
            page.wait_for_function(
                "window.__webcadQA.getState().selection?.kind === 'datum-plane'",
                timeout=30_000,
            )
            selected = page.evaluate("window.__webcadQA.getState()")
            check(
                "三维点击选中基准面",
                selected["selection"]["kind"],
                selected["selection"]["kind"] == "datum-plane",
                "datum-plane",
            )

            page.locator('[data-action="start-sketch"]').first.click()
            page.wait_for_function(
                "document.documentElement.dataset.workflowStage === 'sketch'",
                timeout=30_000,
            )
            overlay = page.locator("#sketch-overlay")
            bounds = overlay.bounding_box()
            if bounds is None:
                raise RuntimeError("草图画布没有可点击区域")
            start_x = bounds["x"] + 160
            start_y = bounds["y"] + 160
            end_x = start_x + 360
            end_y = start_y + 140
            page.mouse.move(start_x, start_y)
            page.mouse.down()
            page.mouse.move(end_x, end_y, steps=12)
            page.mouse.up()

            page.locator('[data-action="finish-sketch"]').first.click()
            page.wait_for_function(
                "document.documentElement.dataset.workflowStage === 'sketch-ready'",
                timeout=30_000,
            )
            page.locator('[data-feature="extrude"]').first.click()
            page.wait_for_function(
                "document.documentElement.dataset.workflowStage === 'extrude-preview'",
                timeout=30_000,
            )
            preview_count = page.locator("#extrude-gizmo-label:visible").count()
            check("拉伸预览数", preview_count, preview_count == 1, "1")

            gizmo_point = page.evaluate(
                "window.__webcadQA.getGizmoScreenPoint()"
            )
            page.mouse.move(gizmo_point["x"], gizmo_point["y"])
            page.mouse.down()
            page.mouse.move(
                gizmo_point["x"], gizmo_point["y"] - 48, steps=12
            )
            page.mouse.up()
            page.wait_for_function(
                "window.__webcadQA.getState().pendingExtrude > 20",
                timeout=30_000,
            )
            dragged_distance = float(
                page.evaluate(
                    "window.__webcadQA.getState().pendingExtrude"
                )
            )
            check(
                "箭头拖动后拉伸值",
                dragged_distance,
                dragged_distance > 20,
                ">20",
            )

            distance_input = page.locator("#extrude-distance")
            distance_input.fill("32")
            distance_input.dispatch_event("input")
            exact_distance = float(
                page.evaluate(
                    "window.__webcadQA.getState().pendingExtrude"
                )
            )
            check(
                "输入精确拉伸值",
                exact_distance,
                math.isclose(exact_distance, 32, abs_tol=1e-9),
                "32",
            )

            page.locator('[data-action="confirm-extrude"]').click()
            page.wait_for_function(
                "Number(document.documentElement.dataset.triangleCount) > 0",
                timeout=120_000,
            )
            model_state = page.evaluate("window.__webcadQA.getState()")
            triangle_count = int(model_state["triangleCount"])
            volume = float(model_state["volume"])
            check(
                "90×35×32拉伸体三角形数",
                triangle_count,
                triangle_count == 12,
                "12",
            )
            check(
                "90×35×32拉伸体体积",
                volume,
                math.isclose(volume, 100800, abs_tol=0.01),
                "100800±0.01",
            )

            top_face = page.evaluate(
                "window.__webcadQA.getTopFaceScreenPoint()"
            )
            page.mouse.click(top_face["x"], top_face["y"])
            page.wait_for_function(
                "window.__webcadQA.getState().selection?.kind === 'face'",
                timeout=30_000,
            )
            face_state = page.evaluate("window.__webcadQA.getState()")
            check(
                "三维点击选中实体面",
                face_state["selection"]["kind"],
                face_state["selection"]["kind"] == "face",
                "face",
            )
            check(
                "选中实体顶面",
                face_state["selection"]["label"],
                face_state["selection"]["label"] == "实体顶面",
                "实体顶面",
            )
            samples = page.evaluate("window.__webcadQA.sampleCanvas(20, 10)")
            check(
                "新流程Canvas采样颜色数",
                int(samples["unique"]),
                int(samples["unique"]) > 1,
                ">1",
            )
            browser.close()
    except Exception as error:
        failed += 1
        print(
            f"ASSERT FAIL SolidWorks式流程异常 "
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
