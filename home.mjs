// Where GFT-Merge keeps its files, and small helpers to read and write them safely.
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const homeDir = () =>
  path.resolve(process.env.GFT_MERGE_HOME || path.join(os.homedir(), '.gft-merge'));

/** Text placed at the start of everything GFT-Merge writes into a session. */
export const MARKER = '〔GFT-Merge〕';
/**
 * Closes the first message of a session a ball starts: the AI reports what it
 * understood, so the person can check it before going on, and waits for them.
 */
export const BRIEF =
  '\n\n读完以上内容后，先简要汇报你的理解（几句话即可）：这些会话在做什么、进展到哪一步、已经定下的结论、还没定的问题，以及你认为接下来该做什么。先不要执行任何操作，等我的指示。';
/** What a processing tool is asked when a ball is compressed; the ball's content follows. */
export const COMPRESS =
  '把下面几段会话记录压缩成一份，供另一个 AI 接着工作：保留结论、决定、没定的问题和关键事实，去掉重复和过程，保持原文语言，标明各条来自哪个会话。只输出压缩结果。\n\n';

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Writes through a temporary file. Windows briefly refuses renames while a reader holds the file. */
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(temporary, file);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
      await delay(Math.min(25 * 2 ** attempt, 250));
    }
  }
}

export async function appendLines(file, values) {
  if (!values.length) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, values.map(value => JSON.stringify(value)).join('\n') + '\n');
}

export async function readLines(file) {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
