# open-design-mcp-bridge

Expose a local [OpenDesign](https://github.com/nexu-io/open-design) install to
DeepSeek Harness as an MCP server, on Windows.

OpenDesign ships its own MCP wiring (`od mcp install <agent>`), but that command
knows 17 agents and **`dsh` is not one of them** — DeepSeek Harness is supported
through a different path (`od agent setup deepseek-harness`), where OpenDesign
drives DSH instead of the other way round. This bridge is the missing direction:
DSH commissions OpenDesign runs.

## What you get

22 MCP tools, served at `open-design` namespace:

| Group | Tools |
|---|---|
| Projects / files | `list_projects` `create_project` `get_project` `delete_project` `get_file` `write_file` `search_files` `list_files` `delete_file` `create_artifact` `get_artifact` `get_active_context` |
| Generation | `start_run` `get_run` `cancel_run` |
| Brief | `collect_brief` `confirm_brief` |
| Catalogs | `list_skills` `list_plugins` `list_agents` |
| Cloud auth | `start_vela_login` `get_vela_login_status` |

The generation tools are the point: `start_run` makes OpenDesign spawn **its own**
agent (codex / claude / opencode — whatever it detects) to write a deck,
prototype, image, or HyperFrames video into an OpenDesign project. DSH polls
`get_run` until the run is terminal. Nothing renders inside DSH's process.

Verified on this machine: from a cold `start_run` with `skill: html-ppt` and
`agent: codex`, a 5-slide 1920×1080 HTML deck appeared in the project in ~13 min.

## Why a wrapper instead of pointing DSH at the executable

1. **Electron-as-Node.** The packaged app is an Electron binary. Without
   `ELECTRON_RUN_AS_NODE=1` it opens a second GUI window instead of speaking
   MCP over stdio. `mcp-bridge.mjs` sets it.
2. **`OD_RESOURCE_ROOT` is load-bearing.** Left unset, the daemon resolves its
   skills/design-template roots to a project-relative path that ships empty and
   `list_skills` returns `[]`. Pinned to the install tree it returns **169 skills
   and 126 design templates**. Both states were probed on this machine; this is
   not a guess.
3. **`OD_DATA_DIR` must match the GUI's.** Otherwise MCP sees an empty project
   list while the app shows your work.
4. **Paths move between releases.** The CLI entry lives inside the versioned
   install tree; the bridge resolves it and fails with a usable message instead
   of silently spawning nothing.

## Layout

| File | Role |
|---|---|
| `mcp-bridge.mjs` | MCP stdio entrypoint. Checks `/api/health`, starts the daemon if down, then execs the OpenDesign CLI in `mcp` mode. |
| `start-daemon.mjs` | Starts the OD daemon on a fixed port, detached. Idempotent. |

## DSH configuration

Added to `~/.dsh/profiles/desktop/cordis.patch.yml` under the existing
`dsh-mcp-lazy` row (lazy keeps the 22 tool schemas out of every request):

```yaml
      - serverName: open-design
        transport: stdio
        command: 'C:\Users\ankle crusher\scoop\apps\nodejs-lts\current\node.exe'
        args:
          - 'E:\GitHubWorkspace\own\opensource\open-design-mcp-bridge\mcp-bridge.mjs'
        env:
          OD_INSTALL_ROOT: 'D:\OpenDesign'
          OD_DAEMON_URL: 'http://127.0.0.1:7456'
        toolCallTimeoutMs: 600000
        lifecycle: lazy
```

`command` is an absolute node path on purpose: the desktop app's own PATH does
not include scoop's `nodejs-lts` directory, so a bare `node` fails to spawn.

`toolCallTimeoutMs` is 10 minutes because `start_run` returns immediately but a
deck run takes minutes; `get_run` itself is cheap.

## Manual use

```bash
# start the daemon (idempotent)
node start-daemon.mjs --port 7456

# check it
curl -s http://127.0.0.1:7456/api/health

# stop it
taskkill /F /PID $(netstat -ano | grep ':7456.*LISTENING' | awk '{print $NF}')
```

`OD_INSTALL_ROOT` overrides the install location (default `D:\OpenDesign`).
`OD_DAEMON_URL` overrides the daemon URL. `OD_SKIP_DAEMON_AUTOSTART=1` disables
the autostart in the bridge.

## Traps found while building this

- **`od` is not on PATH.** The Windows installer writes only the uninstall key,
  an `App Paths` entry, and the invite protocol — no `EnVar`/PATH write. And on
  this machine `which od` resolves to GNU coreutils' `od.exe` from scoop git.
  Never rely on the bare name.
- **OpenDesign's own `OD_MCP_BOOTSTRAP_COMMAND` hook cannot be used from DSH.**
  It shells out to `powershell.exe`. DSH spawns children under a restricted
  token, which forces PowerShell into ConstrainedLanguage, where the generic
  `[System.Collections.Generic.List[object]]::new()` the OD shutdown script uses
  is rejected → the startup aborts. Verified: the identical script reports
  `FullLanguage` and succeeds under a normal user token (Task Scheduler) and
  `ConstrainedLanguage` under DSH. Hence `start-daemon.mjs` runs the daemon
  directly instead of going through that hook.
- **PPTX export needs the GUI, not just the daemon.** `/api/version` reports
  `capabilities.slideRenderer`, which is true only when the Electron main process
  injected the render bridge. A CLI-started daemon reports `false`, and
  `od export --format pptx` is gated on it. Headless/container builds lost that
  path deliberately (CHANGELOG v0.21.0). For PPTX, launch the desktop app.
- **OpenDesign skills are mostly catalogue stubs.** 169 skill directories exist,
  but roughly 90 are under 3 KB and their bodies just point at an upstream repo
  (`anthropics/skills`, `MiniMax-AI/skills`, `nexu-io/html-anything`). The real
  content is in `design-templates/` — that is where the 57 deck templates and the
  HyperFrames video templates live.
- **Video is HyperFrames + bundled ffmpeg**, rendered by the daemon in an
  unsandboxed child (`resources/app/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe`
  ships with the installer; nothing needs installing separately). Official Windows
  docs do not cover video rendering, so treat it as unverified until a run is done.
