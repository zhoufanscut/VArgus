// `45m` under an hour, `3h12m` under a day, `2d5h` beyond; minutes floored
// (VantageHUD's formatDuration, shared there with the limit countdowns).
export function formatDuration(totalMinutes: number): string {
  const minutes = Math.max(0, Math.floor(totalMinutes))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d${hours % 24}h`
  if (hours > 0) return `${hours}h${minutes % 60}m`
  return `${minutes}m`
}
