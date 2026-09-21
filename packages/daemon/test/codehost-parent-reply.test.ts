import { describe, expect, it, vi } from 'vitest'
import type { RdMsgHook } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { GithubReplyCollector } from '../src/github/poster.js'
import { sessionKey } from '../src/store/local-store.js'
import { callDaemonTool, daemonMcpBinding } from '../../../evals/games/mcp-client.js'
import { fakeCpClient, scaffold, scriptedHosts, seedCallPolicy, settle } from './webchat-continuation-fixture.js'
import { WAIT } from './wait-support.js'

const PARENT = 'parent'
const CHILD = 'child'

function hook(provider: 'github' | 'gitlab' | 'gitea'): RdMsgHook {
  return {
    source: 'hook',
    agentId: PARENT,
    hookId: 'hook-1',
    deliveryKey: 'delivery-1',
    msgId: 'hook-1:delivery-1',
    sessionKey: `${provider}:123:issue:42`,
    firedAt: new Date().toISOString(),
    event: 'issues:opened',
    context: {
      source: provider,
      event: 'issues',
      action: 'opened',
      repo: 'acme/project',
      number: 42,
      truncated: false
    },
    ...(provider === 'github'
      ? {
          github: {
            repoId: '123',
            repoFullName: 'acme/project',
            sourceInstallationId: '456',
            subjectKind: 'issue' as const
          }
        }
      : {}),
    ...(provider === 'gitlab'
      ? { gitlab: { projectId: '123', projectPath: 'acme/project', target: { kind: 'issue' as const, iid: 42 } } }
      : {}),
    ...(provider === 'gitea'
      ? { gitea: { repoId: '123', repoPath: 'acme/project', target: { kind: 'issue' as const, index: 42 } } }
      : {})
  }
}

describe('code-host parent replies', () => {
  it.each(['github', 'gitlab', 'gitea'] as const)(
    'resumes a %s parent and publishes only its answer after an explicit child report',
    async (provider) => {
      await roundTrip(provider, true)
    }
  )

  it('infers a child report into the same code-host output route', async () => {
    await roundTrip('github', false)
  })

  it.each(['not_started', 'in_flight', 'settled'] as const)(
    'replays a parent report with its %s publication fence and no hook run',
    async (state) => {
      const root = scaffold([PARENT])
      const seed = new Daemon({ root, hostFactory: scriptedHosts({ [PARENT]: () => 'unused' }).factory })
      await seed.start()
      const target = { provider: 'github', hookId: 'hook-1', repo: 'acme/project', number: 42 }
      const key = sessionKey('hook', 'github:123', '42', PARENT, 'github:123')
      await (seed as any).store.appendInbox({
        id: 'parent-report',
        sessionKey: key,
        agentId: PARENT,
        enqueuedAt: '1',
        loopGuardCounted: 1,
        codeHostReplyTarget: JSON.stringify(target),
        posterPublishState: state,
        msg: JSON.stringify({
          msgId: 'parent-report',
          source: 'agent',
          platform: 'hook',
          channel: 'github:123',
          thread: '42',
          transportScope: 'github:123',
          sender: { id: CHILD, isBot: true },
          text: 'Recovered private findings.',
          mentionedBots: [],
          isDm: false,
          parentReport: true
        })
      })
      await seed.stop()
      const runtime = scriptedHosts({ [PARENT]: () => 'Recovered parent answer.' })
      const restarted = new Daemon({ root, hostFactory: runtime.factory })
      const publish = vi.fn(async () => {})
      const makeReply = vi.fn(() => ({ poster: { publish }, collector: new GithubReplyCollector() }))
      const cp = { ...fakeCpClient(), emitEventSession: vi.fn(), emitHookReport: vi.fn() }
      ;(restarted as any).cpClient = cp
      ;(restarted as any).githubReviews.makeCodeHostReply = makeReply
      try {
        await restarted.start()
        await vi.waitFor(() => expect(runtime.prompts.get(PARENT)).toHaveLength(1), WAIT)
        await settle()
        if (state === 'not_started') {
          expect(publish).toHaveBeenCalledExactlyOnceWith('Recovered parent answer.')
          expect(makeReply).toHaveBeenCalledWith(PARENT, target, expect.any(String))
        } else {
          expect(makeReply).not.toHaveBeenCalled()
          expect(publish).not.toHaveBeenCalled()
        }
        expect(cp.emitHookReport).not.toHaveBeenCalled()
      } finally {
        await restarted.stop()
      }
    }
  )
})

