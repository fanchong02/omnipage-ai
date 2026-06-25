# 场景编写指南

## YAML 结构

```yaml
name: my-scenario          # 场景名（用于报告目录）
env: default                   # config/environments.yaml 中的 key
viewport: mobile           # config/devices.yaml 中的 key
retries: 1                 # 可选
mocks:                     # 可选，额外 API mock
  - pattern: "**/api/foo/**"
    fixture: fixtures/foo.json
steps:
  - goto: "/path"
  - assertVisible: "按钮文案"
  - agent: "自然语言任务描述"
```

## 步骤类型

| 步骤 | 示例 | 说明 |
|------|------|------|
| `goto` | `goto: "/onboarding"` | 导航（相对 baseURL） |
| `click` | `click: "CONTINUE"` | 按可见文案点击 |
| `fill` | `fill: { selector: "Email", value: "a@b.com" }` | 填表 |
| `assertVisible` | `assertVisible: "Settings"` | 断言文案可见 |
| `assertUrl` | `assertUrl: "selling"` | URL 包含片段 |
| `assertNoOverflow` | `assertNoOverflow: "refund within 30 days"` | 文案不横向溢出 |
| `scroll` | `scroll: bottom` | 滚到顶/底 |
| `wait` | `wait: 2000` | 等待毫秒 |
| `screenshot` | `screenshot: final` | 全页截图 |
| `agent` | 多行自然语言 | AI 自主操作 |
| `explore` | `explore: true` | 自动识别并交互当前页所有可点击/可输入元素 |
| `explore` | 见下方 | 带选项的页面探索 |
| `assertVisual` | `assertVisual: true` | AI 分析当前页截图并断言视觉正常 |
| `assertVisual` | 见下方 | 自定义视觉审查提示词 |
| `visualReview` | `visualReview: true` | 场景结束后 AI 审查关键截图（写入报告，默认不失败） |
| `seedAuth` | `seedAuth: { email: "test@example.com" }` | 注入 localStorage 登录态 |
| `seedAuth` | `seedAuth: { account: e2e }` | 从 `config/accounts.yaml` 读取账号注入登录态 |
| `login` | `login: e2e` | 使用账号密码在页面登录 |
| `login` | `login: { account: admin, path: /login }` | 指定账号并跳转登录页 |
### 自动登录（全局）

任意命令在检测到未登录（跳转到 `/login` 或出现登录页）时，会**优先使用 `config/accounts.yaml` 默认账号自动登录**，登录后返回原目标页。

- 默认账号：`defaults.account`（通常为 `e2e`）
- 指定账号：`autoLogin: e2e` 或 CLI `--account e2e`
- 禁用：`autoLogin: false` 或 CLI `--no-login`

以下情况**不会**自动登录（避免破坏用例意图）：

- `seedAuth` 注入已登录态
- `auth/login` 模块专门测试登录页 UI
- `abnormal` 类用例验证未登录跳转（如访问 `/settings` 应留在 login）

## 自动登录

进入 login 页时，默认使用 `config/accounts.yaml` 中的账号密码自动登录（`defaults.account`，当前为 `e2e`）。

**默认开启**，在 `goto` / `click` / `wait` 等步骤后检测 login 页并自动填表提交。

**自动关闭**（不会登录）的情况：

- 场景设置 `autoLogin: false`
- `module: auth/login`（登录页 UI 测试）
- 含 `assertUrl: login`（验证未登录跳转）
- `category: abnormal` 且未使用 `seedAuth`（未登录异常用例）

强制指定账号：`autoLogin: e2e`

## Agent 步骤

适合 UI 频繁变更、不便写死选择器的流程：

```yaml
- agent: |
    在 selling 页确认有订阅计划，
    点击第一个 plan，滚到底部，点 GET MY PLAN（不要支付）
```

Agent 会：

1. 读取 accessibility snapshot
2. LLM（或启发式）决定下一步动作
3. 循环直到 `done` 或达到步数上限

## 页面自动探索（explore）

无需手写每个按钮/输入框，框架会扫描当前页可见的可交互元素并逐一操作：

- **按钮 / 链接 / Tab**：自动点击（安全模式下跳过支付、删除、登出等）
- **输入框**：自动填入示例值（email、密码、文本等）
- **复选框 / 单选**：自动切换
- **跳转后**：自动返回原页面继续探索（可关闭）
- **报告**：生成 `explore-report.json` 与每步截图

