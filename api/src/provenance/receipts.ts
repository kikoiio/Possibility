import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import { persons, timelines, worldCommands, worldFacts, worldPersons, worlds } from '../db/schema'
import type { MessageReceipt, ReceiptLookup, RecordRef } from './types'
import type { ProvenanceAccess } from './scope'
import { assertEvidenceScope, ProvenanceScopeError } from './scope'
import type { EvidenceScope } from './types'

type InformPayload = { type?: unknown; recipientId?: unknown; topic?: unknown; content?: unknown; sourceFactId?: unknown }

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

function inScope(scope: EvidenceScope, timelineId: string, version: number, simTime: string): boolean {
  if (timelineId === scope.timelineId) return version <= scope.revisionVersion && Date.parse(simTime) <= Date.parse(scope.simNow)
  const boundary = scope.ancestors.find(item => item.timelineId === timelineId)
  return !!boundary && version <= boundary.maxVersion && Date.parse(simTime) <= Date.parse(boundary.maxSimTime)
}

async function label(db: Db, personId: string | null): Promise<{ personId: string | null; name: string } | null> {
  if (!personId) return null
  const person = await db.select({ id: persons.id, name: persons.name }).from(persons).where(eq(persons.id, personId)).get()
  return person ? { personId: person.id, name: person.name } : { personId, name: personId }
}

/** Build a stable receipt from the immutable command/fact pair. */
export async function messageReceiptFromCommand(db: Db, command: typeof worldCommands.$inferSelect, fact: typeof worldFacts.$inferSelect): Promise<MessageReceipt | null> {
  if (command.type !== 'inform' || fact.factType !== 'knowledge') return null
  const action = parseObject(command.payloadJson) as InformPayload | null
  const value = parseObject(fact.valueJson)
  if (!action || action.type !== 'inform' || !value || typeof action.recipientId !== 'string') return null
  const recipientId = typeof value.recipientId === 'string' ? value.recipientId : action.recipientId
  const topic = typeof value.topic === 'string' ? value.topic : typeof action.topic === 'string' ? action.topic : ''
  const content = typeof value.content === 'string' ? value.content : typeof action.content === 'string' ? action.content : ''
  if (!topic || !content) return null
  const senderPersonId = command.actorKind === 'visitor' ? command.actorId
    : command.actorKind === 'owner' && command.actorId ? (await db.select({ id: persons.id }).from(persons).where(and(
      eq(persons.userId, command.actorId), eq(persons.isUser, true),
    )).get())?.id ?? null : null
  const [sender, recipient] = await Promise.all([label(db, senderPersonId), label(db, recipientId)])
  return {
    receiptId: `receipt:${fact.id}`,
    commandId: command.id,
    factRef: { kind: 'knowledge_fact', id: fact.id, timelineId: fact.timelineId },
    worldId: command.worldId,
    timelineId: fact.timelineId,
    version: fact.version,
    simTime: fact.simTime,
    sender,
    recipient: recipient ?? { personId: recipientId, name: recipientId },
    topic,
    content,
  }
}

/** Query an already committed inform request. Missing is distinct from a failed network request. */
export async function getMessageReceipt(
  db: Db, access: ProvenanceAccess, scope: EvidenceScope, commandId: string,
): Promise<ReceiptLookup> {
  await assertEvidenceScope(db, access, scope)
  if (!commandId || commandId.length > 200) throw new ProvenanceScopeError(400, '命令编号无效', 'invalid_input')
  const command = await db.select().from(worldCommands).where(eq(worldCommands.id, commandId)).get()
  if (!command || command.worldId !== scope.worldId) {
    return { status: 'not_found' }
  }
  const fact = await db.select().from(worldFacts).where(eq(worldFacts.sourceCommandId, command.id)).get()
  if (!fact || !inScope(scope, fact.timelineId, fact.version, fact.simTime)) return { status: 'not_found' }
  const receipt = await messageReceiptFromCommand(db, command, fact)
  return receipt ? { status: 'committed', receipt } : { status: 'not_found' }
}

/** Find the committed receipt by its stable receipt ID. */
export async function getMessageReceiptById(
  db: Db, access: ProvenanceAccess, scope: EvidenceScope, receiptId: string,
): Promise<ReceiptLookup> {
  await assertEvidenceScope(db, access, scope)
  if (!receiptId.startsWith('receipt:')) return { status: 'not_found' }
  const factId = receiptId.slice('receipt:'.length)
  const fact = await db.select().from(worldFacts).where(eq(worldFacts.id, factId)).get()
  if (!fact) return { status: 'not_found' }
  return getMessageReceipt(db, access, scope, fact.sourceCommandId)
}

// Kept private to this module but exported for read.ts tests and callers that
// need to apply exactly the same timeline/version boundary.
export { inScope as receiptInScope }
