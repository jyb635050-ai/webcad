from __future__ import annotations

import sys
import threading
import zipfile
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
        if condition:
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
            datum_point = page.evaluate(
                "window.__webcadQA.getDatumScreenPoint('XY')"
            )
            page.mouse.click(datum_point["x"], datum_point["y"])
            page.wait_for_function(
                "window.__webcadQA.getState().selection?.kind === 'datum-plane'",
                timeout=30_000,
            )
            page.locator('[data-action="start-sketch"]').first.click()
            overlay = page.locator("#sketch-overlay")
            bounds = overlay.bounding_box()
            if bounds is None:
                raise RuntimeError("草图画布没有可点击区域")
            page.mouse.move(bounds["x"] + 150, bounds["y"] + 140)
            page.mouse.down()
            page.mouse.move(
                bounds["x"] + 550,
                bounds["y"] + 340,
                steps=12,
            )
            page.mouse.up()
            page.locator('[data-action="finish-sketch"]').first.click()
            page.locator('[data-feature="extrude"]').first.click()
            page.locator('[data-action="confirm-extrude"]').click()
            page.wait_for_function(
                "Number(document.documentElement.dataset.triangleCount) > 0",
                timeout=120_000,
            )
            with page.expect_download(timeout=180_000) as download_info:
                page.locator('[data-export="3mf"]').first.click()
            download = download_info.value
            destination = out / "ui-export.3mf"
            download.save_as(destination)
            page.locator("#toast-title").wait_for(state="visible", timeout=30_000)
            toast_title = page.locator("#toast-title").inner_text()
            size = destination.stat().st_size
            with zipfile.ZipFile(destination) as archive:
                has_model = "3D/3dmodel.model" in archive.namelist()
            check("界面3MF下载字节数", size, size > 1000, ">1000")
            check("界面3MF下载模型入口", has_model, has_model, "True")
            check(
                "界面导出成功提示",
                toast_title,
                toast_title == "导出成功",
                "导出成功",
            )
            browser.close()
    except Exception as error:
        failed += 1
        print(
            f"ASSERT FAIL 界面导出流程异常 actual={type(error).__name__} expected=none"
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
