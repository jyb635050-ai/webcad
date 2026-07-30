from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "screenshots"
URL = "http://127.0.0.1:8878/index.html"


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "http.server",
            "8878",
            "--bind",
            "127.0.0.1",
        ],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(0.8)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            page = browser.new_page(viewport={"width": 1536, "height": 1024})
            page.goto(URL, wait_until="domcontentloaded", timeout=120_000)
            page.wait_for_function(
                "document.documentElement.dataset.appReady === 'true'",
                timeout=30_000,
            )
            page.screenshot(
                path=OUTPUT / "04-select-plane-start.png"
            )

            datum = page.evaluate(
                "window.__webcadQA.getDatumScreenPoint('XY')"
            )
            page.mouse.click(datum["x"], datum["y"])
            page.locator('[data-action="start-sketch"]').first.click()
            overlay = page.locator("#sketch-overlay")
            bounds = overlay.bounding_box()
            if bounds is None:
                raise RuntimeError("草图画布没有可点击区域")
            start_x = bounds["x"] + 170
            start_y = bounds["y"] + 170
            page.mouse.move(start_x, start_y)
            page.mouse.down()
            page.mouse.move(start_x + 360, start_y + 140, steps=12)
            page.mouse.up()
            page.screenshot(
                path=OUTPUT / "05-sketch-on-plane.png"
            )

            page.locator('[data-action="finish-sketch"]').first.click()
            page.locator('[data-feature="extrude"]').first.click()
            gizmo = page.evaluate(
                "window.__webcadQA.getGizmoScreenPoint()"
            )
            page.mouse.move(gizmo["x"], gizmo["y"])
            page.mouse.down()
            page.mouse.move(gizmo["x"], gizmo["y"] - 48, steps=12)
            page.mouse.up()
            page.screenshot(
                path=OUTPUT / "06-extrude-arrow-preview.png"
            )

            page.locator('[data-action="confirm-extrude"]').click()
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
            page.screenshot(
                path=OUTPUT / "07-entity-face-selected.png"
            )

            page.locator('[data-action="start-sketch"]').first.click()
            bounds = overlay.bounding_box()
            if bounds is None:
                raise RuntimeError("草图画布没有可点击区域")
            page.mouse.move(bounds["x"] + 250, bounds["y"] + 210)
            page.mouse.down()
            page.mouse.move(
                bounds["x"] + 390,
                bounds["y"] + 300,
                steps=12,
            )
            page.mouse.up()
            page.locator('[data-action="finish-sketch"]').first.click()
            page.locator('[data-feature="extrude"]').first.click()
            page.screenshot(
                path=OUTPUT / "08-face-extrude-preview.png"
            )
            for name in [
                "04-select-plane-start.png",
                "05-sketch-on-plane.png",
                "06-extrude-arrow-preview.png",
                "07-entity-face-selected.png",
                "08-face-extrude-preview.png",
            ]:
                print(f"SCREENSHOT {OUTPUT / name}")
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
