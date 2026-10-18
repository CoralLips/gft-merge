// Opens a link with the system's handler, the way a click would, e.g. claude://resume
// so the Claude app shows a session another program wrote.
import { spawn } from 'node:child_process';

export function openLink(url) {
  const [file, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
