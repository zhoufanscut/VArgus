import type { SessionValues } from '../../core/session.ts'
import { displaySession } from '../../render/session.ts'

const BEDROCK_REGION = /^(?:apac|au|ca|eu|global|in|jp|us|us-gov)\./
const BEDROCK_VENDOR = /^(?:amazon|anthropic|deepseek|google|meta|minimax|moonshot(?:ai)?|openai|qwen|xai|zai)\./
const SPEED_SUFFIX = /-(?:ultrafast|fast|highspeed)$/i
// Venice's catalog ID for Kimi K3 Fast.
const KIMI_FAST_ALIAS = /(^|\/)kimi-k3-fast-api$/i
const KIMI_CODING = /^(?:kimi(?:-for-coding)?|(?:kimi-)?k\d+(?:[.-]\d+)*(?:-pro)?)$/

// Capture the family label and, where present, the tier that goes with it.
const MODEL_FAMILIES = [
  /^claude[- ](?:\d+(?:[-.]\d+)*-)?(fable|opus|sonnet|haiku)(?=$|[-. \[])/,
  /^(?:openai-)?gpt-(?:\d+(?:\.\d+)*-)?(astra|luna|sol|terra)(?:-(pro))?(?:-latest)?$/,
  /^(astra|luna|sol|terra)(?:[-.]\d+(?:\.\d+)*)?$/,
  /^gemini-\d+(?:\.\d+)*-(argon|carbon|hydrogen|neon)$/,
  /^(gemini)-\d+(?:\.\d+)*-(flash-lite|flash|pro)(?:-preview)?$/,
  /^(deepseek)(?:-v\d+(?:[.-]\d+)*)?(?:-(flash|pro|chat|reasoner))?(?:-\d{4,8})?$/,
  /^(qwen)(?:-?\d+(?:\.\d+)*)?(?:-(max|plus|flash|coder|turbo|vl))?$/,
  /^(glm)-\d+(?:\.\d+)*(?:-(flash|turbo))?$/,
  /^(grok)-\d+(?:\.\d+)*$/,
  /^(minimax)-m\d+(?:\.\d+)*(?:-(flash))?$/,
  /^(nova)-(?:\d+-)?(lite|micro|premier|pro)(?:-v\d+:\d+)?$/,
  /^(llama)4-(scout|maverick)(?:-17b-instruct)?(?:-v\d+:\d+)?$/,
]

const MODEL_LABEL_OVERRIDES = new Map([
  ['deepseek-flash', 'deepseek'],
])

function shortOmoModelName(model: string): string {
  // Gateways can put a path in the ID, and Bedrock qualifies slugs with dots.
  // Use the normalized slug to match aliases and the original ID as the fallback.
  const leaf = model.slice(model.lastIndexOf('/') + 1).toLowerCase()
  const id = leaf.replace(BEDROCK_REGION, '').replace(BEDROCK_VENDOR, '')
  if (KIMI_CODING.test(id)) return 'kimi'
  for (const pattern of MODEL_FAMILIES) {
    const match = pattern.exec(id)
    if (match?.[1]) return match[2] ? `${match[1]}-${match[2]}` : match[1]
  }
  return model
}

export function omoDisplay(session: SessionValues) {
  const display = displaySession(session, model => model.trim() || null)
  if (!display.modelName) return display
  const id = display.modelName.replace(KIMI_FAST_ALIAS, '$1kimi-k3-fast')
  const speed = SPEED_SUFFIX.exec(id)
  const label = shortOmoModelName(speed ? id.slice(0, speed.index) : id)
  display.modelName = MODEL_LABEL_OVERRIDES.get(label) ?? label
  if (speed) display.speed = speed[0].toLowerCase() === '-ultrafast' ? 'ultrafast' : 'fast'
  return display
}
