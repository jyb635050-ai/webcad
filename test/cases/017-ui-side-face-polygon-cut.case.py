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


def draw_drag(
    page: Page,
    start: tuple[float, float],
    end: tuple[float, float],
) -> None:
    page.mouse.move(*start)
    page.mouse.down()
    page.mouse.move(*end, steps=10)
    page.mouse.up()


def check_base_and_cut(page: Page, check, out: Path) -> None:
    datum = page.evaluate("window.__webcadQA.getDatumScreenPoint('XY')")
    page.mouse.click(datum["x"], datum["y"])
    page.wait_for_function(
        "window.__webcadQA.getState().selection?.kind === 'datum-plane'"
    )
    page.locator('[data-action="start-sketch"]').first.click()

    center_x, center_y = overlay_center(page)
    draw_drag(
        page,
        (center_x - 160, center_y - 80),
        (center_x + 160, center_y + 80),
    )
    page.locator('[data-action="finish-sketch"]').first.click()
    page.locator('[data-feature="extrude"]').first.click()
    page.locator("#extrude-distance").fill("60")
    page.locator("#extrude-distance").dispatch_event("input")
    page.locator('[data-action="confirm-extrude"]').click()
    page.wait_for_function(
        "window.__webcadQA.getState().featureCount === 1",
        timeout=120_000,
    )
    base = page.evaluate("window.__webcadQA.getState()")
    check(
        "侧面切除基础体积",
        float(base["volume"]),
        math.isclose(float(base["volume"]), 192000, abs_tol=0.03),
        "192000±0.03",
    )

    front = page.evaluate("window.__webcadQA.getFrontFaceScreenPoint()")
    page.mouse.click(front["x"], front["y"])
    page.wait_for_function(
        "window.__webcadQA.getState().selection?.label === '实体前侧面'",
        timeout=30_000,
    )
    selected = page.evaluate("window.__webcadQA.getState().selection")
    check(
        "真实点击选中XZ前侧面",
        selected["label"],
        selected["plane"] == "XZ" and selected["normal"] == [0, -1, 0],
        "XZ/[0,-1,0]",
    )

    page.locator('[data-action="start-sketch"]').first.click()
    page.locator('[data-tool="line"]').click()
    center_x, center_y = overlay_center(page)
    points = [
        (center_x - 40, center_y - 40),
        (center_x + 40, center_y - 40),
        (center_x, center_y + 40),
    ]
    draw_drag(page, points[0], points[1])
    draw_drag(page, points[1], points[2])
    draw_drag(page, points[2], points[0])
    analysis = page.evaluate("window.__webcadQA.getLineProfileAnalysis()")
    check(
        "侧面三线闭环识别",
        len(analysis["profiles"]),
        len(analysis["profiles"]) == 1
        and int(analysis["openEndpointCount"]) == 0,
        "1个闭环/0个开放端点",
    )

    page.locator('[data-action="finish-sketch"]').first.click()
    cut_button = page.locator('[data-feature="cut"]')
    check(
        "侧面线闭环切除按钮可用",
        cut_button.is_enabled(),
        cut_button.is_enabled(),
        "true",
    )
    cut_button.click()
    page.wait_for_function(
        "document.documentElement.dataset.workflowStage === 'cut-preview'"
    )
    page.locator("#cut-through-all").check()
    check(
        "侧面贯穿全部已启用",
        page.locator("#cut-through-all").is_checked(),
        page.locator("#cut-through-all").is_checked()
        and page.locator("#cut-distance").is_disabled(),
        "checked/depth-disabled",
    )
    page.locator('[data-action="confirm-cut"]').click()
    page.wait_for_function(
        "window.__webcadQA.getState().featureCount === 2",
        timeout=120_000,
    )
    final_state = page.evaluate("window.__webcadQA.getState()")
    check(
        "侧面三角形贯穿切除体积",
        float(final_state["volume"]),
        math.isclose(float(final_state["volume"]), 184000, abs_tol=0.05),
        "184000±0.05",
    )
    check(
        "侧面贯穿切除特征序列",
        final_state["featureTypes"],
        final_state["featureTypes"] == ["extrude", "cut"],
        "['extrude','cut']",
    )
    check(
        "侧面贯穿切除网格水密",
        int(final_state["nakedEdgeCount"]),
        int(final_state["nakedEdgeCount"]) == 0,
        "0",
    )

    out.mkdir(exist_ok=True)
    page.locator('[data-action="open-export"]').click()
    with page.expect_download(timeout=120_000) as download_info:
        page.locator('#export-dialog [data-export="3mf"]').click()
    destination = out / "ui-side-face-polygon-cut.3mf"
    download_info.value.save_as(destination)
    with zipfile.ZipFile(destination) as archive:
        model_xml = archive.read("3D/3dmodel.model")
    model = ElementTree.fromstring(model_xml)
    signed_volume = 0.0
    vertex_count = 0
    triangle_count = 0
    for mesh in (element for element in model.iter() if element.tag.endswith("mesh")):
        vertices_element = next(
            element for element in mesh if element.tag.endswith("vertices")
        )
        triangles_element = next(
            element for element in mesh if element.tag.endswith("triangles")
        )
        vertices = [
            (
                float(vertex.attrib["x"]),
                float(vertex.attrib["y"]),
                float(vertex.attrib["z"]),
            )
            for vertex in vertices_element
            if vertex.tag.endswith("vertex")
        ]
        vertex_count += len(vertices)
        for triangle in triangles_element:
            if not triangle.tag.endswith("triangle"):
                continue
            a, b, c = (
                vertices[int(triangle.attrib[key])]
                for key in ("v1", "v2", "v3")
            )
            signed_volume += (
                a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
            ) / 6
            triangle_count += 1
    exported_volume = abs(signed_volume)
    check(
        "侧面切除3MF独立网格体积",
        exported_volume,
        math.isclose(exported_volume, 184000, abs_tol=0.2),
        "184000±0.2",
    )
    check(
        "侧面切除3MF顶点数",
        vertex_count,
        vertex_count > 8,
        ">8",
    )
    check(
        "侧面切除3MF三角形数",
        triangle_count,
        triangle_count > 12,
        ">12",
    )


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(sys.argv[1]).resolve()
    out = root / "out"
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
            check_base_and_cut(page, check, out)
            browser.close()
    except Exception as error:
        failed += 1
        print(
            "ASSERT FAIL 侧面线轮廓贯穿切除流程异常 "
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
