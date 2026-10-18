#!/usr/bin/env node
// gft-merge: open | serve | stop | status
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir, open as openFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, readJson, writeJson } from './home.mjs';
import { DEFAULT_PORT, startServer } from './server.mjs';

const [command = 'open', ...rest] = process.argv.slice(2);
const port =
  Number(rest[rest.indexOf('--port') + 1]) || Number(process.env.GFT_MERGE_PORT) || DEFAULT_PORT;
const url = `http://127.0.0.1:${port}`;
const serviceFile = path.join(homeDir(), 'service.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const portTaken = () =>
  new Error(
    `端口 ${port} 已被其他程序占用，GFT-Merge 没有启动。请换一个端口，例如：node cli.mjs open --port ${port + 10}`,
  );

/** Whether anything listens on the port, without speaking HTTP to it. */
const listening = () =>
  new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(true);
    });
  });

/** 'ours' when GFT-Merge answers on the port, 'other' when something else holds it, else 'free'. */
async function probe() {
  try {
    const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (response.ok && (await response.json().catch(() => null))?.product === 'gft-merge')
      return 'ours';
  } catch {
    // Not an HTTP answer from us; see whether the port is taken at all.
  }
  return (await listening()) ? 'other' : 'free';
}
const running = async () => (await probe()) === 'ours';

function openBrowser() {
  const [file, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

const commands = {
  async serve() {
    await startServer({ port }).catch(error => {
      throw error.code === 'EADDRINUSE' ? portTaken() : error;
    });
    await writeJson(serviceFile, { pid: process.pid, port, startedAt: new Date().toISOString() });
    console.log(`GFT-Merge: ${url}`);
  },

  async open() {
    const state = await probe();
    if (state === 'other') throw portTaken();
    if (state === 'free') {
      await mkdir(homeDir(), { recursive: true });
      const log = await openFile(path.join(homeDir(), 'service.log'), 'a');
      const script = fileURLToPath(import.meta.url);
      spawn(process.execPath, [script, 'serve', '--port', String(port)], {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      }).unref();
      await log.close();
      for (let i = 0; i < 50 && !(await running()); i++) await delay(100);
      if (!(await running()))
        throw new Error(`启动失败，请查看 ${path.join(homeDir(), 'service.log')}`);
    }
    openBrowser();
    console.log(`GFT-Merge 已打开：${url}`);
  },

  /** Stops the process this data directory started, as recorded when it began serving. */
  async stop() {
    const service = await readJson(serviceFile);
    const alive = pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    if (!service?.pid || !alive(service.pid)) {
      await rm(serviceFile, { force: true });
      return console.log('GFT-Merge 没有在运行。');
    }
    process.kill(service.pid);
    await rm(serviceFile, { force: true });
    console.log('GFT-Merge 已停止。');
  },

  async status() {
    console.log(
      JSON.stringify(
        {
          running: await running(),
          url,
          data: homeDir(),
        },
        null,
        2,
      ),
    );
  },
};

if (!commands[command]) {
  console.error(`用法：gft-merge ${Object.keys(commands).join(' | ')} [--port 端口]`);
  process.exit(1);
}
try {
  await commands[command]();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
