# 构形 WebCAD

免费、无需安装、打开网页即可使用的中文参数化单零件建模工具。几何由 Replicad / OpenCascade 在 Web Worker 中计算，主线程只负责草图交互和 Three.js 渲染。

## 能做什么

- 鼠标绘制线、矩形和圆，端点吸附，双击修改尺寸
- 拉伸、旋转、切除、圆角、倒角，参数变化后整条特征树重算
- 导出二进制 STL、标准 3MF、STEP、OBJ，单位固定为 mm
- 导出前检查水密、开放边、非流形边、打印床尺寸和壁厚估算
- 工程可保存到浏览器，也可导入/导出 JSON
- 不使用 Node、构建工具、账号、云存储或运行时 CDN

## 建模逻辑

1. 新建工程始终从空白零件开始。
2. 在三维视口或特征树选择前视、上视、右视基准面；已有实体时可直接点选实体面。
3. 点击“草图”，在线条、矩形、圆之间选择并绘制闭合轮廓。
4. 点击“完成草图”，再点击“拉伸”。
5. 在视口拖动蓝色法向箭头自由调整，或在右侧输入精确毫米值，点击“确定”生成特征。
6. 继续点选新实体面即可建立下一张草图并追加拉伸。

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
