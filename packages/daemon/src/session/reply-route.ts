import { isCodeHostProvider } from '@agentconnect.md/protocol'
import type { SessionRecord } from '../store/local-store.js'
import type { CodeHostReplyTarget } from '../codehost/reply-target.js'

export interface SessionReplyRoute {
  integrationId?: string
  codeHostReply?: CodeHostReplyTarget
}

/** Resolve the existing session's output without treating every identity scope as a chat integration. */
export function sessionReplyRoute(
  session: SessionRecord,
  integrationForSession: (agentId: string, platform: string, scope?: string | null) => string | undefined
): SessionReplyRoute | undefined {
  if (session.platform === 'hook' && isCodeHostProvider(session.transportScope?.split(':', 1)[0])) {
    return session.codeHostReplyTarget
      ? { codeHostReply: JSON.parse(session.codeHostReplyTarget) as CodeHostReplyTarget }
      : {}
  }
  const integrationId = integrationForSession(session.agentId, session.platform, session.transportScope)
  if (session.transportScope && !integrationId) return undefined
  return integrationId ? { integrationId } : {}
}
