# HoloCubic CLI 🧊⌨️

[![English](https://img.shields.io/badge/README-English-4C9AFF?style=for-the-badge&logo=github)](README.md)
[![简体中文](https://img.shields.io/badge/README-简体中文-F06292?style=for-the-badge&logo=github)](README.zh-CN.md)

## HoloCubic 生态附属项目

| 🧊 固件与设备 | 🧩 应用生态 | ⌨️ CLI 附属工具 |
| --- | --- | --- |
| **[clocteck/holocubic-nes-esp32](https://github.com/clocteck/holocubic-nes-esp32)** | **[clocteck/holocubic-apps](https://github.com/clocteck/holocubic-apps)** | **[Tim-1e/holocubic-cli](https://github.com/Tim-1e/holocubic-cli)** |
| 上游固件与 DevTools | 上游 HoloCubic 应用集合 | 跨平台设备自动化工具 |
| 官方上游仓库 | 官方上游仓库 | 社区附属项目 · 你在这里 ✨ |

HoloCubic CLI 是面向上述两个 HoloCubic 上游仓库的社区附属项目。它不替代
固件或应用集合，而是把 DevTools 工作流封装成可在 Windows、Linux 和 macOS
上运行、也方便脚本调用的命令行工具。

[![npm](https://img.shields.io/npm/v/%40princival%2Fholocubic-cli?label=npm&color=CB3837)](https://www.npmjs.com/package/@princival/holocubic-cli)
[![PyPI](https://img.shields.io/pypi/v/holocubic-cli-python?label=PyPI&color=3775A9)](https://pypi.org/project/holocubic-cli-python/)
[![crates.io](https://img.shields.io/crates/v/holocubic-cli-rust?label=crates.io&color=DEA584)](https://crates.io/crates/holocubic-cli-rust)
[![License](https://img.shields.io/github/license/Tim-1e/holocubic-cli)](LICENSE)

[![Node CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-node.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-node.yml)
[![Python CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-python.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-python.yml)
[![Rust CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-rust.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-rust.yml)
[![Full CLI conformance](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-conformance.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-conformance.yml)

HoloCubic CLI 提供三种稳定、跨平台的 HoloCubic DevTools HTTP API 命令行
客户端。选择自己熟悉的运行时即可；三种实现均提供一致的设备连接、SD 卡文件
管理、DevRun 和应用管理功能。

> [!WARNING]
> 当前 DevTools API 没有身份认证。请只在可信局域网内使用，不要把设备的
> HTTP 服务暴露到公网。

## 正式版软件包

| Node.js | Python | Rust |
| --- | --- | --- |
| **参考实现 · 正式版** | **兼容实现 · 正式版** | **兼容实现 · 正式版** |
| 软件包：[`@princival/holocubic-cli`](https://www.npmjs.com/package/@princival/holocubic-cli) | 软件包：[`holocubic-cli-python`](https://pypi.org/project/holocubic-cli-python/) | Crate：[`holocubic-cli-rust`](https://crates.io/crates/holocubic-cli-rust) |
| 命令：`cubic` | 命令：`cubic-py` | 命令：`cubic-rs` |
| Node.js 22.12+ | Python 3.10+ | Rust 1.85+ |
| [实现说明](implementations/node/README.md) | [实现说明](implementations/python/README.md) | [实现说明](implementations/rust/README.md) |

三个软件包均以正式版 `0.1.0` 发布。

## 安装

三种实现任选其一，不需要全部安装。

### Node.js / npm

```sh
npm install --global @princival/holocubic-cli
cubic --version
```

### Python / PyPI

```sh
python -m pip install holocubic-cli-python
cubic-py --version
```

使用 uv 时，可以将 CLI 安装为独立工具：

```sh
uv tool install holocubic-cli-python
cubic-py --version
```

### Rust / crates.io

```sh
cargo install holocubic-cli-rust --version 0.1.0 --locked
cubic-rs --version
```

## 快速开始

下面使用 `cubic` 演示。使用 Python 或 Rust 软件包时，将其替换为 `cubic-py`
或 `cubic-rs` 即可。

```sh
cubic device add desk 192.168.3.26
cubic ping
cubic info
cubic ls /sd/apps
cubic push ./my-app /sd/apps/my-app
cubic pull /sd/apps/my-app ./my-app-backup
```

临时指定设备不会修改已经保存的配置：

```sh
cubic --host 192.168.3.26 --json info
```

设备地址按 `--host`、`CUBIC_HOST`、当前选中设备的顺序解析。脚本或 CI 可用
`CUBIC_CONFIG` 指定独立配置文件。

## 为开发者和 Agent 设计

- **开发者**可以直接在终端管理 SD 卡文件和应用、自动化重复部署步骤，并在
  本地保存多个设备配置。
- **脚本和 CI**可以明确选择设备、用 `CUBIC_CONFIG` 隔离配置、解析 `--json`
  输出，并根据明确的退出码判断成功或失败。
- **AI Agent**可以安装任意一种软件包，将 CLI 作为受控子进程调用，无需重新
  实现 DevTools HTTP 协议。

适合机器读取的会话可以先从只读探测开始：

```sh
cubic --host 192.168.3.26 --json ping
cubic --host 192.168.3.26 --json info
cubic --host 192.168.3.26 --json ls /sd/apps
```

Agent 应优先使用明确的设备地址和 JSON 输出，修改前先检查，并保留 CLI 提供的
`--force`、`--recursive` 和 `--yes` 安全保护。

## 可以做什么

| 模块 | 功能 |
| --- | --- |
| 🔌 设备连接 | 保存设备配置、临时地址、连通性测试、能力发现和 JSON 输出 |
| 💾 SD 卡文件管理 | 列出、查看、读取、新建、重命名、删除，以及递归上传和下载 |
| 🛠️ 开发工作流 | DevRun 读取/保存/运行，以及应用列表/安装/删除 |

三种实现提供相同的命令集合：

```text
device add|list|use|remove
ping
info
ls [remote]
stat <remote>
cat <remote>
mkdir <remote>
mv <source> <target>
rm [-r --yes] <remote>
push|upload <local> [remote]
pull|download <remote> [local]
devrun read|save|run
app list|install|remove
```

文件夹传输会保留空文件夹和任意二进制数据，并限制递归深度、条目数量和下载
大小；符号链接会被拒绝，写入通过临时同级路径提交。覆盖已有目标需要
`--force`，递归删除需要同时传入 `--recursive --yes`。

## 从源码安装

```sh
git clone https://github.com/Tim-1e/holocubic-cli.git
cd holocubic-cli
```

然后参考对应实现的开发说明：

- [Node.js](implementations/node/README.md)
- [Python](implementations/python/README.md)
- [Rust](implementations/rust/README.md)

## 接口约定、测试和 CI

设备 API 记录在 [`spec/api-v1.md`](spec/api-v1.md)，共享 CLI 行为记录在
[`spec/cli-v1.md`](spec/cli-v1.md)。

| 工作流 | 测试矩阵 / 职责 |
| --- | --- |
| Node CI | Windows、Ubuntu、macOS × Node.js 22 和 24：6 个任务 |
| Python CI | Windows、Ubuntu、macOS × Python 3.10 和 3.13：6 个任务 |
| Rust CI | Windows、Ubuntu、macOS × stable Rust：3 个任务 |
| Full CLI conformance | 一个 Linux 任务让三种 CLI 对同一模拟设备执行一致性测试 |

一致性门禁覆盖设备配置、二进制文件与空文件夹递归往返、重命名/删除保护、
DevRun、应用工作流、JSON 输出和退出码。维护者发布流程记录在
[`docs/RELEASING.md`](docs/RELEASING.md)。

## 支持项目 💙

如果这个附属工具让你的 HoloCubic 使用和开发更方便，欢迎实际使用、分享给
其他 HoloCubic 用户，并给仓库一个 ⭐。也欢迎提交问题和范围明确的 PR。

项目使用 [MIT License](LICENSE) 发布。
