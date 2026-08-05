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

- 任务 5 发布前验收：已生成空白启动、四孔板拉伸、3MF 导出成功三张 1536×1024 截图，并完成五项视觉一致性记录。
- 响应式用例首轮把两个合法的示例入口误判为一个，实测桌面/手机均为 2 后保留检查并改为精确值；1536px 与 390px 横向溢出均为 0。
- 发布前冻结判卷器全绿：PASS=42 FAIL=0 SKIP=0。
- 任务 5 完成：已创建公开仓库 https://github.com/jyb635050-ai/webcad，GitHub Pages 使用 main 分支根目录。
- 线上 https://jyb635050-ai.github.io/webcad/index.html 第 5 次轮询返回 HTTP 200、16654B；冻结判卷器指向线上后 PASS=42 FAIL=0 SKIP=0，通过数不减。
- Git 作者身份只在当前仓库设置为 jyb635050-ai / users.noreply.github.com，未改全局配置；BLOCKED 仍为无。

## 2026-07-30
- 用户否决示例驱动逻辑，主流程重构为：选择基准面/实体面 → 草图 → 完成草图 → 拖箭头或输入数值拉伸；页面可见示例入口已降为 0。
- 新交互概念保存为 `docs/webcad-solidworks-flow-concept.png`；原生 `view_image` 因 Windows 1327 无法读取 D 盘，改用只读内存缩略图完成同屏视觉比较。
- Three.js 视口新增三个真实可拾取基准面、实体面射线拾取、面高亮、透明拉伸预览、法向箭头拖动与毫米值同步。
- Worker 与导出 Worker 已支持 XY/XZ/YZ 三平面拉伸，以及在现有实体面上的 fuse 追加拉伸；所有几何仍在 Worker 内完成。
- 用户明确批准迁移与新需求冲突的 `004/007/008` UI 用例；`tools/selftest.py`、几何/导出数值断言和容差未改。
- 新主流程用例：空白启动、示例入口 0、真点基准面、真画草图、拖箭头 20→32、输入 32、体积 100800、再点实体顶面，PASS=11 FAIL=0。
- 实体面追加拉伸首轮因三个基准面交叉处拾取歧义，总 Z 高度 50 而失败；将每个基准面引导点移到不重叠区域后，体积 70000.00002、总高 30.0000003、开放边 0、三角形 28，全绿 PASS=5 FAIL=0。
- SolidWorks 式重构最终本地全量：PASS=58 FAIL=0 SKIP=0；1536px/390px 横向溢出均 0，示例入口均 0。

- GitHub Pages 已构建到提交 92b7c22dd7b4c3a6568e530f4c8b2adf6067f7ee；线上首页 HTTP 200、出现「选择面」且无示例入口；线上冻结判卷器 PASS=58 FAIL=0 SKIP=0。
## 2026-07-31
- 用户报告两项缺陷：草图看起来悬浮而非贴合基准面；切除按钮不可用。
- 根因确认：草图是整屏 SVG，进入草图时隐藏了选中面且相机只近似正视；切除入口仅显示占位提示，没有写入特征树。
- 草图修复：新增真实三维草图平面层，相机严格沿所选面法向观察，视口固定 0.25mm/px；SVG 四角反投影到 XY/XZ/YZ 面的真实毫米坐标。80×40mm 验收中法向点积 1.0、最大投影误差 0.0px、基准面偏置 0mm。
- 视觉修复：草图模式隐藏会造成双平面错觉的有限旧基准面，只保留覆盖编辑视口的当前草图平面；实体面草图保留实体面蓝色底面。
- 拾取修复：宽薄零件靠近边缘点击顶面时，旧逻辑按“距包围盒中心最远轴”会误判为侧面；已改用实际被点击三角面的世界法向。
- 切除修复：实体面闭合矩形/圆草图可进入红色向内预览，支持拖箭头、输入深度或“贯穿全部”；确认后作为 cut 特征写入同一特征树。几何 Worker 和导出 Worker 均支持 XY/XZ/YZ 面、正反方向、盲孔与贯穿孔。
- 新增用例 011：贴面可见、法向、投影误差、φ20深10盲孔、φ10贯穿孔、特征数、水密与切除模型3MF独立解析，PASS=20 FAIL=0。
- 新增用例 012：XZ 侧面 φ10 深10/贯穿切除体积分别为 63214.601837/60858.407346mm³，裸边均 0，PASS=6 FAIL=0。
- 最终截图更新并新增 `09-circle-sketch-attached.png`、`10-cut-depth-preview.png`、`11-blind-hole-result.png`；原生 view_image 仍因 Windows 1327 失败，已实际调用并通过只读内存缩略图完成概念/实装视觉复核。
- 本地冻结判卷器最终：PASS=84 FAIL=0 SKIP=0；tools/selftest.py 未修改。
- GitHub Pages 已构建到修复提交 a44ea497aeae1699b91a19702e575301101dbb96；线上首页 HTTP 200、包含「贯穿全部」且旧切除占位文案为 0；线上冻结判卷器 PASS=84 FAIL=0 SKIP=0。

