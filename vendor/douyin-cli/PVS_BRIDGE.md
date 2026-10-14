# PVS Douyin Read-Only Bridge

`pvs_bridge.js` is the stable machine interface used by Product Video Studio.

## Contract

Every invocation writes exactly one structured line to stdout:

```text
PVS_DOUYIN_JSON:{...}
```

Top-level fields:

- `contractVersion`: current value is `1`
- `readonly`: always `true` in P0
- `operation`
- `ok`
- `status`
- `checkedAt`
- `data` on success
- `error` on failure

## Allowed P0 operations

```text
probe
identity
my
search
video
comments
replies
download
```

Examples:

```powershell
node pvs_bridge.js probe
node pvs_bridge.js identity
node pvs_bridge.js my --count 20
node pvs_bridge.js search --query "蓝牙耳机" --count 10 --offset 0
node pvs_bridge.js video --aweme-id 7685693367372964337
node pvs_bridge.js comments --aweme-id 7685693367372964337 --cursor 0 --count 20
node pvs_bridge.js replies --aweme-id 7685693367372964337 --cid 7685721030292718373 --cursor 0 --count 20
node pvs_bridge.js download --aweme-id 7685693367372964337
```

`download` is metadata-only in P0. It returns normalized work metadata plus media URLs; it does not write media files.

## Explicitly disabled write operations

The P0 bridge rejects write-capable commands before touching the browser runtime, including:

```text
post
like
suggest
getReply
draft
campaign
dm
delete-comment
upload-image
browse
note
```

Write operations return:

```text
WRITE_OPERATION_DISABLED
```

## Runtime requirements

- Bridge Server is running on the configured localhost port (normally 19422).
- **Product Video Studio Windows (recommended):** the scoped local PVS 3090 launch loads the reviewed CDP client and Bridge Server supervisor. The CDP client attaches only to the existing, dedicated Chromium Profile on port 9223, not to the user's other Chrome/Edge windows, and exposes read-only health at 19423. The user explicitly requests browser launch/recovery from PVS. **Tampermonkey is not required** in this PVS mode. See `Product-Video-Studio/docs/PVS-DOUYIN-CDP-BRIDGE-RECOVERY-2026-10-09.md` in the sibling project.
- **Legacy manual CLI mode (rollback only):** Tampermonkey must have userscript permissions. `scripts/douyin.user.js` is a tokenless source template; run `node scripts/prepare-pvs-userscript.mjs` to generate the local private `../douyin-bridge.user.js` with the `config.json` Bridge token. Only install this generated file after inspecting its source. The generator never logs the token.
- On this dedicated Chromium, Tampermonkey 5.5.1 has repeatedly marked the legacy local script as “unknown source” after browser restart. Do not silently override the warning, treat the temporary save as long-term recovery, or claim `READY` solely because a tab exists.
- The primary `www.douyin.com` page must be a genuine, user-authorized browser page; hidden Douyin iframes must never be treated as the primary Bridge connection.

## Important statuses

- `READY`
- `BRIDGE_OFFLINE`
- `BRIDGE_AUTH_FAILED`
- `SITE_OFFLINE`
- `CLIENT_SCRIPT_OUTDATED`
- `AUTH_REQUIRED`
- `RISK_CONTROL`
- `NOT_FOUND`
- `INVALID_ARGUMENT`
- `UNSUPPORTED_COMMAND`
- `WRITE_OPERATION_DISABLED`
- `PROVIDER_ERROR`

## Data ownership

The bridge is only a runtime adapter. Product Video Studio must persist its own formal business records and history. The local douyin-cli SQLite database is not the PVS source of truth.
