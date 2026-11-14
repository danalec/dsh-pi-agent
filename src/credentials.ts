/**
 * Credentials for the Pi child.
 *
 * The Pi child is a separate process: it does not inherit the DSH host's
 * credential store, only the host's environment. A provider whose key is
 * missing has no usable models — Pi lists a provider's models only when
 * the provider can authenticate, and `set_model` answers "Model not found"
 * for a model it cannot see.
 *
 * The DSH host holds the keys in its credential store (`~/.dsh/.credentials.yaml`,
 * one entry per environment-variable name). This module resolves the ones
 * the Pi child can use and hands them to the child as environment
 * variables, which is Pi's own documented mechanism for an API key.
 *
 * Two sources of names, both name-based — no secret is ever guessed:
 *
 * - the environment variables Pi's own providers read (its catalog), and
 * - the environment variables Pi's model configuration interpolates
 *   (`"$NAME"` in `~/.pi/agent/models.json`), which is how a gateway of
 *   the DSH profile reaches the child.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * The environment variables Pi's own providers read.
 *
 * Pi's provider registry names its key variables after the service. The
 * names are stable: they are the ones the provider documentation lists.
 */
export const PI_PROVIDER_ENV_NAMES: readonly string[] = [
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANT_LING_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'BASETEN_API_KEY',
  'CEREBRAS_API_KEY',
  'CLOUDFLARE_API_KEY',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'KIMI_API_KEY',
  'META_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'NVIDIA_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OPENROUTER_API_KEY',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'RADIUS_API_KEY',
  'TOGETHER_API_KEY',
  'TYPESAFE_API_KEY',
  'XAI_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'ZAI_API_KEY',
  'ZAI_CODING_CN_API_KEY',
]

/**
 * The environment variables Pi's model configuration interpolates.
 *
 * A provider declared in `~/.pi/agent/models.json` names its key as
 * `"$NAME"`; the child reads the value from its environment.
 *
 * @param modelsFile - the model configuration file.
 * @returns the variable names the file references.
 */
export function readPiModelConfigEnvNames(modelsFile: string): string[] {
  let text: string
  try {
    text = readFileSync(modelsFile, 'utf8')
  } catch {
    return []
  }
  const names = new Set<string>()
  // `"$NAME"` and `"${NAME}"` are the two interpolation forms; `$$` and `$!`
  // are the escapes for a literal `$` and `!`.
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1] ?? match[2]
    if (name !== undefined) names.add(name)
  }
  return [...names]
}

/**
 * The environment variables the Pi child may need.
 *
 * @param modelsFile - the Pi model configuration file.
 * @returns the variable names.
 */
export function piCredentialEnvNames(modelsFile: string): string[] {
  return [...new Set([...PI_PROVIDER_ENV_NAMES, ...readPiModelConfigEnvNames(modelsFile)])]
}

/**
 * Resolve the credentials the Pi child can use.
 *
 * The credential store is authoritative: a key it does not hold stays
 * unresolved, even when the host's environment carries one — the host's
 * environment is the child's fallback, not the source of truth.
 *
 * @param ctx - the host context, providing the credential service.
 * @param modelsFile - the Pi model configuration file.
 * @param trace - diagnostics sink.
 * @returns the environment variables the child receives.
 */
export async function resolvePiCredentialEnv(
  ctx: Context,
  modelsFile: string,
  trace?: (line: string) => void,
): Promise<Record<string, string>> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    trace?.('the host has no credential service: the Pi child runs without provider keys')
    return {}
  }
  const env: Record<string, string> = {}
  for (const name of piCredentialEnvNames(modelsFile)) {
    try {
      const hit = await credentials.resolve(name as never)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') {
        env[name] = hit.value
      }
    } catch {
      // A credential that cannot be read stays absent: the child reports
      // the provider as unauthenticated, which is the truth.
    }
  }
  return env
}

/**
 * The Pi model configuration file of this machine.
 *
 * @returns the file path.
 */
export function piModelsFile(): string {
  return join(homedir(), '.pi', 'agent', 'models.json')
}
