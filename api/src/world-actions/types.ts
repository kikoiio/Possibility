/** Natural-language intent resolution is advisory only; proposals require explicit confirmation. */
export type WorldActionProposal =
  | { type: 'move'; to: string }
  | { type: 'inform'; recipientId: string; recipientName: string; topic: string; content: string }

export interface IntentAlternatives {
  locations: string[]
  residents: { id: string; name: string }[]
}

export type IntentResolution =
  | { status: 'proposal'; proposal: WorldActionProposal; confirmationRequired: true }
  | { status: 'clarification'; question: string; alternatives?: IntentAlternatives }
  | { status: 'rejected'; reason: string; alternatives?: IntentAlternatives }

export interface IntentContext {
  text: string
  currentLocation: string
  locations: string[]
  residents: { id: string; name: string }[]
}
