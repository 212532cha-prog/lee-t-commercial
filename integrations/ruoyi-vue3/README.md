# LEE T 仓库 · RuoYi-Vue3 管理后台

第一阶段接入仓库总览。若依 Vue3 工程负责构建管理页面。现有 Node.js 服务和 PostgreSQL 继续处理数据、会话、权限、备份和 Android 配对。管理前端与仓库 API 使用同一 HTTPS origin，沿用 LEE T 的 HttpOnly 会话。

## 构建与预发布

1. 在可访问 GitHub 和 npm 的 Linux 构建机运行 `bash integrations/ruoyi-vue3/build.sh /absolute/new/ruoyi-admin`。脚本锁定官方上游源码提交，应用仓库入口和页面后构建静态文件。上游没有 npm 锁文件，传递依赖由 npm 解析。
2. 把构建目录复制到隔离的 Windows 测试实例，例如 `D:\LeeT\ruoyi-admin`。通过仓库服务的保护配置将 `Environment.LEE_T_RUOYI_ADMIN_DIR` 指向该绝对路径，然后重启测试服务。管理员先从原入口登录，再在同一地址打开 `/admin/`。仓库程序自身负责静态文件和 API，Windows 客户端不需要另装若依 Java 服务。
3. 从已验证的备份恢复样本，核对库存总量、总成本、负库存和补货提醒。用管理员、员工、未登录三种状态验收，然后回归原后台、扫码、盘点和断线重连。需要回退时移除该配置并重启测试服务。
4. 预发布验收通过后，按商品、员工、盘点报告、备份的顺序接入。写操作继续通过仓库 API 的 CSRF、权限和业务校验。

本集成包含仓库总览、若依前端构建及同源托管。若依的系统菜单、若依 Java 服务、其他管理页与 Windows 安装包尚未纳入。
