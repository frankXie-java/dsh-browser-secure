# Intranet distribution of the dsh Browser extension

This guide covers building, signing, and distributing the extension inside an air-gapped or sensitive intranet (no internet access to npmjs.org, GitHub, or the Chrome Web Store). Every command below was verified on macOS with Chrome 151 and Node.js 24.

## Build inside the intranet

The workspace must resolve its dependencies without reaching the public internet. Two wirings work:

- **npm mirror**: point the registry at an internal verdaccio/nexus and install normally.

```sh
pnpm config set registry https://npm.internal.example.com/
pnpm install
pnpm --filter dsh-browser-extension run build
```

- **Offline store**: copy `node_modules` and the pnpm store from a machine that already installed; then build.

```sh
pnpm store import path/to/pnpm-store-bundle
PNPM_HOME=... pnpm install --offline
pnpm --filter dsh-browser-extension run build
```

The extension build output lands in `extensions/dsh-browser/dist/` (three targets: `content.js`, `background.js`, `panel/`, plus `_locales/` and `manifest.json`). The manifest declares no network hosts beyond the local bridge loopback; nothing in the extension phones out.

The companion dsh bridge plugin (`@yuxianglin/dsh-bridge-browser`) and the MCP Atlassian server must also come from the internal feed: publish the workspace packages (`pnpm --filter ... publish`) to the internal registry or vendor the tarballs, and reference them from the profile `cordis.patch.yml` as `file:` or internal-registry versions.

## Sign the extension (CRX)

Chrome packages a signed `.crx` with its own binary. The first run generates the private key; keep it secret and reuse it for every update so the extension ID stays stable.

```sh
cd extensions/dsh-browser
# First build: Chrome writes dist.pem (private key) next to dist.crx.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="$(pwd)/dist"

# Later builds: reuse the same key so the ID never changes.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="$(pwd)/dist" \
  --pack-extension-key="$(pwd)/dist.pem"
```

The output `dist.crx` starts with the `Cr24` magic for CRX3 format. On Linux, pass `--disable-gpu --headless=new`; on Windows the binary is `chrome.exe`. The private key `dist.pem` and the signed `dist.crx` are git-ignored by this repository — copy them out of version control into a secrets store (for the key) and an artifact store (for the crx).

**Extension ID.** Enterprise policy installs reference the stable extension ID, which is derived from the public key, not the manifest. Derive it from the key:

```sh
openssl rsa -in dist.pem -pubout -outform DER 2>/dev/null \
  | openssl sha256 -binary 2>/dev/null \
  | xxd -p -c 256 | head -c 32 \
  | python3 -c "import sys; a='abcdefghijklmnop'; h=sys.stdin.read().strip(); print(''.join(a[int(h[i:i+2],16)//16] for i in range(0,32,2)))"
```

## Distribute

Three tiers of distribution, cheapest to strictest:

1. **Unpacked for a pilot**: `chrome://extensions` → enable Developer mode → Load unpacked → select `dist/`. This is what `scripts/install.sh` does for a single machine and is fine for a first pilot; it is not silent and requires a human on each machine.
2. **CRX for manual install**: distribute `dist.crx` over an internal share. In current Chrome builds the file drag-drop install path is gated behind developer mode; for unattended rollouts use tier 3.
3. **Enterprise policy force-install (recommended)**: the browser enforces install from the internal CRX, turns off manual removal, and can pin the version. The ID computed above is the policy key.

Force-install examples — extensions prefixed `internal:` come from the internal Web Store / update server, `external:` from the specified URL:

- **macOS (managed preferences)**: write `com.google.Chrome` preference `ExtensionInstallForcelist` as an array of `"<extension-id>;https://updates.internal.example.com/update.xml"` through your MDM (Jamf/Intune) profile.
- **Windows (GPO)**: Administrative Templates → Google → Google Chrome → Extensions → "Configure the list of force-installed extensions", value `"<extension-id>;https://updates.internal.example.com/update.xml"`.
- **Linux (InitialPreferences)**: under `extensions.settings."<extension-id>".installation_mode` = `force_installed` and `update_url` = the internal update XML.

The `update_url` points at an **update manifest** hosted on the intranet:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="olmejpbbjppmjglc">
    <updatecheck codebase="https://updates.internal.example.com/dsh-browser-1.0.2.crx" version="1.0.2" />
  </app>
</gupdate>
```

Bump `version` in `extensions/dsh-browser/package.json` (and the manifest), rebuild, re-sign with the same key, and publish the new crx + manifest. Chrome polls the update URL on its own schedule and silently updates. No connection to the public Chrome Web Store is involved.

## Wire the internal LLM

The extension itself does no model calls; it talks only to the local dsh bridge (`ws://127.0.0.1:3080` by default). The model side is configured in the dsh profile, not in the extension:

- `dsh-rakuten-in-house-llm-adapter` (or another internal adapter) points `baseURL` at the internal OpenAI-compatible gateway.
- The API key lives in a git-ignored `.env` (mode 0600) next to the workspace; `cordis.patch.yml` reads it via `!!js process.env.… ?? ''` and never stores it as literal config.
- Web tools (`tool-web`, `web-search-deepseek`) are disabled in the profile patch, so the model cannot fetch public pages; only the whitelisted browser tools and MCP act on the intranet.

## Audit trail

The bridge plugin writes a JSONL audit record per tool call to `~/.dsh/audit/<date>.jsonl` (metadata only: time, session id, tool name, target host when the tool carries a URL, and whether the allowlist denied it). Export and review it alongside dsh session logs:

```sh
cat ~/.dsh/audit/$(date +%F).jsonl
```

The audit file lives on the user's machine; collect it into a central SIEM/S3 bucket on a schedule if retention policy requires it. It never contains page text, form values, snapshots, or credentials.

## Go-live checklist

- [ ] Every dependency (pnpm store, bridge plugin, MCP server) resolves from internal feeds only.
- [ ] `dist.pem` is in a secrets store and never in git; `git ls-files | grep -E '\.(pem|crx)$'` returns nothing.
- [ ] Extension ID is stable across rebuilds (same key reused).
- [ ] `update_url` manifest + CRX are reachable over HTTPS on the intranet.
- [ ] The internal LLM endpoint is the only outbound model connection; run a packet capture during a pilot session and confirm no other egress.
- [ ] Audit JSONL appears after a pilot tool call and contains no sensitive field values.
- [ ] A test workstation installs the forced extension without user interaction and survives a browser restart.