function trimLines(text, maxLines) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''

  const lines = raw.split('\n')
  if (lines.length <= maxLines) return raw
  return `${lines.slice(0, maxLines).join('\n')}\n... (${lines.length - maxLines} more lines)`
}

export const DEFAULT_CONTEXT_COMMANDS = [
  {
    name: 'git-status',
    command: 'git status --porcelain',
    timeoutMs: 5_000,
    maxLines: 50,
  },
  {
    name: 'git-log',
    command: 'git log -10 --oneline',
    timeoutMs: 5_000,
    maxLines: 50,
  },
]

export function truncateHandoff(text, maxChars = 6_000) {
  const raw = String(text ?? '')
  if (!raw) return ''

  const markers = ['[HANDOFF_START]', '[HANDOFF]']
  let markerStart = -1
  let markerLength = 0
  for (const marker of markers) {
    const index = raw.lastIndexOf(marker)
    if (index > markerStart) {
      markerStart = index
      markerLength = marker.length
    }
  }

  const extracted = markerStart >= 0 ? raw.slice(markerStart + markerLength) : raw
  const normalized = extracted.trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(-maxChars)
}

export function composeKiroPrompt(prompt, options = {}) {
  const repoContext = String(options.repoContext ?? '').trim()
  const linearContext = String(options.linearContext ?? '').trim()
  const handoff = String(options.handoff ?? '').trim()

  let text = String(prompt ?? '').trim()
  if (repoContext) {
    text = `${repoContext}\n\n${text}`
  }
  if (linearContext) {
    text = `${linearContext}\n\n${text}`
  }
  if (handoff) {
    text = `${text}\n\n--- HANDOFF FROM PREVIOUS PHASE ---\n${handoff}\n--- END HANDOFF ---`
  }

  return text
}

export async function collectRepoContext(config, runCommand, options = {}) {
  const commands = Array.isArray(config.context?.commands) ? config.context.commands : []
  if (commands.length === 0) return ''

  const sections = []
  for (const command of commands) {
    const result = await runCommand(command.command, {
      cwd: config.repoDir,
      env: options.env ?? process.env,
      timeoutMs: command.timeoutMs,
    })

    const output = result.code === 0
      ? result.out
      : [result.out, result.err, `[exit ${result.code}]`].filter(Boolean).join('\n')
    const body = trimLines(output, command.maxLines)
    sections.push(`--- ${command.name} ---\n${body || '[no output]'}`)
  }

  return sections.length > 0
    ? `--- REPO CONTEXT ---\n${sections.join('\n\n')}\n--- END REPO CONTEXT ---`
    : ''
}
