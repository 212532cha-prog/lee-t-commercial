# LEE T Warehouse Inventory

Windows局域网库存系统，需求基线REQ-20261101：PRD v2.1、开发计划 v3.1、验收清单 v1.1。

当前已实现登录/员工管理、产品/基础资料/照片/稳定QR、入出库/草稿/管理员调整/历史编辑及安全清理、双路径完整备份和上传恢复、固定盘点任务/只报告盘点/报告回收站、总览成本个人资料和真实英文PDF/Excel导出。阶段8已增加实际浏览器与容量回归、HTTPS及Windows服务安装路线；原生CI与现场结果见阶段8报告，尚不能投入正式仓库。现场门槛继续保留，不绑定最终电脑。

## 当前可运行

需要Node.js 22.17+或24+；TLS集成测试需OpenSSL；真实文件测试需Python3和Poppler pdftotext（CI安装检查），应用运行本身不依赖这些测试工具。使用锁定生产依赖pg、@node-rs/argon2、qrcode、sharp、PDFKit、fontkit、yazl及本地OFL中文字体；本地SQL测试用嵌入式PostgreSQL WASM（PGlite），CI强制使用独立PostgreSQL 17服务，不用内存对象冒充数据库，也不把嵌入式串行执行冒充生产多连接并发。

```sh
npm ci
npm test
npm run lint
npm run check
npm run scan:secrets
npm run gate:stage0
```

`npm run gate:stage0` 检查工程门槛；`npm run gate:devices` 在现场证据缺少时仍返回非零。没有删除或假报真机验收。

HTTPS摄像头/扫码枪输入预检及只读Windows脚本：见 [现场操作指引](docs/deployment/windows-lan-preflight.md)。正式应用支持直接HTTPS（PEM或PFX）或仅loopback监听后接受信任HTTPS反向代理；Windows安装与换机见 [安装迁移手册](docs/deployment/install-and-migrate.md)。预检探针仍是独立端口，无生产数据或账户。

## 规则

盘点只生成报告不写库存；历史清理不改余额；产品直接永久删除受168小时和未完成任务保护；无计量单位/产品回收站；双路径主备及双满管理员专属限制；一个管理员多设备、员工单设备接管；导出固定英文无照片。

旧ADR冲突替换和测试迁移：见 [ADR-003](docs/decisions/ADR-003-confirmed-revision-20261101.md)。阶段进度与未完成门槛见 [阶段0报告](docs/test-reports/stage-0-current.md)。不得用本地工具测试冒充真实PostgreSQL/Windows/手机/恢复验收。

## 阶段1启动（开发/测试）

先安装PostgreSQL、建立专用空数据库，在受保护环境中设置 `DATABASE_URL`、`PUBLIC_ORIGIN`（HTTPS域名或内网地址，无末尾斜杠）及首次安装的 `BOOTSTRAP_ADMIN_PASSWORD`。初始用户名是CTL LEE，口令使用负责人指定值，不写入源码。随后运行 `npm start`。后端只监听127.0.0.1，默认3000端口，由HTTPS反向代理提供局域网入口。重启不会重置现有管理员口令。

所有地址/证书/数据库/备份路径均外置配置，不绑定某台电脑；已实现完整备份包下载、上传及整套恢复；Windows安装/迁移操作已提供，实际设备验证仍需执行，换机仍需要新环境和证书配置。

开发者本机受控恢复：设置 `DATABASE_URL`、`RECOVERY_ADMIN_USERNAME`、`RECOVERY_ADMIN_PASSWORD` 后执行 `npm run recover:admin`；保留内部账号ID并撤销会话，不提供公开找回密码API。不要把实际环境变量或数据库内容发到GitHub。

产品照片目录通过DATA_DIR配置（默认工作目录data/product-photos），文件受后端鉴权，不能作为公开静态目录。产品删除已检查168小时事件和未完成任务引用，报告、草稿、导出及缓存已接入级联清理并有自动测试，现场验收仍需完成。

## 候选包与测试记录

[阶段8报告](docs/test-reports/stage-8-current.md)记录原生数据库、浏览器、容量和Windows工程证据及现场阻塞。全量Linux/Windows CI通过后自动生成source-candidate.zip，并独立校验清单和每个源文件SHA256。候选包不含Node.js、PostgreSQL、npm依赖、业务数据或证书，不是免安装可执行程序；先按安装迁移手册准备环境。它不代表正式release或现场验收通过。

受控打包命令：干净的代码提交上运行 `npm run package:candidate`，再运行 `python scripts/verify-candidate.py`。输出只进dist，不包含本机数据。
