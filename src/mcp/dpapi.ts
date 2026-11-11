import { spawn } from 'node:child_process';
import { Blocked, requireSafe } from '../core/contracts.js';

/** The assistant connection uses separate entropy from the saved model credential. */
export function assistantDpapi(input: Buffer, operation: 'Protect' | 'Unprotect'): Promise<Buffer> {
  requireSafe(process.platform === 'win32', 'DPAPI_WINDOWS_REQUIRED');
  const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;
$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());
try{$entropy=[Text.Encoding]::UTF8.GetBytes('inbora:local-assistant:v1');
$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);
[Console]::Out.Write([Convert]::ToBase64String($result));[Array]::Clear($result,0,$result.Length)}
finally{[Array]::Clear($bytes,0,$bytes.Length)}`;
  return new Promise((resolve, reject) => {
    // Never place connection credentials in argv, environment, script files, or logs.
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Blocked('ASSISTANT_CREDENTIAL_UNAVAILABLE'));
    };
    const timer = setTimeout(fail, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('ascii');
      if (output.length > 32_000) fail();
    });
    child.stderr.resume();
    child.on('error', fail);
    child.on('close', code => {
      if (settled) return;
      if (code !== 0 || !output || !/^[A-Za-z0-9+/=]+$/u.test(output)) return fail();
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.from(output, 'base64'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input.toString('base64'));
  });
}
