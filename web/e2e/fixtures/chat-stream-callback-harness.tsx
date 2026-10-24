import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ChatStream from '../../src/components/ChatStream'

function ChatStreamCallbackHarness() {
  const [callbackVersion, setCallbackVersion] = useState('old')
  const [callbacks, setCallbacks] = useState<string[]>([])

  useEffect(() => {
    const replace = (event: Event) => {
      const version = (event as CustomEvent<string>).detail
      setCallbackVersion(version)
    }
    window.addEventListener('replace-chat-callback', replace)
    return () => window.removeEventListener('replace-chat-callback', replace)
  }, [])

  return (
    <>
      <output data-testid="callback-version">{callbackVersion}</output>
      <output data-testid="callback-results">{callbacks.join('|')}</output>
      <ChatStream
        conversationId="conversation-1"
        onStateChange={state => setCallbacks(current => [...current, `${callbackVersion}:${state.goal}`])}
      />
    </>
  )
}

export function mountChatStreamCallbackHarness(host: HTMLElement): () => void {
  const root = createRoot(host)
  root.render(<ChatStreamCallbackHarness />)
  return () => root.unmount()
}
