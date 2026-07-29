# 构形 WebCAD

免费、无需安装、打开网页即可使用的中文参数化单零件建模工具。几何由 Replicad / OpenCascade 在 Web Worker 中计算，主线程只负责草图交互和 Three.js 渲染。

## 能做什么

- 鼠标绘制线、矩形和圆，端点吸附，双击修改尺寸
- 拉伸、旋转、切除、圆角、倒角，参数变化后整条特征树重算
- 导出二进制 STL、标准 3MF、STEP、OBJ，单位固定为 mm
- 导出前检查水密、开放边、非流形边、打印床尺寸和壁厚估算
- 工程自动保存到浏览器，也可导入/导出 JSON
- 不使用 Node、构建工具、账号、云存储或运行时 CDN

## 本地运行

```powershell
python -m http.server 8000
```

打开 `http://127.0.0.1:8000/`。

## 自检

```powershell
uv run --with playwright python tools/selftest.py
```

自检会复用本机 Chrome，覆盖真实 OCCT 几何、鼠标草图、WebGL 画布、四种导出和 Python 独立文件解析。

## 第三方组件

- replicad 0.23.1 — MIT
- replicad-opencascadejs 0.23.0 — MIT
- Three.js 0.185.1 — MIT
- fflate 0.8.3 — MIT

固定版本文件和许可证均位于 `vendor/`。