## 2026-08-05
- 用户截图中的三条线视觉与拓扑均已闭合；根因是旧实现只检查 rectangle/circle 实体，普通 line 从未参与闭环识别，故底部错误显示“0 个矩形，0 个圆”并误报未闭合。
- 新增线段图拓扑分析：至少 3 边、连通分量边数=顶点数、每个顶点度数=2、面积非零；状态栏同时报告闭合轮廓数与开放端点数。
- 线段闭环已接通 polygon 草图、XY/XZ/YZ 三维预览、Web Worker 内 OCCT 拉伸/切除、特征树保存和导出 Worker；草图仍严格贴合所选基准面/实体面。
- 反向验证：仅画两条线时闭合轮廓=0、开放端点=2、完成草图保持 sketch 并提示“2 个开放端点”；补第三条线后闭合轮廓=1、顶点=3、闭合间隙=0px。
- 新增 test/cases/013-line-loop-polygon.case.py：60×40 三角形拉伸20体积=24000.0mm³、三角形数=8、裸边=0；顶面三角形深10切除后体积=22500.000005mm³、特征序列 extrude/cut、裸边=0，PASS=15 FAIL=0 SKIP=0。
- 首次全量运行中旧 009 箭头拖动等待发生一次偶发超时（PASS=77 FAIL=1）；未改用例，单独原样重跑 PASS=11 FAIL=0，随后全量原样重跑 PASS=99 FAIL=0 SKIP=0。
- tools/selftest.py 未修改；本轮回滚次数 0，BLOCKED 仍为“无”。- 发布提交 1d4a030 已推送到 main；线上 src/app.js 返回 HTTP 200、47017B，并包含本提交独有 getLineProfileAnalysis 标记。
- 冻结判卷器指向 https://jyb635050-ai.github.io/webcad/ 全量复验：PASS=99 FAIL=0 SKIP=0。
## 2026-08-05 尺寸/共面/线切除全面修复
- 尺寸双击根因：草图工具在第一次 pointerdown/pointerup 时重绘并销毁 SVG 尺寸节点，浏览器无法形成 dblclick；现改为区分“点击已有实体”和“拖动开始绘图”，无拖动时不重绘，尺寸文字与线段均可稳定双击。
- 尺寸提交根因：旧逻辑依赖延迟 close 事件，连续修改宽/高时前一个 close 会清除下一个目标；现改为点击“应用”时同步更新几何再关闭，取消/Esc 只清理目标。
- 线尺寸约束：修改闭环内一条线的长度时，同一点聚类内的相邻线端点同步移动；30mm 线长修改后闭合轮廓=1、开放端点=0。
- 草图悬浮根因：活动草图平面沿法向抬高 0.025mm，实体面选择高亮另抬高 0.02mm，造成双层错觉；现活动面与网格严格位于所选平面 0mm，使用 polygonOffset/renderOrder 防闪烁，草图模式隐藏重复高亮与世界参考网格。
- 新增用例 014：双击80×40改为100×60、投影误差0px、视觉法向偏移0mm、100×60×20体积120000；实体顶面三角线轮廓首边20改30后仍闭合，深10切除体积117750.0000075mm³、裸边0，PASS=17 FAIL=0。
- 旧009箭头验收连续3次卡在 pendingExtrude 等待，按止损规则切换到拾取诊断；新增015测得射线交点1、顶层DOM=cad-canvas、48px拖动20→32mm。
- 箭头偶发根因：首次拉伸仍围绕基准面中心观察，偏置轮廓的箭头可能落到视口外；现首次预览自动聚焦轮廓中心，且射线拾取前更新世界矩阵。旧009恢复PASS=11，015为PASS=6。
- 本地冻结判卷器最终：PASS=122 FAIL=0 SKIP=0；本轮未修改 tools/selftest.py，BLOCKED仍为“无”。- 发布提交 c65152c 已推送；Pages 第6次轮询由旧 app.js 47017B 切换为新 47460B，并命中 getGizmoDiagnostics 标记。
- 冻结判卷器指向 https://jyb635050-ai.github.io/webcad/ 最终复验：PASS=122 FAIL=0 SKIP=0。
## 2026-08-05 侧面线轮廓切除方向修复
- 用户截图命中 XZ 前侧面的 polygon 切除分支。第一性原理核对 vendor/replicad.mjs：Replicad 的 XZ 命名平面法向为 -Y，数字 offset 也沿 -Y 解释；应用保存的是世界 Y 坐标与世界方向，导致 Three.js 红色预览向内而 OCCT 刀具体向外。
- 修复前红灯：新增 016 用例中，三角形盲切应为 23500mm³、实际 24000mm³；贯穿应为 22000mm³、实际 23900mm³；PASS=126 FAIL=2 SKIP=0。
- geometry-worker 与 export-worker 已统一把 XZ polygon 的世界 offset 映射为 [0, y, 0]，并反转为 Replicad 的局部拉伸符号；切除前后增加实际体积比较，无相交时不再静默写入假切除特征，而是明确提示方向/贴面错误。
- 修复后 016：盲切 23500mm³、贯穿 21999.999999999996mm³，裸边均为 0，三角形 28；该红→绿验证未改断言与容差。
- 新增 017 真实 UI 用例：鼠标点击实体前侧面得到 XZ/[0,-1,0]，三条线识别 1 个闭环，切除按钮可用，勾选贯穿全部后体积 192000→184000mm³，特征序列 extrude/cut，裸边 0。
- 同一 UI 模型导出 3MF 后由 Python zipfile+XML 独立解析并按三角网格计算体积：183999.99999999994mm³、42 顶点、28 三角形，证明导出文件保留真实切口。
- 本地冻结判卷器最终：PASS=139 FAIL=0 SKIP=0；test/cases 文件数 17。tools/selftest.py SHA256 仍为 377860705892940F8F9871A2904AC279DF6F5EA008E5B64C309A49DFCCF91A33，历史仍只有 351440f；BLOCKED 仍为“无”，本轮回滚次数 0。- 发布提交 87e7c01 已用独立 `git push` 推送；Pages 第 7 次轮询时 geometry-worker.js 由 14023B 切换为 14823B、app.js 由 47460B 切换为 47813B，并同时命中 sketchDirection/getFrontFaceScreenPoint 新标记。
- 冻结判卷器指向 https://jyb635050-ai.github.io/webcad/ 最终线上复验：PASS=139 FAIL=0 SKIP=0；线上 016 的 XZ 三角盲切/贯穿体积为 23500/21999.999999999996mm³。