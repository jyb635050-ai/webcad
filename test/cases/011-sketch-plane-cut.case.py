from __future__ import annotations

import math
import sys
import threading
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from xml.etree import ElementTree

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


def draw_circle(page: Page, radius_px: int, offset_x_px: int = 0) -> None:
    page.locator('[data-tool="circle"]').click()
    center_x, center_y = overlay_center(page)
    center_x += offset_x_px
    page.mouse.move(center_x, center_y)
    page.mouse.down()
    page.mouse.move(center_x + radius_px, center_y, steps=10)
    page.mouse.up()


def click_top_face(page: Page, u: float = 0.5) -> None:
    point = page.evaluate(
        "u => window.__webcadQA.getTopFaceScreenPoint(u, 0.5)", u
    )
    page.mouse.click(point["x"], point["y"])
    page.wait_for_function(
        "window.__webcadQA.getState().selection?.label === '实体顶面'",
        timeout=30_000,
    )


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(sys.argv[1]).resolve()
    out = root / "out"
    out.mkdir(exist_ok=True)
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
            page.wait_for_function(
                "document.documentElement.dataset.workflowStage === 'sketch'"
            )
            before_draw = page.evaluate(
                "window.__webcadQA.getSketchAttachment()"
            )
            check(
                "草图平面层已启用",
                before_draw["planeVisible"],
                bool(before_draw["planeVisible"]),
                "true",
            )
            check(
                "所选XY基准面保持可见",
                before_draw["datumVisible"],
                bool(before_draw["datumVisible"]),
                "true",
            )
            camera_dot = float(before_draw["cameraNormalDot"])
            check(
                "草图相机严格垂直基准面",
                camera_dot,
                camera_dot > 0.999999,
                ">0.999999",
            )

            draw_rectangle(page, 320, 160)
            attached = page.evaluate(
                "window.__webcadQA.getSketchAttachment()"
            )
            screen_error = float(attached["maxScreenError"])
            profile = attached["profile"]
            check(
                "二维草图与三维基准面投影误差",
                screen_error,
                screen_error <= 1.0,
                "<=1px",
            )
            check(
                "贴面矩形宽度",
                float(profile["width"]),
                math.isclose(float(profile["width"]), 80, abs_tol=0.01),
                "80±0.01mm",
            )
            check(
                "贴面矩形高度",
                float(profile["height"]),
                math.isclose(float(profile["height"]), 40, abs_tol=0.01),
                "40±0.01mm",
            )
            check(
                "草图位于XY基准面",
                float(profile["offset"]),
                math.isclose(float(profile["offset"]), 0, abs_tol=1e-9),
                "0mm",
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
                "80×40×20基础体体积",
                float(base["volume"]),
                math.isclose(float(base["volume"]), 64000, abs_tol=0.01),
                "64000±0.01",
            )

            click_top_face(page)
            page.locator('[data-action="start-sketch"]').first.click()
            draw_circle(page, 40)
            page.locator('[data-action="finish-sketch"]').first.click()
            cut_button = page.locator('[data-feature="cut"]')
            check(
                "完成圆草图后切除可用",
                cut_button.is_enabled(),
                cut_button.is_enabled(),
                "true",
            )
            cut_button.click()
            page.wait_for_function(
                "document.documentElement.dataset.workflowStage === 'cut-preview'"
            )
            check(
                "切除属性面板可见",
                page.locator("#cut-inspector:visible").count(),
                page.locator("#cut-inspector:visible").count() == 1,
                "1",
            )
            check(
                "红色切除预览存在",
                page.evaluate(
                    "window.__webcadQA.getState().workflowStage"
                ),
                page.evaluate(
                    "window.__webcadQA.getState().workflowStage"
                ) == "cut-preview",
                "cut-preview",
            )
            page.locator("#cut-distance").fill("10")
            page.locator("#cut-distance").dispatch_event("input")
            page.locator('[data-action="confirm-cut"]').click()
            page.wait_for_function(
                "window.__webcadQA.getState().featureCount === 2",
                timeout=120_000,
            )
            blind_cut = page.evaluate("window.__webcadQA.getState()")
            blind_expected = 64000 - math.pi * 10**2 * 10
            check(
                "φ20深10盲孔体积",
                float(blind_cut["volume"]),
                math.isclose(
                    float(blind_cut["volume"]), blind_expected, abs_tol=0.02
                ),
                f"{blind_expected}±0.02",
            )
            check(
                "盲孔特征写入特征树",
                blind_cut["featureTypes"],
                blind_cut["featureTypes"] == ["extrude", "cut"],
                "['extrude','cut']",
            )

            click_top_face(page, 0.15)
            page.locator('[data-action="start-sketch"]').first.click()
            draw_circle(page, 20, offset_x_px=100)
            page.locator('[data-action="finish-sketch"]').first.click()
            page.locator('[data-feature="cut"]').click()
            through_all = page.locator("#cut-through-all")
            through_all.check()
            state_through = page.evaluate("window.__webcadQA.getState()")
            check(
                "贯穿全部状态生效",
                state_through["cutThroughAll"],
                bool(state_through["cutThroughAll"]),
                "true",
            )
            check(
                "贯穿时深度输入禁用",
                page.locator("#cut-distance").is_disabled(),
                page.locator("#cut-distance").is_disabled(),
                "true",
            )
            page.locator('[data-action="confirm-cut"]').click()
            page.wait_for_function(
                "window.__webcadQA.getState().featureCount === 3",
                timeout=120_000,
            )
            final_state = page.evaluate("window.__webcadQA.getState()")
            final_expected = blind_expected - math.pi * 5**2 * 20
            check(
                "φ10贯穿孔最终体积",
                float(final_state["volume"]),
                math.isclose(
                    float(final_state["volume"]), final_expected, abs_tol=0.03
                ),
                f"{final_expected}±0.03",
            )
            check(
                "两次切除后特征数",
                int(final_state["featureCount"]),
                int(final_state["featureCount"]) == 3,
                "3",
            )
            check(
                "两次切除后网格水密",
                int(final_state["nakedEdgeCount"]),
                int(final_state["nakedEdgeCount"]) == 0,
                "0",
            )

            page.locator('[data-action="open-export"]').click()
            with page.expect_download(timeout=120_000) as download_info:
                page.locator('#export-dialog [data-export="3mf"]').click()
            download = download_info.value
            destination = out / "ui-cut-export.3mf"
            download.save_as(destination)
            file_bytes = destination.stat().st_size
            with zipfile.ZipFile(destination) as archive:
                model_xml = archive.read("3D/3dmodel.model")
            root_xml = ElementTree.fromstring(model_xml)
            vertex_count = sum(
                1 for element in root_xml.iter() if element.tag.endswith("vertex")
            )
            check(
                "切除模型3MF字节数",
                file_bytes,
                file_bytes > 1000,
                ">1000",
            )
            check(
                "切除模型3MF顶点数",
                vertex_count,
                vertex_count > 8,
                ">8",
            )
            browser.close()
    except Exception as error:
        failed += 1
        print(
            f"ASSERT FAIL 草图贴面与切除流程异常 "
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