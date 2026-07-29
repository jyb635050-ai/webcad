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
