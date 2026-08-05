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


def overlay_center(page: Page) -> tuple[float, float]:
    bounds = page.locator("#sketch-overlay").bounding_box()
    if bounds is None:
        raise RuntimeError("草图画布没有可点击区域")
    return (
        bounds["x"] + bounds["width"] / 2,
        bounds["y"] + bounds["height"] / 2,
    )


def draw_rectangle(page: Page, width_px: int, height_px: int) -> None:
    center_x, center_y = overlay_center(page)
    page.mouse.move(center_x - width_px / 2, center_y - height_px / 2)
    page.mouse.down()
    page.mouse.move(
        center_x + width_px / 2,
        center_y + height_px / 2,
        steps=12,
    )
    page.mouse.up()


def draw_line(
    page: Page,
    start: tuple[float, float],
    end: tuple[float, float],
) -> None:
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(*end, steps=10)
    page.mouse.up()


def set_dimension(page: Page, locator: str, value: str) -> float:
    page.locator(locator).first.dblclick(force=True)
    page.locator("#dimension-dialog").wait_for(state="visible", timeout=30_000)
    initial = float(page.locator("#dimension-value").input_value())
    page.locator("#dimension-value").fill(value)
    page.locator('#dimension-dialog button[value="confirm"]').click()
    page.locator("#dimension-dialog").wait_for(state="hidden", timeout=30_000)
    return initial


def select_xy_datum(page: Page) -> None:
    point = page.evaluate("window.__webcadQA.getDatumScreenPoint('XY')")
    page.mouse.click(point["x"], point["y"])
    page.wait_for_function(
        "window.__webcadQA.getState().selection?.kind === 'datum-plane'",
        timeout=30_000,
    )


