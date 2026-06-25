# Omnipage AI

**AI 智能测试任意 H5 / Web 页面** — 给一个链接，自动登录、逐页探索、筛选项验证，测完为止。

> **发布前注意**：`config/accounts.yaml` 与 `.env` 含敏感信息，已在 `.gitignore` 中，请勿提交。

## 安装

```bash
pnpm install && pnpm test:install   # 安装依赖与 Chromium
cp .env.example .env                        # 复制后按需填写（见下方）
cp config/accounts.example.yaml config/accounts.yaml  # 可选：多账号场景时使用
```

## .env 配置

在项目根目录创建 `.env`（从 `.env.example` 复制）。**该文件已在 `.gitignore` 中，不会提交到 Git。**

```bash
cp .env.example .env
```

最小配置示例（只需自动登录、不测 AI 功能时）：

```env
# 自动登录（未在终端输入 --email / --password 时从此读取）
E2E_EMAIL=your@email.com
E2E_PASSWORD=your-password
```

完整配置示例：

```env
# 默认站点（启动时输入 URL 会自动覆盖；跑相对路径场景时需要）
E2E_BASE_URL=http://localhost:3000

# 自动登录凭据（优先级：CLI --email/--password > .env > 终端提示）
E2E_EMAIL=your@email.com
E2E_PASSWORD=your-password

# AI 截图分析 / Agent 逐步思考（可选；不填则降级为 DOM 扫描）
QA_LLM_API_KEY=sk-...
QA_LLM_BASE_URL=https://api.openai.com/v1
QA_LLM_MODEL=gpt-4o-mini
QA_LLM_VISION_MODEL=gpt-4o-mini

# 运行行为（可选）
# HEADLESS=false        # 本地默认可视化；CI 设 true
# QA_SLOW_MO=300        # 每步操作延迟（毫秒）
# OPEN_REPORT=false     # 不自动打开报告
```

| 变量 | 必填 | 说明 |
|------|------|------|
| `E2E_EMAIL` / `E2E_PASSWORD` | 否 | 遇登录页时自动填表；也可用 CLI `--email` / `--password` 或 `config/accounts.yaml` |
| `E2E_BASE_URL` | 否 | 默认站点 origin；`pnpm run run` 跑相对路径场景时需要 |
| `QA_LLM_API_KEY` | 否 | 开启 AI 截图分析、Agent 思考、视觉审查；不填时探索仍可用（DOM 扫描） |
| `QA_LLM_BASE_URL` | 否 | OpenAI 兼容 API 地址，默认 `https://api.openai.com/v1` |
| `QA_LLM_MODEL` | 否 | 文本模型，默认 `gpt-4o-mini` |
| `QA_LLM_VISION_MODEL` | 否 | 视觉模型，默认与 `QA_LLM_MODEL` 相同 |
| `HEADLESS` | 否 | `true` 无头 / `false` 显示浏览器 |
| `OPEN_REPORT` | 否 | `false` 不打开报告 / `each` 每个用例都打开 |

登录凭据的读取优先级：**CLI 参数** → **`.env`** → **终端交互提示** → **`config/accounts.yaml`**（`--account` 时）。

## 命令一览

| 命令 | 说明 |
|------|------|
| `pnpm explore` | 单 URL 启发式探索，**默认全站模式**（测完自动跳转站内链接） |
| `pnpm scan` | 多 URL 逐页探索；单 URL 时行为类似 explore |
| `pnpm scan:ci` | 无头模式 scan，适合 CI |
| `pnpm agent` | AI Agent 按自然语言任务操作页面 |
| `pnpm autogen` | 截图分析并自动生成 YAML 用例 |
| `pnpm run run <file.yaml>` | 执行手写 YAML 场景（见下方说明） |
| `pnpm regression <suite.yaml>` | 批量跑用例集 |
| `pnpm regression:ci` | 无头模式 regression |
| `pnpm aggregate` | 汇总回归报告 |
| `pnpm visual-review` | 对已有报告做 AI 视觉审查 |
| `pnpm test:install` | 安装 Playwright Chromium |

`pnpm start`、`pnpm qa` 与 `pnpm explore` 等价。`heuristic`、`scan:all` 及其 `:ci` 变体与 `scan` 等价，为历史别名。

未传 `--url` 时，启动后会提示输入要测试的页面链接。

---

## explore — 页面 / 全站探索

自动识别按钮、输入框、筛选项等可交互元素并逐一操作，默认测完当前页后继续跳转站内链接。

```bash
pnpm explore                                          # 启动后输入 URL
pnpm explore --url https://example.com                # 直接指定链接
pnpm explore --url https://example.com/login --platform h5
pnpm explore --url https://example.com --platform web --max-actions 20
pnpm explore --url https://example.com --no-crawl     # 仅测当前页，不跳转
pnpm explore --url https://example.com --max-pages 50 # 全站最多测 50 页
```

默认每页最多探索 30 步（`--max-actions`），全站最多 30 页（`--max-pages`）。

---

## scan — 多页面扫描

适合一次测多个独立 URL，或 CI 流水线。

