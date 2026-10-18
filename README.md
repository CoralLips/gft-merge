<p align="center"><strong>English</strong> · <a href="README_ZH.md">简体中文</a></p>

# GFT-Merge

Pull sessions from different AI coding tools into a **pool**, then start a new session in any of them from that pool. Runs locally; your data stays on your machine.

Works with **Claude Code** and **Codex** today.

## Get started

You need Node.js 22 or newer, and Claude Code and/or Codex installed and signed in.

```bash
npx gft-merge
```

Your browser opens `http://127.0.0.1:4319`. You can also install it globally and run `gft-merge`.

## How it works

- **Top**: one bucket per tool, listing the last 30 days of sessions. The Claude list matches the Claude app: archived and deleted sessions are left out and names follow the app; sessions started in a terminal are marked "CLI".
- **Bottom**: your pools on the left, the selected pool's workspace on the right.
- **Drag down to add**: a session dropped into the workspace becomes a ball; dropped on a ball, it fuses into it.
- **Drop a ball on a ball to fuse**: any two balls can be fused.
- **Drag up to start a session**: drop a ball on a tool's bucket to start a new session there whose first message is the ball's content.
- **Click a ball to compress**: one model call, using the tool and model chosen as the processor in settings. While it runs the ball's dashed ring turns and its name reads "压缩中…". The result is one piece that can't be split again; you can fuse more sessions onto it or compress it again. Drag it up before compression finishes and the original text is sent.
- **The number in a ball**: a single session shows that session's own context size, read from the tool's records; a fused or compressed ball shows how many tokens dragging it up would send, counted locally (≈).
- **Names and contents**: the label under a ball lists its sessions, each prefixed with its tool. Hover the label to see the contents; drag a session out of that list to split it off.
- **Move and remove**: drop a ball on another pool in the list to move it; drop it outside the workspace to remove it.

## What happens when you drag up

GFT-Merge starts a session in that tool (named "merge · pool name"), sends the content as its first message, and asks the AI to report briefly what it understood (what the sessions are about, where things stand, what is decided and open, what comes next) and then wait for you. That is a real turn, so the new session sits at the top of the tool's list. No hooks are installed, no tool settings are changed, and nothing runs inside the tools' own processing.

- **Codex**: returns as soon as the message is sent; once the reply ends, the session opens in the Codex app through its own `codex://` link.
- **Claude Code**: waits for Claude's reply (from several seconds to a minute or so, depending on length), then imports and opens the session in the Claude app through its own `claude://resume` link.
- The new session opens in the project most of its sources came from.

Why not send into an existing session: Codex refuses other programs writing to a session that is open in the Codex app, and the Claude app shows its own cached copy, not what another program writes into a session file. Neither path is reliable, so only new sessions are supported.

Notes:

- What is sent is the plain conversation: your messages and the final answer of each turn, without intermediate steps or tool logs. A model is called only when you compress, and that uses your quota.
- Uncompressed content is sent in full; a long pool can fill the new session's context, so compress it first.
- Tested on Windows so far; opening the desktop apps' links on macOS and Linux is not verified.

## Commands

`open` (default) · `serve` · `stop` · `status`, with an optional `--port`.

## Data

Stored in `~/.gft-merge/` (set `GFT_MERGE_HOME` to change):

- `pools/<id>.json`: the pool's name, its balls, and each ball's sessions and compacts.
- `pools/<id>.jsonl`: the pool's messages, one per line. When sessions are compressed their messages are removed and only the compact remains; the original sessions in each tool are untouched.
- `settings.json`: which tools are enabled, and the processor's tool and model.

Everything GFT-Merge sends starts with `〔GFT-Merge〕`; merging skips such messages, so content does not snowball back and forth.

## Development

```bash
npm install
npm test
node cli.mjs open
```

## License

MIT
