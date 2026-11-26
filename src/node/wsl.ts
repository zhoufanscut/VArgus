import { release } from 'node:os'

// Real WSL always runs on Linux and identifies itself via WSL_DISTRO_NAME,
// WSL_INTEROP, or a Microsoft kernel release. Native Windows processes launched
// from Windows Terminal inherit WSLENV (such as `WT_SESSION:WT_PROFILE_ID:`) to
// forward variables into future wsl.exe calls, so WSLENV alone must not select
// the WSL text fallback (DESIGN, "Visual grammar").
export function detectWsl(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  kernelRelease: string = release(),
): boolean {
  if (platform !== 'linux') return false
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(kernelRelease))
}
