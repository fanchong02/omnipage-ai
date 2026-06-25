# Omnipage AI

AI 智能测试任意 H5 / Web 页面。通过 Playwright + DOM 扫描 / AI Agent 读取页面并模拟真人操作，支持全站逐页探索。

**零侵入**：不修改被测业务工程，只通过 URL 访问已部署环境。

## 快速开始

```bash
pnpm install
pnpm test:install      # 安装 Chromium
cp .env.example .env   # 复制后按需填写（见下方）
cp config/accounts.example.yaml config/accounts.yaml  # 可选：多账号场景
```

## .env 配置

从 `.env.example` 复制为 `.env` 后填写。登录凭据优先从 `E2E_EMAIL` / `E2E_PASSWORD` 读取；`QA_LLM_API_KEY` 为可选，用于 AI 截图分析与 Agent。详见根目录 [README.md](../README.md#env-配置)。

```bash
# 启动后输入要测试的 URL（也可 --url 直接传入）
pnpm explore

# 或直接指定链接
pnpm explore --url https://example.com/login --platform h5 --email test@example.com --password 'your-pass'
pnpm explore --url https://example.com --platform web --max-actions 20

# 多页面扫描
pnpm scan --urls https://example.com/,https://example.com/about
```

## 命令

| 命令 | 说明 |
|------|------|
| `pnpm explore` | 单页启发式探索；**默认全站模式**（测完自动跳转站内链接） |
| `pnpm scan` | 单 URL 时同 explore；多 URL 时逐页测试 |
| `pnpm agent --url <url> --task "<任务>"` | AI Agent 自然语言任务 |
| `pnpm autogen [--url <url>]` | 截图分析并自动生成 YAML 用例 |
| `pnpm run <scenario.yaml>` | 跑手写 YAML 场景 |
| `pnpm regression <suite.yaml>` | 跑自定义用例集 |

### 常用参数

- `--url <url>` — 测试页面（完整 URL，如 `https://example.com/page`）
- `--urls a,b,c` — 多个页面（仅 `scan`）
- `--platform h5|web` — 页面类型：`h5` 手机小屏，`web` 桌面大屏
- `--email` / `--password` — 登录凭据（遇登录页时使用；未传时从 `.env` 的 `E2E_EMAIL` / `E2E_PASSWORD` 读取，再提示终端输入）
- `--no-login` — 禁用自动登录
- `--max-actions 12` — 每个页面最多探索步数
- `--max-pages 30` — 全站模式最多测试页面数（默认开启，测完当前页后继续跳转）
- `--no-crawl` — 仅测当前 URL，不自动跳转其他页面
- `--account e2e` — 无启动凭据时，回退到 `config/accounts.yaml`
- `--device mobile|webview-ios|desktop` — 设备模拟
- `--headless` — 无头模式

- **不要提交** `config/accounts.yaml`、`.env`（已在 `.gitignore`）
- 登录凭据优先通过 CLI `--email` / `--password` 或 CI 密钥变量传入
- 示例配置仅使用 `test@example.com` 等占位符

## 环境变量

| 变量 | 说明 |
|------|------|
| `E2E_BASE_URL` | 默认站点 origin（启动时输入 URL 会自动覆盖） |
| `E2E_EMAIL` / `E2E_PASSWORD` | 自动登录凭据（未在终端输入时从此读取） |
| `QA_LLM_API_KEY` | LLM API Key（AI 截图分析 / 逐步思考，可选） |
| `QA_LLM_BASE_URL` | OpenAI 兼容 API 地址 |
| `QA_LLM_MODEL` | 模型名，默认 `gpt-4o-mini` |

无 LLM Key 时，探索降级为 DOM 扫描 + 启发式队列。

## 目录结构

```
config/          # 环境与设备配置
  accounts.yaml  # 测试账号（gitignore，从 accounts.example.yaml 复制）
examples/        # 示例 YAML 场景
fixtures/        # 可选 API mock 响应（场景级 mocks 使用）
src/
  agent/         # 页面探索、AI 规划、截图分析
  auth/          # 自动登录
  runner/        # Playwright 会话与场景执行
  reporters/     # HTML 报告
reports/         # 运行产出（gitignore）
```

## 报告

每次运行后在 `reports/<name>-<timestamp>/` 生成：

- `index.html` — 步骤结果与探索流程详情
- `step-*.png` — 截图
- `result.json` — 机器可读结果

## 更多

见 [scenarios.md](./scenarios.md) 了解如何编写 YAML 场景。
