# 贡献指南

## 改之前先跑门禁

```sh
node scripts/check-ready.mjs      # 7 项门禁 + 安装就绪检查
```

插件本体零依赖，但**跑门禁**要用宿主侧的东西：`lib/index.js` 与 `scripts/test-json-gate.mjs` 要
`@deepseek-ai/dsh-tools` / `dsh-util-values`（DSH 自己提供的包），`scripts/verify-client-render.mjs`
要 `react`（走 `require('react')` 渲染客户端代码）。在 DSH 装好的机器上本来就能解析到；
干净环境临时装一份宿主本体就够，**不要**写进 `package.json`：

```sh
npm install --no-save --no-package-lock --legacy-peer-deps react @deepseek-ai/dsh
```

## 提交前

- 门禁全绿（`READY: all gates pass`）。
- 改界面的话，README 里的图是**实拍**，请一并更新（`scripts/shot.mjs`，见 README「开发」一节）。
- 提 PR 时说明改了什么、怎么验证的；如果只是文案或文档，说明这一点就够了。

## 约定

- 插件本体（`lib/`）保持**零第三方依赖**：只用 Node 内置模块和宿主提供的服务。
- 颜色只用 DSH 主题令牌 `color-mix` 派生，不写字面色、不硬编码 `#fff`（`audit-css.mjs` 会拦）。
- 数据写入是原子的（`.tmp` + rename），别改成直接覆盖。
- 中文是你的语言就用中文提 issue / PR，没问题。
