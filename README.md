<p align="center"><strong>English</strong> · <a href="README_ZH.md">简体中文</a></p>

# GFT-Merge

## Carry context between your AI coding sessions.

**Pull sessions from Claude Code and Codex into a pool, then start a new session in either tool with that context already in it.**

You plan something in one Claude Code session, build it in Codex, and debug it in another session. Handing over means copying and pasting by hand. GFT-Merge reads your local sessions, lets you combine the ones that matter, and starts a fresh session whose first message carries them, so the AI picks up where you left off.

It runs on your computer and opens in your browser. A sibling of [GFT-Map](https://github.com/CoralLips/gft-map).

> The interface is in Chinese for now.

## Get started

You'll need **Node.js 22+** and at least one of:

- **Claude Code** in the **Claude desktop app**, signed in. New Claude sessions are brought into the app through its own `claude://` link, so the app is required to see them.
- **Codex**, the Codex app or CLI, signed in. With the Codex app, new sessions also open there.

Then run:

```sh
npx gft-merge
```

Your browser opens `http://127.0.0.1:4319`. Run it again any time; it reuses the running service.

## How it works

The page has two halves. At the top, one column per tool lists your sessions from the last 30 days. Below, your pools on the left and the selected pool's workspace on the right. Everything is done by dragging.

| What you want                     | How                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Put a session in a pool           | Drag it from a tool's column into the workspace. It becomes a ball.                             |
| Combine sessions                  | Drop one ball on another. Any two balls can be fused.                                           |
| Start a session with that context | Drag a ball up onto a tool's column. A new session starts there, named "merge · pool name".     |
| Make a big ball smaller           | Click the ball to compress it with a model (see below).                                         |
| See what a ball holds             | Hover the name under it. Drag a session out of that list to split it off.                       |
| Move or remove                    | Drop a ball on another pool in the list to move it; drop it outside the workspace to remove it. |

**The number in a ball** is its size in tokens. A single session shows that session's own context size, read from the tool's records. A fused or compressed ball shows what dragging it up would send, counted locally (marked ≈).

**Compression** sends the ball's content to the tool and model chosen under **Settings → 处理工具** (processing tool) and replaces it with the result. While it runs, the ball's ring turns and its name reads "压缩中…" (compressing). A compressed ball can't be split again; you can fuse more sessions onto it or compress it again. Drag it up before compression finishes and the original text is sent.

**The new session's first message** contains the plain conversation of every session in the ball (your messages and the final answer of each turn, without tool output) and asks the AI to report briefly what it understood (what the sessions are about, where things stand, what is decided and open, what comes next), then wait for you. That reply is a real turn, so the session sits at the top of the tool's list. With Codex the page returns at once and the session opens when the reply ends; with Claude the page waits for the reply (several seconds to about a minute), then the session opens in the Claude app.

**Why only new sessions:** Codex refuses other programs writing to a session that is open in the Codex app, and the Claude app shows its own copy of a session, not what another program writes into it. Neither is reliable, so GFT-Merge always starts a new session.

## Where does your data go?

- GFT-Merge reads your local Claude Code and Codex session files. It does not change them, and it does not install hooks or change either tool's settings.
- Pools are stored in `~/.gft-merge/` on your computer (set `GFT_MERGE_HOME` to move them).
- A model is called only in two cases, both started by you: dragging a ball up (the new session runs in that tool, on your account) and compressing (one request to the processing tool, on your account).
- No GFT account, no cloud.

## Commands

```sh
npx gft-merge          # open the page, starting the service if needed
npx gft-merge stop     # stop the service
npx gft-merge status   # show whether it runs, and where the data is
```

Add `--port <number>` to use another port.

## Project status and feedback

Version 0.1, an early release. Tested on Windows; on macOS and Linux, opening sessions in the desktop apps is not verified yet. Supports Claude Code and Codex.

Share problems or ideas in [Issues](https://github.com/CoralLips/gft-merge/issues).

## Development

```sh
git clone https://github.com/CoralLips/gft-merge.git
cd gft-merge
npm install
npm test
node cli.mjs open
```

## License

MIT
