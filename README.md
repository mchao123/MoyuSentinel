# Moyu Sentinel

基于 Tauri 2 的 Windows 摄像头来人提醒工具。摄像头检测到人形后，可用自定义颜色的边缘光或右下角图片弹窗提醒。边缘光透明、置顶、不获取焦点，鼠标点击和滚动穿透到原来的应用。

## 使用

解压 `release/MoyuSentinel-windows-x64.zip`，双击 `MoyuSentinel.exe`。预览开启时即可查看所选摄像头的实时画面，确认后点击「开始检测」启动来人检测。首次使用需允许摄像头权限。点击「测试提醒」可在未启动检测时测试三秒提醒。

- 将摄像头朝向需要观察的入口。画面内自己也会被识别为人，可选择左侧、右侧或中间检测区域排除自己；也可将触发人数设为至少 2 人。
- 识别置信度越低越灵敏，越高越严格。连续两帧满足条件后触发；人员离开后按设置延迟熄灭。
- 关闭主窗口或点击收起按钮都会隐藏到托盘，后台检测继续。托盘菜单按当前状态显示「开始检测」「取消连接」或「停止检测」；选择「退出」会先收起边缘光，再完全退出并释放摄像头。
- 隐藏预览不会停止检测。「停止检测」会停止检测和提醒，已开启的预览继续显示。未检测时，隐藏预览、最小化或收起到托盘会释放摄像头，恢复预览后重新连接。
- 边缘光从屏幕外侧向内展开，提醒结束时保持宽度并在一秒内逐步变暗消失；淡出期间再次检测到来人会恢复显示。
- 在「提醒」页签切换「边缘光 / 图片弹窗」。边缘光支持自定义颜色、强度和宽度。每块显示器右下角都会显示图片弹窗，不抢焦点，并按 [Tauri 显示器工作区](https://docs.rs/tauri/latest/tauri/window/struct.Monitor.html#method.work_area) 避开各自的任务栏。弹窗背景透明，图片透明区域直接透出桌面。
- 弹窗图库支持批量添加最多 32 张 PNG、JPEG、GIF 或 WebP 图片（每张最多 64 MB），可删除或上下调整顺序。原始文件保存在 `MoyuSentinel-data/popup-images`，不压缩、不缩放、不转换格式；列表缩略图单独生成。原有单张图片会自动迁移。GIF 动图直接播放，自定义图片等比完整显示；清空图库后恢复默认广告。
- 图片抽取支持「随机」和「顺序」：每次新提醒抽取一张，提醒持续期间保持不变，多个屏幕显示同一张。随机模式避免连续重复；顺序模式按图库顺序循环，重启后接着上次的位置。弹窗等图片解码完成后再显示。
- 点击任意屏幕弹窗右上角关闭按钮，会同时关闭所有弹窗并暂停所有提醒，默认 3 分钟，可设置为 1–60 分钟。检测继续，切换提醒方式也不会绕过暂停；到期后自动恢复，或在控制页点击「恢复提醒」。暂停计时仅在本次运行中有效，重启会恢复提醒。
- 显示器变化后停止并重新开始检测，以重新生成各屏幕覆盖窗口。

## 局域网共享

1. 进入「共享」页面，设置设备名称，勾选「共享本机检测」并保存。默认共享端口为 `18420`，可修改；页面显示本机局域网地址和访问码。
2. 在接收电脑的「共享」页面添加设备，填写发送电脑的地址和访问码。可添加最多 16 台设备，单独启停，也可统一关闭「接收共享提醒」。接收端无需开启摄像头。
3. 任一设备检测到来人，会触发接收电脑配置的边缘光或图片提醒，主界面显示来源并记录最近提醒。暂停提醒同时作用于本机和远端来源。连接失败或状态超过三秒未更新会清除该来源的提醒，其他在线来源继续有效。

首次共享时，Windows 防火墙可能需要允许应用在专用网络通信。两台电脑需能互相访问所配置的端口。共享使用局域网 HTTP 和访问码，只提供本机检测状态、人数和事件编号，不传输视频或图片，不转发收到的远端提醒。关闭「共享本机检测」会释放监听端口；关闭主窗口只是收起到托盘，需从托盘选择「退出」才会结束所有服务。

其他机器人可读取 `GET /v1/detection`，请求头为 `Authorization: Bearer <访问码>`。返回 JSON 示例：

```json
{"protocolVersion":1,"sourceId":"设备标识","sessionId":"本次运行标识","deviceName":"前门相机","phase":"alert","people":2,"alertEvent":1,"updatedAt":1789390000000}
```

`phase` 取 `idle`、`loading`、`watching`、`alert`；新的来人提醒需递增 `alertEvent`，重启需更换 `sessionId`。接收端每秒读取一次，每台设备独立超时。

## 便携与隐私

模型和前端页面编译进 exe，原生推理依赖随便携包一起分发，运行时不依赖 Node.js、Rust、Python，也不需要联网下载模型。请移动整个解压目录，保留附带的 DLL。设置和 WebView 缓存保存在 exe 同目录的 `MoyuSentinel-data` 文件夹；移动整个目录即可携带设置。放在可写目录中，不要放在只读光盘或受保护的 Program Files 目录。

要求 Windows 10/11 x64 和 Microsoft Edge WebView2 Runtime。便携 exe 不包含浏览器运行时；多数 Windows 设备已有该组件，缺少时需安装 [Microsoft WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。如需在完全没有 WebView2 的设备上离线部署，可将微软 Fixed Version Runtime 解压到便携目录，并在启动时设置 `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` 为其目录。

视频仅在当前设备内存中处理，不录制、不保存、不上传。启用共享后，仅通过局域网传递检测结果。提醒历史仅保留当前会话最近 30 条，不包含照片。没有身份识别或人脸数据库。

## 开发与构建

构建环境：Node.js 22.12+、Rust stable MSVC、Visual Studio 2022 或更新版本的 C++ Build Tools、Windows SDK。

```powershell
npm install
npm run assets
npm run tauri dev
```

生成便携 exe 和 zip：

```powershell
npm run portable
```

仅浏览器预览：`npm run dev`，访问 `http://127.0.0.1:1420`。浏览器模式只能预览控制界面；摄像头采集、检测和系统级红光均需要 Tauri 桌面程序。

`1420` 只用于 Vite 开发服务，便携版程序不占用它。关闭浏览器或收起桌面窗口不会结束手动启动的开发服务；在运行 `npm run dev` / `npm run tauri dev` 的终端按 Ctrl+C 结束调试。正式使用建议运行便携版。

验证：`npm test`、`npm run build`、`cargo check --manifest-path src-tauri/Cargo.toml`。`cargo test --release --manifest-path src-tauri/Cargo.toml` 验证低频确认规则及真实 ONNX 模型。模型测试使用 `test-results/person-fixture.jpg` 人像样本（运行 `npm run test:browser` 会下载）；测试样本不打包到应用中。

仓库包含 `.github/workflows/windows.yml`。推送到 GitHub 的 main/master 分支或手动运行工作流后，可以下载自动构建的 Windows 便携包。

原生回归测试（Windows）：以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 启动编译后的程序，再运行 `node scripts/native-smoke.mjs`。该测试验证桌面红光像素、双屏物理尺寸、鼠标穿透窗口属性、不抢焦点、提醒超时、本机摄像头、JPEG 预览、低频推理和托盘后台检测；真实摄像头画面不落盘。仅测试时开启调试端口；正常运行不需要该环境变量。

`npm run test:glow` 会启动并自动关闭独立的临时预览服务，检查进入动画、渐暗退出和桌面/手机像素；`node scripts/glow-smoke.mjs --native` 检查真实覆盖窗口退出后隐藏。`npm run test:gallery` 检查浏览器图库与共享界面；在独立测试目录启动图库为空的桌面程序后，运行 `node scripts/gallery-sharing-smoke.mjs --native` 检查原图字节、随机/顺序选取、两路共享源、访问码、断线清理、循环防护和端口释放。

## 实现

- Rust 使用 nokhwa / Windows Media Foundation 采集摄像头，选择设备支持的原生采集格式，不强制降低摄像头帧率。
- Rust 通过 ONNX Runtime 执行 YOLOX-Nano，仅检测 COCO person。图像按比例缩小并填充到 416×416；推理采用两个 CPU 线程并关闭线程池自旋。
- 推理默认间隔 500 ms（每秒至多 2 次），滑块可在 100–2000 ms 之间调节，步进 50 ms，运行中即时生效；推理完才开始计时，不追赶积压任务。低频模式仍需连续两次确认，因此会相应增加提醒延迟。
- 控制窗口可见且预览开启时，每 100 ms 通过 Tauri IPC 拉取最新 JPEG 二进制数据；没有 Base64 编码。预览最多 640×480，JPEG 质量 65。
- 采集与处理各自运行在 Rust 后台线程，只缓存最新帧。隐藏预览、最小化或收起到托盘后，停止预览轮询及 JPEG 压缩，Rust 低频推理与提醒继续运行。
- 每个显示器的红光由上下两个透明 Tauri WebviewWindow 拼合，避免单个窗口覆盖整屏触发 Windows 全屏判断而隐藏任务栏。用物理坐标和尺寸适配混合 DPI；`set_ignore_cursor_events(true)` 实现鼠标穿透。
- 红光状态由 Rust 检测结果直接控制，不依赖页面心跳。视频源长时间无帧时进入错误状态并关闭提醒；测试红光使用三秒过期计时。

这是辅助提醒工具。光照、遮挡、摄像头视角和距离可能导致漏报或误报；程序无法检测摄像头视野外的人。操作系统安全桌面、锁屏及某些独占全屏程序上无法保证覆盖层可见。系统睡眠时检测暂停。

参考：[Tauri 窗口配置](https://v2.tauri.app/reference/config/)、[YOLOX ONNX Runtime](https://github.com/Megvii-BaseDetection/YOLOX/tree/main/demo/ONNXRuntime)、[nokhwa](https://github.com/l1npengtul/nokhwa)。第三方许可见 `THIRD_PARTY_NOTICES.md`。
