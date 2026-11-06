# 阶段 0 测试报告（未完成验收）

日期：2026-10-31
环境：Linux 容器；Node.js v22.16.0
命令：`npm test`、`npm run check`
结果：自动化测试 4 通过、0 失败、0 跳过；项目检查通过。

通过：PRD/计划存在且内容非空、敏感文件 gitignore 规则、检查脚本、PRD 局域网要求。
未执行且为阶段 0 必须项：真实 GitHub 私有性/CI 运行、密钥扫描故意泄露阻断、Windows 实机安装路线、离线 LAN、真实 iPhone/Android HTTPS 摄像头权限。
阻塞：业务未决事项见 docs/decisions/OPEN-DECISIONS.md；缺真实设备及用户授权。不得进入阶段 1。
注意：此处 0 跳过仅指实际执行的 4 个自动化测试；未执行的阶段验收项目明确列于上方，不计作通过。

## 2026-10-31 决策更新

已确认盘点冲突规则 A，并写入 ADR-001 与 PRD v1.2。其余阶段 0 阻塞事项及实机验收仍未完成，阶段 0 不予通过。

## 2026-10-31 九项业务规则确认

用户已确认全部九项规则；更新 PRD v1.3、ADR-002 和 OPEN-DECISIONS。新增第六项自动化测试。
实际运行 `npm test`：6 通过，0 失败，0 跳过；`npm run check`：通过。
测试仅验证文档与仓库结构，不代表业务功能或实机验收完成。
阶段 0 仍因 GitHub Private/CI、Windows、LAN HTTPS、真实手机、独立设备恢复等外部验收而阻塞。

## 2026-10-31 Windows 服务器环境规划

用户确认仓库有一台可长期开机的 Windows 电脑。新增只读 Windows 预检脚本和部署实机检查清单；新增两项自动化测试。
实际执行 `npm test`：8 通过、0 失败、0 跳过；`npm run check`：通过。
真实 Windows 预检、GitHub CI、局域网 HTTPS、iPhone/Android 摄像头、备份恢复尚未执行；阶段 0 仍未完成。
