# Lee T 发售准备与交付状态

更新于 2026-11-12，马来西亚时间。

## 本次发行范围

首发包含 Windows 仓库、Android App 和本机 License Center，使用离线设备请求及签名许可证完成激活。Android 管理员支持保持登录和查看最后同步的库存。iOS 已取消，在线激活的历史开发记录归档保留。

界面默认英文，提供简体中文和马来文，Windows、Android、安装器、入口及封面使用用户提供的 Lee T 商业 Logo。新增界面已做部分覆盖，最终包的完整三语和品牌验收待执行。

## 当前结论

工程功能已分别提交 GitHub。下表各 PR 在本次核对时均开放且尚未合并。它们采用不同基线或存在依赖，发售前需要整合为明确的统一候选版本，并完成同版回归及实机验收。

当前交付是测试包，正式签名与安全分发验收待完成。

## 已提交的开发成果

| 模块 | 已实现行为 | 代码与工程证据 | 后续验收 |
| --- | --- | --- | --- |
| 原生 Windows 激活 | 原生激活窗口、设备请求导出、签名许可证导入、验证通过后继续安装、受保护的安装身份和激活配置 | [PR #19](https://github.com/212532cha-prog/lee-t-commercial/pull/19) | 与统一发行候选包完成空白 Windows 安装、退出重开和断网重启 |
| Android 员工登录修复 | 统一原生请求的 Cookie 来源，修复登录成功后库存接口返回 401 的问题 | [PR #21](https://github.com/212532cha-prog/lee-t-commercial/pull/21) | 用户已反馈手机进入成功，并完成扫码入库、出库和盘点。记录适用的旧测试版，统一候选版需复测 |
| 本地离线签发 | 本机客户、付款记录、设备请求签发、原请求重试复用许可证与授权审计 | [PR #23](https://github.com/212532cha-prog/lee-t-commercial/pull/23)，[构建](https://github.com/212532cha-prog/lee-t-commercial/actions/runs/42599426865) | 最终安装包的付款、签发、许可证导入及升级和换机全链路 |
| Logo 与首次账号 | 仓库桌面、安装和 Android 入口品牌化。客户自选首次管理员登录名及显示名，首次账号设置支持三语 | [PR #25](https://github.com/212532cha-prog/lee-t-commercial/pull/25)，[构建](https://github.com/212532cha-prog/lee-t-commercial/actions/runs/42624742847) | 最终候选包的入口、图标、首次账号、三语显示及现有账号兼容 |
| Android 管理员 | 独立管理员连接入口、仓库身份二维码和证书指纹核验，管理员与员工分别保存连接资料 | [PR #26](https://github.com/212532cha-prog/lee-t-commercial/pull/26)，[APK 构建](https://github.com/212532cha-prog/lee-t-commercial/actions/runs/42742466009) | OPPO 真机管理员登录、切换身份、退出和重新连接 |
| Android 保持登录与离线库存 | Android Keystore 保护的七天会话与仓库绑定库存快照。快照包含编号、名称、数量和同步时间，只读展示，退出后清除保存访问 | [PR #27](https://github.com/212532cha-prog/lee-t-commercial/pull/27)，[APK 构建](https://github.com/212532cha-prog/lee-t-commercial/actions/runs/42744593280)，[Windows 配套构建](https://github.com/212532cha-prog/lee-t-commercial/actions/runs/42744593433) | 电脑关机后完全重开 App、快照时间、七天期限、退出清理、重连刷新及管理员权限 |
| 内置签发信任资料 | 离线安装变体内置签发公钥与 Key ID，省去客户手填，严格校验 Ed25519 公钥并使用独立激活缓存 | [PR #28](https://github.com/212532cha-prog/lee-t-commercial/pull/28)，[Windows 构建](https://github.com/212532cha-prog/lee-t-commercial/actions/runs/42747664506) | CI 使用临时测试公钥。已找回用户上传的公钥，并用旧许可证核验配套 Key ID。该组资料的定制客户包尚待生成及实机验证 |
| License Center EXE | WPF 桌面界面、Lee T Logo、英文和中马文切换、步骤高亮及状态动画、客户和付款管理、设备请求导入与许可证保存。离线专用启动模式关闭在线发码入口 | [PR #29](https://github.com/212532cha-prog/lee-t-commercial/pull/29)，[EXE 构建](https://github.com/212532cha-prog/lee-t-commercial/actions/runs/42752153225) | 当前 EXE 连接预先配置的本机服务，完整安装向导及双击自动启动数据库和后台待开发。现场桌面签发仍待确认 |

## 已有测试证据

- PR #23 的原生 Windows、本机授权数据库、TLS 操作员登录、付款签发、重复签发和独立验签有成功构建。
- PR #25、#26 和 #27 对应的 Node 回归、Windows、Android 和管理页面工作流在本次核对时均成功。
- 本地全量日志记录管理员入口阶段 308 项通过、离线库存阶段 309 项通过、内置公钥阶段 310 项通过，各阶段零失败零跳过。测试数量对应各自源代码分支。
- PR #28 的 Windows 构建和 Warehouse Inventory CI 均成功。
- PR #29 的 Windows EXE 发布及隔离授权服务集成测试成功，覆盖错误密码拒绝、在线发码接口关闭、重复签发及独立验签。该分支 Node 22 和 24 回归成功，Node 24 全量为 307 项通过、零失败零跳过。
- 分支回归证据按其源代码版本记录。统一候选版本完成后，需生成该版本的全量结果和现场证据。

## 2026-11-12 现场安装与恢复记录

用户反馈新测试安装被旧仓库服务注册拦截，后续又因旧 QA 激活缓存与当前签发公钥不匹配而无法准备激活。排查后指导备份旧服务注册和旧激活缓存，并为新的安装身份重新导出请求。

授权数据库服务原来依赖旧仓库安装目录里的 PostgreSQL 程序。现场程序文件缺失，补回后又发现 share/timezone 缺失，导致 Asia/Kuala_Lumpur 配置被拒。用户补齐 PostgreSQL 17 程序和时区资料后，已反馈授权数据库服务为 Running。

授权数据库已恢复运行。License Center 后台启动、桌面连接和本次许可证签发仍待用户反馈。

上述问题形成以下发行待办。

- [ ] License Center 安装器部署自己的完整运行依赖，验证 bin、lib、share 和实际时区解析。
- [ ] 双击 License Center EXE 自动启动并检查数据库和后台，提供可操作的错误信息。
- [ ] 仓库升级、迁移、修复及卸载流程检查其他组件对运行文件的依赖。
- [ ] 激活缓存的签发身份冲突应有明确说明和保留旧授权的修复流程。
- [ ] 统一验收清单记录最终安装包版本与实际机器结果。

## 正式发售签名与安全分发要求

已建立 [发售门槛任务 #30](https://github.com/212532cha-prog/lee-t-commercial/issues/30)。

- [ ] Android 采用固定正式发布签名，保护及备份签名密钥，验证升级后账号和应用数据保留。
- [ ] Google Play 分发准备签名 AAB、平台所需资料并完成审核及商店安装验证。直接 APK 分发提供可信下载和 SHA-256 校验，说明实际未知来源提示。
- [ ] Windows 仓库安装器、桌面 EXE 和 License Center EXE 使用受信任代码签名，核对发布者、证书链、时间戳和签后完整性。
- [ ] 对最终产物执行安全扫描及干净 Windows、OPPO 安装测试，保存版本、文件哈希、系统版本、签名和检测结果。
- [ ] 记录来源提示、发布者信誉警告与具体恶意软件检测的完整文本。具体检测先定位原因，确认误报后走厂商申诉并复测。
- [ ] 安全防护保持启用并完成发行验收，顾客安装说明完整。
- [ ] 最终三语、Logo、安装、激活、备份恢复、迁移、升级和回退均验收通过后，形成发售结论。

签名身份及可信分发有助于识别发布者和文件完整性。直接下载 APK 的来源提示以及新 Windows 文件的信誉警告可能仍出现，正式签名无法保证所有设备上的警告立即消失。

官方说明见 [Google Play Protect](https://support.google.com/android/answer/2812853)、[Google 开发者警告指南](https://developers.google.com/android/play-protect/warning-dev-guidance) 和 [Microsoft SmartScreen 信誉说明](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)。
