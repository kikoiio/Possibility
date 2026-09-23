/** Natural-language intent resolution is advisory only; proposals require explicit confirmation. */
export type WorldActionProposal =
  | { type: 'move'; to: string }
  | { type: 'inform'; recipientId: string; recipientName: string; topic: string; content: string }

export type IntentResolution =
  | { status: 'proposal'; proposal: WorldActionProposal; confirmationRequired: true }
  | { status: 'clarification'; question: string }
  | { status: 'rejected'; reason: string }

export interface IntentContext {
  text: string
  currentLocation: string
  locations: string[]
  residents: { id: string; name: string }[]
}