```bash
pnpm scan --url https://example.com
pnpm scan --urls https://example.com/,https://example.com/about
pnpm scan --urls https://a.com/,https://a.com/pricing --max-actions 8
pnpm scan:ci --url https://example.com --open-report false   # CI 无头运行
```

单 URL 时默认开启全站模式（同 explore）；多 URL 时逐页测试、不跨页跳转。默认每页 12 步。

---

## agent — 自然语言任务

用自然语言描述要完成的操作，Agent 自主读取页面并执行。

```bash
pnpm agent --url https://example.com --task "点击第一个按钮并填写表单"
pnpm agent --url https://example.com/pricing --task "选择最便宜的套餐，不要完成支付"
```

`--task` 为必填项。报告输出到 `reports/agent-<timestamp>/`。

---

## autogen — 自动生成用例

对页面截图分析，自动生成 YAML 测试场景，并可选择立即执行。

```bash
pnpm autogen --url https://example.com
pnpm autogen --url https://example.com/pricing --goal "测试订阅流程"
pnpm autogen --url https://example.com --no-run    # 只生成，不执行
```

产出保存在 `reports/autogen-<timestamp>/`，包含生成的 YAML 文件与 HTML 报告。

---

## run — 执行 YAML 场景

跑手写断言用例。仓库自带示例：`examples/smoke.yaml`。

```bash
pnpm run run examples/smoke.yaml
pnpm run run examples/smoke.yaml --device webview-ios
pnpm run run examples/smoke.yaml --headless --open-report false
```

> 注意：第一个 `run` 是 pnpm 子命令，第二个 `run` 才是 package.json 中的 script 名。

场景编写见 [docs/scenarios.md](./docs/scenarios.md)。

---

## regression — 批量回归

按 suite 文件批量执行多个 YAML 场景，生成汇总报告。

```bash
pnpm regression my-suite.yaml
pnpm regression my-suite.yaml --priority P0
pnpm regression my-suite.yaml --category normal
pnpm regression:ci my-suite.yaml --open-report false
```

suite 文件格式：

```yaml
name: my-regression-suite
description: 核心流程回归
cases:
  - path: examples/smoke.yaml
    priority: P0
    category: normal
  - path: scenarios/checkout.yaml
    priority: P1
    category: normal
    enabled: true
```

汇总报告输出到 `reports/regression-<timestamp>/`（`index.html` + `summary.json`）。

---

## aggregate — 汇总报告

将已有 regression 的 `summary.json` 重新生成汇总 HTML。

```bash
pnpm aggregate                                          # 自动找最新 regression 报告
pnpm aggregate reports/regression-xxx/summary.json      # 指定路径
```

---

## visual-review — AI 视觉审查

对测试报告中的截图做 AI 视觉分析，检查 UI/UX 问题。

```bash
pnpm visual-review                                      # 自动找最新 regression 报告
pnpm visual-review reports/regression-xxx/summary.json
pnpm visual-review reports/explore-xxx                  # 也可指定单个用例报告目录
```

需在 `.env` 中配置 `QA_LLM_API_KEY`（支持 vision 的模型）。未配置时会跳过 AI 分析。

也可在 regression 时开启：`pnpm regression my-suite.yaml --visual-review`。

---

## accounts — 查看测试账号

```bash
pnpm exec tsx src/cli.ts accounts
pnpm exec tsx src/cli.ts accounts --env dev
```

账号配置在 `config/accounts.yaml`（从 `config/accounts.example.yaml` 复制）。

---

## 常用参数

| 参数 | 说明 |
|------|------|
| `--url <url>` | 测试页面（完整 URL） |
| `--urls a,b,c` | 多个页面，逗号分隔（仅 scan） |
| `--platform h5\|web` | `h5` 手机小屏，`web` 桌面大屏 |
| `--email` / `--password` | 登录凭据（遇登录页时使用；未传时从 `.env` 的 `E2E_EMAIL` / `E2E_PASSWORD` 读取，再提示终端输入） |
| `--no-login` | 禁用自动登录 |
| `--account e2e` | 使用 `config/accounts.yaml` 中的账号 |
| `--max-actions 12` | 每页最多探索步数 |
| `--max-pages 30` | 全站模式最多测试页面数 |
| `--no-crawl` | 仅测当前 URL，不自动跳转 |
| `--device mobile\|webview-ios\|desktop` | 设备模拟（覆盖 platform） |
| `--headless` | 无头模式（CI 默认开启） |
| `--headed` | 强制显示浏览器 |
| `--slow-mo 500` | 每步操作延迟（毫秒） |
| `--open-report` | 完成后用 Chrome 打开报告 |
| `--open-report false` | 不打开报告 |
| `--visual-review` | 测试完成后 AI 分析截图 |

---

## 报告

每次运行后在 `reports/<name>-<timestamp>/` 生成：

- `index.html` — 步骤结果与探索流程详情
- `step-*.png` — 截图
- `result.json` — 机器可读结果

---

## 更多文档

- [docs/README.md](./docs/README.md) — 完整功能说明与目录结构
- [docs/scenarios.md](./docs/scenarios.md) — YAML 场景编写指南
