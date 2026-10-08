import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';

async function dpapi(input, decrypt = false) {
  const script = decrypt
    ? 'Add-Type -AssemblyName System.Security; $ErrorActionPreference="Stop"; $transport=[Console]::In.ReadToEnd().Trim(); $s=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($transport)).Trim(); $p=[Convert]::FromBase64String($s); $b=[System.Security.Cryptography.ProtectedData]::Unprotect($p,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($b)'
    : 'Add-Type -AssemblyName System.Security; $ErrorActionPreference="Stop"; $s=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($s); $p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($p)';
  const stdin = Buffer.from(input, 'utf8').toString('base64');
  return await new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Windows DPAPI protection failed (exit ${code}).`));
      const encoded = stdout.trim();
      resolve(decrypt ? Buffer.from(encoded, 'base64').toString('utf8') : encoded);
    });
    child.stdin.end(stdin, 'ascii');
  });
}

export class LocalVault {
  constructor() {
    this.directory = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'AI-Developer-Bridge')
      : path.join(os.homedir(), '.ai-developer-bridge');
    this.codexDirectory = path.join(this.directory, 'codex-home');
  }

  file(name) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name) || name === '.' || name === '..') {
      throw new Error('Invalid local vault file name.');
    }
    const target = path.resolve(this.directory, name);
    if (!target.startsWith(`${path.resolve(this.directory)}${path.sep}`)) throw new Error('Vault path must remain inside the local data folder.');
    return target;
  }

  async init() {
    if (process.platform !== 'win32') throw new Error('Secure local storage requires Windows DPAPI. No local data was read or written.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.codexDirectory, { recursive: true, mode: 0o700 });
  }

  async read(name, fallback = null) {
    await this.init();
    let content;
    try { content = await readFile(this.file(name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
    try {
      if (process.platform === 'win32') content = await dpapi(content, true);
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Could not decrypt local ${name}; it may have been created by another Windows account. ${error.message}`);
    }
  }

  async write(name, value) {
    await this.init();
    const plain = JSON.stringify(value, null, 2);
    const encoded = process.platform === 'win32' ? await dpapi(plain, false) : plain;
    const target = this.file(name);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  async remove(name) {
    try { await unlink(this.file(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