async function roundTrip(provider: 'github' | 'gitlab' | 'gitea', explicit: boolean) {
  let releaseChild!: () => void
  const childCanFinish = new Promise<void>((resolve) => {
    releaseChild = resolve
  })
  const bindings = new Map<string, { endpoint: string; token: string }>()
  const parentInputs: string[] = []
  let childResult: unknown
  let delegateResult: unknown
  let seq = 0
  const factory = (agent: { id: string }, onUpdate: (sid: string, u: unknown) => void) => ({
    start: vi.fn(async () => {}),
    newSession: vi.fn(async (_cwd: string, mcpServers?: unknown) => {
      const sid = `acp-${agent.id}-${++seq}`
      const binding = daemonMcpBinding(mcpServers)
      if (binding) bindings.set(sid, binding)
      return sid
    }),
    hasSession: vi.fn(() => true),
    prompt: vi.fn(async (sid: string, blocks: { text?: string }[]) => {
      const text = blocks.map((b) => b.text ?? '').join('\n')
      let answer: string
      if (agent.id === PARENT) {
        parentInputs.push(text)
        if (parentInputs.length === 1) {
          delegateResult = await callDaemonTool(bindings.get(sid)!, 'sendMessage', {
            toAgent: { agentId: CHILD, needsReply: true },
            message: 'Investigate and report back.'
          })
          answer = 'AC_NO_RESPONSE'
        } else {
          const d = daemon as any
          expect(d.activeGithubTurnMeta.size).toBe(0)
          expect(d.gitlabReviews.turns.size).toBe(0)
          expect(d.giteaReviews.turns.size).toBe(0)
          answer = 'Public summary from the parent.'
        }
      } else {
        await childCanFinish
        if (explicit) {
          const parentId = [...text.matchAll(/"sessionId":"([^"]+)"/g)]
            .map((m) => m[1])
            .find((v) => !v!.startsWith('<'))
          childResult = await callDaemonTool(bindings.get(sid)!, 'sendMessage', {
            sessionId: parentId,
            message: 'Private child findings.'
          })
        }
        answer = explicit ? 'Reported.' : 'Private child findings.'
      }
      onUpdate(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async () => {}),
    stop: vi.fn(async () => {})
  })
  const daemon = new Daemon({ root: scaffold([PARENT, CHILD]), hostFactory: factory as never })
  const cp = {
    ...fakeCpClient(),
    emitEventSession: vi.fn(),
    emitHookReport: vi.fn(async () => 'acknowledged' as const)
  }
  const publish = vi.fn(async () => {})
  const makeReply = vi.fn(() => ({ poster: { publish }, collector: new GithubReplyCollector() }))
  await daemon.start()
  const d = daemon as any
  d.cpClient = cp
  d.githubReviews.makeCodeHostReply = makeReply
  seedCallPolicy(daemon, [PARENT, CHILD], {
    [PARENT]: {
      callPolicy: 'selected',
      allowedCallerAgentIds: [],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: [CHILD]
    },
    [CHILD]: {
      callPolicy: 'selected',
      allowedCallerAgentIds: [PARENT],
      outboundPolicy: 'selected',
      allowedTargetAgentIds: []
    }
  })
  try {
    d.handleRelayMsg(hook(provider), () => {})
    await vi.waitFor(() => expect(cp.emitHookReport).toHaveBeenCalledTimes(1), WAIT)
    expect(delegateResult).toMatchObject({ ok: true })
    const [listedParent] = await d.store.listSessions(PARENT)
    const parent = await d.store.getSession(listedParent.key)
    expect(JSON.parse(parent.codeHostReplyTarget)).toMatchObject({ provider, hookId: 'hook-1', number: 42 })
    // The poster itself filters AC_NO_RESPONSE; observe only the resumed turn below.
    publish.mockClear()
    releaseChild()
    await vi.waitFor(() => expect(publish).toHaveBeenCalledWith('Public summary from the parent.'), WAIT)
    await settle()
    if (explicit) expect(childResult).toMatchObject({ ok: true })
    expect(parentInputs).toHaveLength(2)
    expect(parentInputs[1]).toContain('Private child findings.')
    expect(parentInputs[1]?.includes('[inferred reply]')).toBe(!explicit)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(makeReply.mock.calls.at(-1)).toEqual([PARENT, JSON.parse(parent.codeHostReplyTarget), parent.acpSessionId])
    // A report resumes an ordinary turn, not the completed hook or its formal-review authority.
    expect(cp.emitHookReport).toHaveBeenCalledTimes(1)
  } finally {
    releaseChild()
    await daemon.stop()
  }
}
