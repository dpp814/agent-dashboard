import { execFile } from 'node:child_process';

export function execFileText(command: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    await execFileText(checker, [command], 1500);
    return true;
  } catch {
    return false;
  }
}
