from __future__ import annotations

import struct
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(sys.argv[1]).resolve()
    out = root / "out"
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
        stl = (out / "plate.stl").read_bytes()
        triangle_count = struct.unpack_from("<I", stl, 80)[0]
        check(
            "Python独立校验STL长度",
            len(stl),
            len(stl) == 84 + 50 * triangle_count,
            str(84 + 50 * triangle_count),
        )

        with zipfile.ZipFile(out / "plate.3mf") as archive:
            names = set(archive.namelist())
            check(
                "Python独立校验3MF模型入口",
                "3D/3dmodel.model" in names,
                "3D/3dmodel.model" in names,
                "True",
            )
            model_xml = archive.read("3D/3dmodel.model")
        model = ElementTree.fromstring(model_xml)
        namespace = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}
        vertices = model.findall(".//m:vertex", namespace)
        check(
            "Python独立解析3MF顶点数",
            len(vertices),
            len(vertices) > 0,
            ">0",
        )

        step = (out / "plate.step").read_text(encoding="utf-8", errors="replace")
        step_markers = int("ISO-10303-21" in step) + int(
            "END-ISO-10303-21" in step
        )
        check("Python独立校验STEP标记", step_markers, step_markers == 2, "2")

        obj = (out / "plate.obj").read_text(encoding="utf-8")
        vertex_lines = sum(1 for line in obj.splitlines() if line.startswith("v "))
        check("Python独立校验OBJ顶点行", vertex_lines, vertex_lines > 0, ">0")
    except Exception as error:
        failed += 1
        print(
            f"ASSERT FAIL Python导出校验异常 actual={type(error).__name__} expected=none"
        )
        print(str(error).replace("\ufffd", "?"))

    print(f"SELFTEST_CASE pass={passed} fail={failed} skip=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
