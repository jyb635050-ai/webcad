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


def draw_line(
    page: Page,
    start: tuple[float, float],
    end: tuple[float, float],
) -> None:
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(*end, steps=10)
    page.mouse.up()


def draw_triangle(
    page: Page,
    points: list[tuple[float, float]],
    close: bool = True,
) -> None:
    draw_line(page, points[0], points[1])
    draw_line(page, points[1], points[2])
    if close:
        draw_line(page, points[2], points[0])


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
            page.locator('[data-tool="line"]').click()
            center_x, center_y = overlay_center(page)
            base_points = [
                (center_x - 120, center_y - 80),
                (center_x + 120, center_y - 80),
                (center_x, center_y + 80),
            ]
            draw_triangle(page, base_points, close=False)

            open_analysis = page.evaluate(
                "window.__webcadQA.getLineProfileAnalysis()"
            )
            check(
                "两条线不误判闭合轮廓",
                len(open_analysis["profiles"]),
                len(open_analysis["profiles"]) == 0,
                "0",
            )
            check(
                "两条线检测开放端点数",
                int(open_analysis["openEndpointCount"]),
                int(open_analysis["openEndpointCount"]) == 2,
                "2",
            )
            page.locator('[data-action="finish-sketch"]').first.click()
            open_stage = page.evaluate(
                "document.documentElement.dataset.workflowStage"
            )
            check(
                "未闭合线段禁止完成草图",
                open_stage,
                open_stage == "sketch",
                "sketch",
            )
            check(
                "未闭合提示给出端点数",
                page.locator("#toast-message").inner_text(),
                "2 个开放端点" in page.locator("#toast-message").inner_text(),
                "包含 2 个开放端点",
            )

            draw_line(page, base_points[2], base_points[0])
            closed_analysis = page.evaluate(
                "window.__webcadQA.getLineProfileAnalysis()"
            )
            profile = closed_analysis["profiles"][0]
            check(
                "三线闭环识别数量",
                len(closed_analysis["profiles"]),
                len(closed_analysis["profiles"]) == 1,
                "1",
            )
            check(
                "三角形闭环顶点数",
                len(profile["points"]),
                len(profile["points"]) == 3,
                "3",
            )
            check(
                "吸附闭合间隙",
                float(profile["closureGap"]),
                math.isclose(float(profile["closureGap"]), 0, abs_tol=1e-9),
                "0px",
            )

            page.locator('[data-action="finish-sketch"]').first.click()
            page.wait_for_function(
                "document.documentElement.dataset.workflowStage === 'sketch-ready'"
            )
            extrude_button = page.locator('[data-feature="extrude"]').first
            check(
                "线段闭环后拉伸按钮可用",
                extrude_button.is_enabled(),
                extrude_button.is_enabled(),
                "true",
            )
            extrude_button.click()
            page.wait_for_function(
                "document.documentElement.dataset.workflowStage === 'extrude-preview'"
            )
            page.locator("#extrude-distance").fill("20")
            page.locator("#extrude-distance").dispatch_event("input")
            page.locator('[data-action="confirm-extrude"]').click()
            page.wait_for_function(
                "window.__webcadQA.getState().featureCount === 1",
                timeout=120_000,
            )
            base = page.evaluate("window.__webcadQA.getState()")
            check(
                "60×40三角形拉伸20体积",
                float(base["volume"]),
                math.isclose(float(base["volume"]), 24000, abs_tol=0.02),
                "24000±0.02",
            )
            check(
                "三角柱网格水密",
                int(base["nakedEdgeCount"]),
                int(base["nakedEdgeCount"]) == 0,
                "0",
            )
            check(
                "三角柱三角形数",
                int(base["triangleCount"]),
                int(base["triangleCount"]) == 8,
                "8",
            )

            click_top_face(page)
            page.locator('[data-action="start-sketch"]').first.click()
            page.locator('[data-tool="line"]').click()
            center_x, center_y = overlay_center(page)
            cut_points = [
                (center_x - 40, center_y - 30),
                (center_x + 40, center_y - 30),
                (center_x, center_y + 30),
            ]
            draw_triangle(page, cut_points)
            page.locator('[data-action="finish-sketch"]').first.click()
            cut_button = page.locator('[data-feature="cut"]')
            check(
                "面上线段闭环后切除按钮可用",
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
                "三角形深10切除后体积",
                float(final_state["volume"]),
                math.isclose(float(final_state["volume"]), 22500, abs_tol=0.03),
                "22500±0.03",
            )
            check(
                "三角形切除写入特征树",
                final_state["featureTypes"],
                final_state["featureTypes"] == ["extrude", "cut"],
                "['extrude','cut']",
            )
            check(
                "三角形切除后网格水密",
                int(final_state["nakedEdgeCount"]),
                int(final_state["nakedEdgeCount"]) == 0,
                "0",
            )
            browser.close()
    except Exception as error:
        failed += 1
        print(
            f"ASSERT FAIL 线段闭环多边形流程异常 "
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