### 作为独立步骤

```yaml
steps:
  - goto: /login
  - explore: true
```

### 带选项

```yaml
steps:
  - goto: /onboarding
  - explore:
      maxActions: 20
      aiMode: true          # 每步截图 + AI 思考下一步（默认 true）
      fillInputs: true
      scroll: true
      safeMode: true
      navigateBack: true
      goal: "验证 onboarding 主流程"
```

### 每次 goto 后自动探索

```yaml
name: onboarding-full-explore
autoExplore:
  maxActions: 15
  safeMode: true
steps:
  - goto: /onboarding
  - goto: /onboarding/step/1
  - goto: /login
```

### CLI 单独探索某页

```bash
pnpm explore
pnpm explore --url https://example.com/login
pnpm explore --url https://example.com/about --max-actions 20
pnpm explore --url https://example.com/settings --account e2e
```

### 多页面扫描

```bash
pnpm scan
pnpm scan --url https://example.com/
pnpm scan --urls https://a.com/,https://a.com/pricing --max-actions 8
pnpm scan:ci --url https://example.com --open-report false
```

与 `pnpm regression` 的区别：regression 跑手写 YAML 断言用例；scan 不依赖预写断言，自动探索 UI 并记录截图。

## AI 视觉分析（assertVisual / visualReview）

使用视觉模型（`QA_LLM_VISION_MODEL`，默认与 `QA_LLM_MODEL` 相同）分析测试截图，输出可能存在的 UI 问题，并断言页面视觉是否正常。

需配置环境变量：

```bash
QA_LLM_API_KEY=sk-...
QA_LLM_BASE_URL=https://api.openai.com/v1   # 可选
QA_LLM_VISION_MODEL=gpt-4o-mini              # 可选，需支持 image
```

### 步骤内视觉断言

```yaml
steps:
  - goto: /login
  - fill:
      selector: Email
      value: test@example.com
  - assertVisual: 检查登录页表单是否完整、Sign In 按钮是否可用
```

`normal` 用例默认：发现 **medium/high** 视觉问题会失败；`abnormal/edge` 默认仅记录不失败。

```yaml
- assertVisual:
    prompt: 检查 selling 页价格卡片是否对齐
    strict: true   # 有任何视觉问题都失败
```

### 场景结束自动审查

```yaml
visualReview: true
steps:
  - goto: /onboarding/selling?email=...
  - assertVisible: Money-Back Guarantee
```

或对已有报告批量分析：

```bash
pnpm regression --priority P0 --visual-review
pnpm visual-review reports/regression-xxx/summary.json
pnpm visual-review reports/auth-login-abnormal-xxx
```

报告会新增 **Visual** 列与「场景 AI 视觉审查」区块，包含问题列表与严重度。

## 测试账号

账号密码保存在 `config/accounts.yaml`（已 gitignore，不会提交到仓库）。

```bash
cp config/accounts.example.yaml config/accounts.yaml
# 编辑 accounts.yaml，填写真实密码

pnpm qa accounts              # 查看可用账号
pnpm qa accounts --env dev    # 按环境筛选
```

场景中使用：

```yaml
steps:
  - login: e2e                          # 使用默认或指定账号登录
  - login: { account: admin, path: /login }
  - seedAuth: { account: e2e }         # 跳过 UI，直接注入登录态
```

## Mock

默认不注入 API mock。场景级可按需追加：

```yaml
mocks:
  - pattern: "**/api/plans/**"
    fixture: fixtures/product-plans.json
```

## WebView 模式

```bash
pnpm run examples/smoke.yaml --device webview-ios
```

会注入 WebView UA 和 mock `__RN_BRIDGE__`。

## 调试技巧

1. **可视化运行（默认）**：`pnpm explore` 会自动打开浏览器，页面右上角显示步骤进度
2. **无头模式（CI）**：`pnpm scan:ci --url https://example.com --open-report false`
3. **放慢观察**：`pnpm explore --url https://example.com --slow-mo 800`
4. **自动打开报告**：本地可视化跑完后自动启动报告服务并用 Chrome 打开（`--open-report false` 可关闭）
5. 看报告：打开 `reports/*/index.html` 或访问终端输出的 `http://127.0.0.1:9321/...`
6. 单步 Agent：`pnpm agent --url ... --task "..."`

## 示例场景

| 文件 | 说明 |
|------|------|
| `examples/smoke.yaml` | 最小示例：打开页面并断言文案 |
