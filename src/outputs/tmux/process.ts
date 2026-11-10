import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'

const exec = promisify(execFile)
export type ApplicationProcess = { pid: number; parent: number; command: string }

async function windowsQuery(script: string): Promise<string> {
  return (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
}

export function applicationName(command: string): string {
  return process.platform === 'win32' ? basename(command).replace(/\.exe$/i, '').toLowerCase() : command
}

export async function applicationProcesses(): Promise<ApplicationProcess[]> {
  if (process.platform === 'win32') {
    const raw = await windowsQuery('ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)')
    return (JSON.parse(raw) as { ProcessId: number; ParentProcessId: number; Name: string }[])
      .map(p => ({ pid: p.ProcessId, parent: p.ParentProcessId, command: applicationName(p.Name) }))
  }
  return (await exec('ps', ['-ww', '-axo', 'pid=,ppid=,comm='], { timeout: 5000 })).stdout.split('\n').flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), command: basename(m[3]!) }] : []
  })
}

export async function applicationArguments(pid: number): Promise<string> {
  if (process.platform !== 'win32') return (await exec('ps', ['-ww', '-p', String(pid), '-o', 'args='])).stdout
  const raw = await windowsQuery(`Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object -ExpandProperty CommandLine`)
  // CreateProcess quotes JSON arguments with backslash-escaped double quotes.
  return raw.replaceAll('\\"', '"')
}

export const tmuxFields = (format: string) => process.platform === 'win32' ? format.replaceAll('\t', '|') : format
export const splitTmuxFields = (line: string) => line.split(process.platform === 'win32' ? '|' : '\t')
