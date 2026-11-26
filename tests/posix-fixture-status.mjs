import { spawnSync } from 'node:child_process'
import { writeSync } from 'node:fs'
import { constants } from 'node:os'

const { status, signal, error } = spawnSync('sh', ['-c', process.argv[2]], { stdio: 'inherit' })
if (error) throw error
writeSync(3, `${status ?? 128 + constants.signals[signal]}\n`)
