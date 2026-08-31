# dsh 浏览器扩展的内网分发

本文档覆盖在隔离/敏感内网（不可访问 npmjs.org、GitHub 与 Chrome 网上应用店）中构建、签名与分发扩展的实操。文中命令均已在 macOS + Chrome 151 + Node.js 24 上逐条实测。

## 在内网构建

工作区必须在不触公网的情况下解析依赖，两种接法：

- **npm 镜像**：registry 指向内网 verdaccio/nexus 后正常安装。

```sh
pnpm config set registry https://npm.internal.example.com/
pnpm install
pnpm --filter dsh-browser-extension run build
```

- **离线仓库**：把已装好的 `node_modules` 与 pnpm store 拷贝到内网机器，再离线安装。

```sh
pnpm store import path/to/pnpm-store-bundle
PNPM_HOME=... pnpm install --offline
pnpm --filter dsh-browser-extension run build
```

扩展构建产物在 `extensions/dsh-browser/dist/`（三个目标：`content.js`、`background.js`、`panel/`，外加 `_locales/` 与 `manifest.json`）。manifest 除本地 bridge 回环外不声明任何网络主机，扩展自身不出网。

配套的 dsh bridge 插件（`@yuxianglin/dsh-bridge-browser`）与 MCP Atlassian server 也必须来自内网源：把 workspace 包发布到内网 registry（`pnpm --filter ... publish`）或以 tarball 形式 vendor，并在 profile 的 `cordis.patch.yml` 里用 `file:` 或内网 registry 版本引用。

## 签名（CRX）

Chrome 用自己的二进制打包生成签名 `.crx`。首次运行生成私钥；私钥必须保密，且**每次更新复用同一把 key**，扩展 ID 才会保持不变。

```sh
cd extensions/dsh-browser
# 首次打包：Chrome 在 dist.crx 旁生成 dist.pem（私钥）。
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="$(pwd)/dist"

# 后续打包：复用同一把 key，保证 ID 稳定。
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="$(pwd)/dist" \
  --pack-extension-key="$(pwd)/dist.pem"
```

产物 `dist.crx` 以 `Cr24` 魔数开头，为 CRX3 格式。Linux 上追加 `--disable-gpu --headless=new`；Windows 上用 `chrome.exe`。私钥 `dist.pem` 与签名产物 `dist.crx` 已被本仓库 gitignore——请把私钥移入密钥库、crx 移入制品库，都不要进版本控制。

**扩展 ID。** 企业策略按稳定的扩展 ID 安装，而 ID 由公钥推导（不是 manifest）。从 key 推导：

```sh
openssl rsa -in dist.pem -pubout -outform DER 2>/dev/null \
  | openssl sha256 -binary 2>/dev/null \
  | xxd -p -c 256 | head -c 32 \
  | python3 -c "import sys; a='abcdefghijklmnop'; h=sys.stdin.read().strip(); print(''.join(a[int(h[i:i+2],16)//16] for i in range(0,32,2)))"
```

## 分发

三级分发，从最省事到最严格：

1. **Unpacked 试运行**：`chrome://extensions` → 开启开发者模式 → Load unpacked → 选择 `dist/`。这是 `scripts/install.sh` 的单机做法，适合首批试点；非静默，每台机器需人工操作。
2. **CRX 手动安装**：把 `dist.crx` 放内网共享。当前 Chrome 版本中拖拽安装路径受开发者模式限制；无人值守 rollout 请用第 3 级。
3. **企业策略强制安装（推荐）**：浏览器从内网 CRX 强制安装、禁止手动卸载、可锁版本。上面算出的 ID 就是策略键。

强制安装示例——`internal:` 前缀表示来自内网 Web Store/更新服务器，`external:` 表示来自指定 URL：

- **macOS（受管偏好设置）**：通过 MDM（Jamf/Intune）profile 写入 `com.google.Chrome` 偏好 `ExtensionInstallForcelist`，值为 `"<扩展ID>;https://updates.internal.example.com/update.xml"` 数组。
- **Windows（GPO）**：管理模板 → Google → Google Chrome → 扩展程序 → "配置强制安装的扩展程序列表"，值 `"<扩展ID>;https://updates.internal.example.com/update.xml"`。
- **Linux（InitialPreferences）**：`extensions.settings."<扩展ID>".installation_mode` = `force_installed`，`update_url` = 内网更新 XML。

`update_url` 指向内网托管的**更新清单**：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="olmejpbbjppmjglc">
    <updatecheck codebase="https://updates.internal.example.com/dsh-browser-1.0.2.crx" version="1.0.2" />
  </app>
</gupdate>
```

升级时递增 `extensions/dsh-browser/package.json`（及 manifest）中的 `version`，重新构建、用同一把 key 签名，发布新 crx 与清单。Chrome 按自己的节奏轮询更新 URL 并静默升级，全程不触公网 Chrome 网上应用店。

## 接内网模型

扩展自身不做任何模型调用——它只与本机 dsh bridge（默认 `ws://127.0.0.1:3080`）通信。模型侧在 dsh profile 里配置，与扩展无关：

- `dsh-rakuten-in-house-llm-adapter`（或其它内网 adapter）把 `baseURL` 指向内网 OpenAI 兼容网关。
- API key 放在 workspace 旁的 gitignored `.env`（权限 0600），`cordis.patch.yml` 用 `!!js process.env.… ?? ''` 读取、绝不落字面量。
- `tool-web`、`web-search-deepseek` 在 profile patch 中 `disabled: true`，模型无法抓取公网页面；只有白名单内的浏览器工具与 MCP 作用于内网。

## 审计追踪

bridge 插件对每次工具调用写一行 JSONL 到 `~/.dsh/audit/<date>.jsonl`（仅元数据：时间、会话 id、工具名、URL 工具的目标主机、是否被白名单拒绝）。与 dsh session 日志配套导出回查：

```sh
cat ~/.dsh/audit/$(date +%F).jsonl
```

审计文件留在用户机器上；如需保留策略要求，可定时采集到中心 SIEM/S3。它绝不包含页面正文、表单值、快照或凭证。

## 上线核对清单

- [ ] 所有依赖（pnpm store、bridge 插件、MCP server）只从内网源解析。
- [ ] `dist.pem` 在密钥库、不在 git；`git ls-files | grep -E '\.(pem|crx)$'` 无输出。
- [ ] 扩展 ID 跨重建稳定（同一把 key）。
- [ ] `update_url` 清单与 CRX 在内网 HTTPS 可达。
- [ ] 内网模型端点是唯一出站模型连接；试点时抓包确认无其它出口。
- [ ] 试点工具调用后出现审计 JSONL，且不含敏感字段值。
- [ ] 测试机无需人工操作即装上强制扩展，重启浏览器后仍生效。