def click_top_face(page: Page) -> None:
    point = page.evaluate("window.__webcadQA.getTopFaceScreenPoint()")
    page.mouse.click(point["x"], point["y"])
    page.wait_for_function(
        "window.__webcadQA.getState().selection?.label === '实体顶面'",
        timeout=30_000,
    )


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

            select_xy_datum(page)
            page.locator('[data-action="start-sketch"]').first.click()
            draw_rectangle(page, 320, 160)
            initial_width = set_dimension(
                page,
                '.sketch-dimension[data-dimension="width"]',
                "100",
            )
            initial_height = set_dimension(
                page,
                '.sketch-dimension[data-dimension="height"]',
                "60",
            )
            check(
                "双击宽度文字读取原尺寸",
                initial_width,
                math.isclose(initial_width, 80, abs_tol=0.01),
                "80±0.01mm",
            )
            check(
                "双击高度文字读取原尺寸",
                initial_height,
                math.isclose(initial_height, 40, abs_tol=0.01),
                "40±0.01mm",
            )
            attachment = page.evaluate(
                "window.__webcadQA.getSketchAttachment()"
            )
            profile = attachment["profile"]
            check(
                "双击修改后矩形宽度",
                float(profile["width"]),
                math.isclose(float(profile["width"]), 100, abs_tol=0.01),
                "100±0.01mm",
            )
            check(
                "双击修改后矩形高度",
                float(profile["height"]),
                math.isclose(float(profile["height"]), 60, abs_tol=0.01),
                "60±0.01mm",
            )
            check(
                "尺寸修改后草图投影仍贴面",
                float(attachment["maxScreenError"]),
                float(attachment["maxScreenError"]) <= 1.0,
                "<=1px",
            )
            check(
                "基准面草图视觉法向偏移",
                float(attachment["visualPlaneOffset"]),
                math.isclose(
                    float(attachment["visualPlaneOffset"]),
                    0,
                    abs_tol=1e-9,
                ),
                "0mm",
            )
            check(
                "草图模式只显示当前平面层",
                int(attachment["auxiliaryPlaneLayerCount"]),
                int(attachment["auxiliaryPlaneLayerCount"]) == 1,
                "1",
            )

            page.locator('[data-action="finish-sketch"]').first.click()
            page.locator('[data-feature="extrude"]').first.click()
            page.locator("#extrude-distance").fill("20")
            page.locator("#extrude-distance").dispatch_event("input")
            page.locator('[data-action="confirm-extrude"]').click()
            page.wait_for_function(
                "window.__webcadQA.getState().featureCount === 1",
                timeout=120_000,
            )
            base = page.evaluate("window.__webcadQA.getState()")
            check(
                "100×60×20尺寸驱动体积",
                float(base["volume"]),
                math.isclose(float(base["volume"]), 120000, abs_tol=0.02),
                "120000±0.02",
            )

            click_top_face(page)
            page.locator('[data-action="start-sketch"]').first.click()
            page.locator('[data-tool="line"]').click()
            center_x, center_y = overlay_center(page)
            points = [
                (center_x - 40, center_y - 30),
                (center_x + 40, center_y - 30),
                (center_x, center_y + 30),
            ]
            draw_line(page, points[0], points[1])
            draw_line(page, points[1], points[2])
            draw_line(page, points[2], points[0])
            line_initial = set_dimension(
                page,
                'line.sketch-entity[data-entity-id]',
                "30",
            )
            check(
                "双击线段读取原长度",
                line_initial,
                math.isclose(line_initial, 20, abs_tol=0.01),
                "20±0.01mm",
            )
            line_analysis = page.evaluate(
                "window.__webcadQA.getLineProfileAnalysis()"
            )
            check(
                "修改线长后闭环保持数量",
                len(line_analysis["profiles"]),
                len(line_analysis["profiles"]) == 1,
                "1",
            )
            check(
                "修改线长后开放端点数",
                int(line_analysis["openEndpointCount"]),
                int(line_analysis["openEndpointCount"]) == 0,
                "0",
            )
            face_attachment = page.evaluate(
                "window.__webcadQA.getSketchAttachment()"
            )
            check(
                "实体面线轮廓视觉法向偏移",
                float(face_attachment["visualPlaneOffset"]),
                math.isclose(
                    float(face_attachment["visualPlaneOffset"]),
                    0,
                    abs_tol=1e-9,
                ),
                "0mm",
            )
            check(
                "实体面线轮廓投影误差",
                float(face_attachment["maxScreenError"]),
                float(face_attachment["maxScreenError"]) <= 1.0,
                "<=1px",
            )

            page.locator('[data-action="finish-sketch"]').first.click()
            cut_button = page.locator('[data-feature="cut"]')
            check(
                "改尺寸后的线闭环可切除",
                cut_button.is_enabled(),
                cut_button.is_enabled(),
                "true",
            )
            cut_button.click()
            page.wait_for_function(
                "document.documentElement.dataset.workflowStage === 'cut-preview'"
            )
            page.locator("#cut-distance").fill("10")
            page.locator("#cut-distance").dispatch_event("input")
            page.locator('[data-action="confirm-cut"]').click()
            page.wait_for_function(
                "window.__webcadQA.getState().featureCount === 2",
                timeout=120_000,
            )
            final_state = page.evaluate("window.__webcadQA.getState()")
            check(
                "30×15三角形深10切除体积",
                float(final_state["volume"]),
                math.isclose(float(final_state["volume"]), 117750, abs_tol=0.04),
                "117750±0.04",
            )
            check(
                "线轮廓切除特征序列",
                final_state["featureTypes"],
                final_state["featureTypes"] == ["extrude", "cut"],
                "['extrude','cut']",
            )
            check(
                "线轮廓切除后水密",
                int(final_state["nakedEdgeCount"]),
                int(final_state["nakedEdgeCount"]) == 0,
                "0",
            )
            browser.close()
    except Exception as error:
        failed += 1
        print(
            f"ASSERT FAIL 尺寸共面线切除综合流程异常 "
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