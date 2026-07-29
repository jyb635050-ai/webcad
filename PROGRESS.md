# PROGRESS

## 开工回执
1. 目标：做一个无需构建、打开网页即可使用的中文参数化单零件 CAD。
2. 正确性优先：所有实体由 Replicad/OCCT 在 Web Worker 中计算。
3. 验收顺序：环境与最小内核页 → 冻结判卷器 → 特征树 → 草图与视图 → 导出 → 上线。
4. 运行依赖全部进入 `vendor/`，断网后仍能本地运行。
5. `tools/selftest.py` 在任务 1 完成并提交后冻结。
6. 最大风险：Replicad 浏览器 ESM/wasm 的真实加载与导出 API。
7. 次要风险：无 Node 环境下把 ESM 依赖完整本地化。
8. 体验风险：10.4MB wasm 首次加载时间。

## 2026-07-29
- 已确认全新目录，无旧进度可续。
- 环境实测：git 2.54.0.windows.1、Python 3.12.10、uv 0.11.23；node/npm/gh 不存在；Chrome 存在；系统 Python 无 Playwright。
- 已生成并保存完整 UI 概念图 `docs/webcad-ui-concept.png`。
- 已将 Replicad 0.23.1、OCCT wasm/glue、Three 0.185.1、fflate 0.8.3 及许可证固定到 `vendor/`；运行时不依赖 CDN。
- npm 固定版本元数据与包内 LICENSE 均确认 Replicad、replicad-opencascadejs 为 MIT。
- API 已核实：`.fillet()`、`.chamfer()`、`.shell()`、`.blobSTL()`、`.blobSTEP()` 均存在；官方文档要求 Worker 初始化 OCCT。
- 签名纠正：`makeBox` 接收两个角点，最小验证使用 `makeBox([0,0,0],[10,20,30])`，不改变 6000mm³ 的目标。
- 首次 Playwright 调用仅因 PowerShell 内联引号丢失未启动；首次真实页面验收因 bundle 隐藏引用 `/node/fs.mjs` 超时，补齐四个官方兼容模块后通过。
- 任务 0 完成：`uv run --with playwright python tools/task0_probe.py` 输出 HTTP 200、PASS，体积 6000、面数 6、三角形 12、二进制 STL 684 字节；Playwright `channel="chrome"` 可复用本机 Chrome。
- 任务 1 完成：判卷器自动发现浏览器/Python 用例，支持 `--url` 与 `out/` 产物通道；首次全绿为 PASS=4 FAIL=0 SKIP=0。
- 任务 1 反向验证：临时将箱长 10 改为 11 后体积 6600、PASS=3 FAIL=1；还原后 PASS=4 FAIL=0 SKIP=0。
- 判卷器冻结基线：提交 `351440f`；`tools/selftest.py` SHA256=`377860705892940F8F9871A2904AC279DF6F5EA008E5B64C309A49DFCCF91A33`；后续不得修改。
- 任务 2 完成：真实 OCCT 四孔板圆角前体积 97738.053289mm³；R5 后体积减少 429.203673、面数增加 4，网格三角形 2556、裸边/非流形边/退化三角形均为 0。
- 特征树补验通过：宽度改为 120 后体积 117738.053289；2mm 倒角减少体积 160、面数增加 4；旋转特征体积 9424.777961、裸边 0。
- 任务 2 全绿：PASS=16 FAIL=0 SKIP=0；所有几何计算均在 `src/geometry-worker.js`。
- 任务 3 完成：中文编辑器外壳、SVG 草图线/矩形/圆、端点吸附、双击尺寸、参数面板、特征树回改、Three.js 0.185.1 视口与本地工程保存已实现。
- Playwright 真鼠标坐标绘制并拉伸通过：三角形 12；Canvas 采样 200 像素、11 种颜色。
- 任务 3 反向验证：材质/背景/辅助线临时同色后颜色种数 1、FAIL=1；还原后 PASS=19 FAIL=0 SKIP=0。
- 任务 4 完成：OCCT 导出二进制 STL 127884B、STEP 46386B；真实网格生成 3MF ZIP 33469B、OBJ 253299B。
- Python 独立校验通过：STL 长度公式成立；3MF 含 `3D/3dmodel.model` 且解析出 2568 顶点；STEP 双标记齐；OBJ 顶点 2568。
- 打印自检：默认板水密、开放边 0、打印床通过、估算壁厚 7mm、PLA 120.663g；开放单三角面检出 3 条裸边和 1 条报警。
- 界面 3MF 下载与“导出成功”提示通过；任务 4 全绿 PASS=38 FAIL=0 SKIP=0。
