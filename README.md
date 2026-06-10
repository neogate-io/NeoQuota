# NeoQuota Monitor

NeoQuota Monitor 是一个用于 CPA Codex 账号池的本地桌面监控器。它通过 CPA Management API 采集账号额度和近期消耗，在本地展示容量、风险和账号明细，并可在容量紧张或账号异常时发送邮件告警。

当前项目只提供 Tauri 2 桌面客户端；Vite 仅作为 renderer 的开发入口，不提供独立 Web 监控页。项目不包含 CPA 服务端，也不接管账号登录态，需要使用者提供已运行的 CPA 服务、API Base 和 Management Key。

## 功能

- 多 CPA 配置：添加、编辑、启用/停用、连接测试。
- 额度总览：当前可用容量、近期消耗、5 小时内支撑能力和释放预测。
- 账号明细：查看账号状态、套餐、5h/周额度窗口、采集来源、错误和退避状态。
- 后台采集：窗口关闭后进入托盘继续运行，支持手动全量采集和单账号刷新。
- 可调配置：采集间隔、并发、请求限速、额度换算参考值。
- 邮件告警：支持 SMTP、告警级别、冷却时间和异常账号阈值。

## 安全与数据

- CPA Management Key 和 SMTP 密码保存到系统钥匙串。
- 普通配置保存到系统 App config 目录。
- 采集快照保存到系统 App data 目录下的 `quota-monitor.sqlite`。
- 不需要 `.env` 产品配置，也不会把敏感凭据写入 SQLite 或仓库。
- 邮件告警和后台采集只在桌面客户端进程运行期间生效。

## 环境要求

- Bun 1.3.x，仓库当前固定为 `bun@1.3.10`。
- Rust toolchain，版本由 `rust-toolchain.toml` 固定。
- macOS、Windows 或 Linux 对应的 Tauri 2 桌面构建依赖。
- 一个可访问的 CPA 服务，以及对应的 Management Key。

## 开发运行

```bash
bun install --frozen-lockfile
bun run desktop:dev
```

首次启动时，在配置向导中填写：

- CPA 名称
- CPA API Base，例如 `http://127.0.0.1:8398`
- CPA Management Key

项目脚本会自动优先使用 rustup 的 `~/.cargo/bin`，从而读取 `rust-toolchain.toml` 固定的 Rust 版本；不需要手动调整 PATH。

## 检查与构建

```bash
bun run type-check
bun run test
bun run desktop:build
```

`bun run test` 会运行 `src-tauri` 下的 Rust 测试；`desktop:build` 会先构建前端，再打包 Tauri 桌面应用。

## 客户端编译

macOS 客户端在 macOS 本机编译：

```bash
cd /path/to/NeoQuotaMonitor
bun install --frozen-lockfile
bun run desktop:build
```

产物位置：

```text
src-tauri/target.noindex/release/bundle/macos/NeoQuotaMonitor.app
src-tauri/target.noindex/release/bundle/dmg/NeoQuotaMonitor_0.1.0_aarch64.dmg
```

在 macOS 本机交叉编译 Windows x64 客户端时，首次需要安装 Windows target、`cargo-xwin` 和 NSIS：

```bash
cd /path/to/NeoQuotaMonitor
bun install --frozen-lockfile

bun scripts/with-rustup-path.mjs rustup target add x86_64-pc-windows-msvc
bun scripts/with-rustup-path.mjs cargo install cargo-xwin --locked
brew install makensis
```

之后编译 Windows NSIS 安装包：

```bash
cd /path/to/NeoQuotaMonitor

tmpbin="$(mktemp -d)"
ln -sf /opt/homebrew/bin/makensis "$tmpbin/makensis.exe"

PATH="$tmpbin:$PATH" bun scripts/with-rustup-path.mjs node_modules/.bin/tauri build \
  --runner cargo-xwin \
  --target x86_64-pc-windows-msvc
```

产物位置：

```text
src-tauri/target.noindex/x86_64-pc-windows-msvc/release/neo-quota-monitor.exe
src-tauri/target.noindex/x86_64-pc-windows-msvc/release/bundle/nsis/NeoQuotaMonitor_0.1.0_x64-setup.exe
```

如果只需要 Windows 裸 exe，不需要安装包：

```bash
bun scripts/with-rustup-path.mjs node_modules/.bin/tauri build \
  --runner cargo-xwin \
  --target x86_64-pc-windows-msvc \
  --no-bundle
```

macOS 交叉编译 Windows 是 Tauri 的 experimental 路径；默认不会签名，MSI 在 macOS 主机上可能被忽略。正式分发 Windows 安装包时，推荐在 Windows 机器或 Windows CI 上执行：

```powershell
bun install --frozen-lockfile
bun run desktop:build
```

## 项目结构

- `src/`：React renderer、客户端 API 封装和共享类型。
- `src-tauri/`：Tauri/Rust 后端、CPA 客户端、SQLite 存储、托盘和钥匙串集成。
- `public/`：renderer 静态资源。

## License

Apache-2.0. See [LICENSE](LICENSE).
