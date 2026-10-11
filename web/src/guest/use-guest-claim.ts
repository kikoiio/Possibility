import { useEffect, useMemo, useState } from 'react'
import { createDefaultGuestClaimFlow, type GuestClaimAccount, type GuestClaimFlow } from './claim-flow'

let defaultFlow: GuestClaimFlow | null = null
function getDefaultFlow(): GuestClaimFlow {
  defaultFlow ??= createDefaultGuestClaimFlow()
  return defaultFlow
}

export function useGuestClaim(flow: GuestClaimFlow = getDefaultFlow(), account: GuestClaimAccount | null = null) {
  const [snapshot, setSnapshot] = useState(() => flow.getState())
  useEffect(() => {
    setSnapshot(flow.getState())
    return flow.subscribe(() => setSnapshot(flow.getState()))
  }, [flow])
  useEffect(() => {
    flow.setAccount(account)
    if (account && flow.context?.submitted) void flow.refreshStatus()
  }, [account?.id, flow])
  useEffect(() => () => {
    // Shared default flows survive page navigation; callers that inject an owned
    // flow can dispose it themselves after unmount.
  }, [flow])
  return useMemo(() => ({ ...snapshot, flow }), [snapshot, flow])
}
