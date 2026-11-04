import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const metricsSchema = z.object({ browserProcesses:z.number().int().positive(),workingSetBytes:z.number().positive(),cpuSeconds:z.number().nonnegative() });
export type BrowserMetrics = z.infer<typeof metricsSchema>;
/** Only descendants of this worker, no command lines or unrelated browser state. */
export async function browserMetrics(): Promise<BrowserMetrics | null> {
  if (process.platform !== 'win32') return null;
  const script = `$inboraRootPid=${process.pid}; $inboraProcesses=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; ` +
    '$inboraTree=[System.Collections.Generic.HashSet[int]]::new(); [void]$inboraTree.Add($inboraRootPid); ' +
    'do {$inboraChanged=$false; foreach($inboraItem in $inboraProcesses){if($inboraTree.Contains([int]$inboraItem.ParentProcessId) -and $inboraTree.Add([int]$inboraItem.ProcessId)){$inboraChanged=$true}}}while($inboraChanged); ' +
    '$inboraBrowserIds=@($inboraProcesses | Where-Object {$inboraTree.Contains([int]$_.ProcessId) -and $_.Name -eq "msedge.exe"} | ForEach-Object {[int]$_.ProcessId}); ' +
    'if($inboraBrowserIds.Count -eq 0){"null";exit}; $inboraStats=@(Get-Process -Id $inboraBrowserIds -ErrorAction SilentlyContinue); ' +
    '@{browserProcesses=$inboraStats.Count;workingSetBytes=($inboraStats | Measure-Object WorkingSet64 -Sum).Sum;cpuSeconds=($inboraStats | Measure-Object CPU -Sum).Sum} | ConvertTo-Json -Compress';
  try {
    const {stdout} = await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{timeout:10_000,windowsHide:true,maxBuffer:4096});
    const result = metricsSchema.safeParse(JSON.parse(stdout)); return result.success ? result.data : null;
  } catch { return null; }
}
