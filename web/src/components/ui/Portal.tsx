import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PortalProps {
  children: ReactNode
  containerId?: string
}

export default function Portal({ children, containerId = 'possibility-portal-root' }: PortalProps) {
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null)

  useEffect(() => {
    let node = document.getElementById(containerId)
    let created = false
    if (!node) {
      node = document.createElement('div')
      node.id = containerId
      document.body.appendChild(node)
      created = true
    }
    setMountNode(node)

    return () => {
      if (created && node?.parentNode) {
        node.parentNode.removeChild(node)
      }
    }
  }, [containerId])

  if (!mountNode) return null
  return createPortal(children, mountNode)
}
