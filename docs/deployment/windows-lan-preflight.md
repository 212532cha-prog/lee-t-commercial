# 阶段0 — Windows与受信任局域网HTTPS实机检查

REQ-20261101。当前为未验证的现场门槛，不是正式系统交付。

## 当前安排

- Windows仓库电脑下班关机，上班启动原生服务；不要求全天开机，不以Docker/WSL2作为强制依赖。
- GitHub Private只保存代码，正式数据本机保存；不开放公网端口。
- 备份路径1优先、路径2备用（可以是外接盘），不另做独立副本/连接管理/自动补存。
- 02:00错过的自动备份启动补做一次当前数据；恢复演练在备份阶段实测。

## 1. 只读Windows预检

先查看脚本内容，在仓库电脑打开PowerShell并进入项目目录：

```powershell
powershell.exe -NoProfile -File .\scripts\windows-preflight.ps1 -DataPath 'D:\WarehouseData' -BackupPath1 'D:\WarehouseBackups' -BackupPath2 'E:\WarehouseBackups'
```

上面三个路径只是参数示例，必须替换成实际路径，不会自动创建。脚本不写文件、不改防火墙、不收集密码；目录存在和剩余容量不代表写权限/真实备份已验证，输出明确标NotTested。若系统执行策略不允许脚本，先由负责人按组织策略审核/签名执行，不要求永久降低执行策略。

输出含内部IPv4，可遮盖最后一段后再分享；路径只输出配置/存在/容量状态，不输出实际文件名。系统盘空间为0属于安装阻塞，先释放空间或另行安排目标盘，不能硬装并声称成功。请核对实际Windows版本/支持性、RAM、磁盘、有线网、DHCP保留及手机可互访。

## 2. 受信任HTTPS探针

需要Node.js 22+和由受控内部CA签发、SAN包含实际内网名称/IP的服务器证书。负责人在手机安装并信任相应根证书；不要跳过浏览器证书警告。私钥仅在服务器受限目录，不提交Git。证书签发/安装在目标设备验证前不能标记通过。

```powershell
$env:PROBE_TLS_KEY = 'D:\WarehouseSecrets\server.key'
$env:PROBE_TLS_CERT = 'D:\WarehouseSecrets\server.pem'
$env:PROBE_HOST = '0.0.0.0'
$env:PROBE_PORT = '8443'
npm run preflight:https
```

默认仅监听127.0.0.1；上面是明确选择局域网监听。由负责人按仓库网段限制防火墙，不配置公网转发。手机访问证书匹配的 `https://<实际内网名称或IP>:8443/`，不是localhost；不在仓库路由器开放公网。

- 两类手机分别验证：地址无证书警告、安全上下文、服务器health、按按钮授权摄像头、实际画面、停止后摄像头释放。
- 切断外网但保留Wi-Fi/LAN，health和摄像头仍能工作；断开LAN要显示连接问题。
- 扫码枪输入测试是只读输入，不验证产品/库存，也不申请摄像头之外的权限。完整QR解码和业务扫码在后续阶段实测。
- 下载本机JSON不含扫码内容或影像；本机自报不能代替现场观察，另记录设备、系统、浏览器、证书步骤、时间和操作者。
- 探针没有生产账号/库存API，正式系统仍以登录页为首屏。

## 3. 阶段门槛

`docs/deployment/stage0-gates.json`只在实际执行后填passed、证据位置、验证时间。工程门槛 `npm run gate:stage0` 通过即可继续开发；`npm run gate:devices` 在现场项未完成时返回非零，禁止把工程通过等同真机或上线通过。

- [ ] GitHub私有性、真实CI、凭证扫描故障阻断。
- [ ] Windows预检、磁盘/原生服务安装路线。
- [ ] iPhone受信任HTTPS、授权与真实画面。
- [ ] Android受信任HTTPS、授权与真实画面。
- [ ] 无外网局域网使用、断LAN提示。

Windows服务自启、PostgreSQL并发、备份/恢复演练等后续验收继续保留，未验证项不得伪称通过。当前可用临时服务器继续开发，最终上线前仍须完成真实设备验证。
