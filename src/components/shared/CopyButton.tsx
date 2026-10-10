import { CheckIcon, CopyIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function CopyButton({
  value,
  label = 'Copy',
  className,
  size = 'xs',
  variant = 'outline',
}: {
  value: string
  label?: string
  className?: string
  size?: 'xs' | 'sm' | 'icon-xs'
  variant?: 'outline' | 'ghost' | 'secondary'
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Clipboard unavailable')
    }
  }

  const Icon = copied ? CheckIcon : CopyIcon
  return (
    <Button size={size} variant={variant} onClick={copy} className={cn(copied && 'text-ok', className)}>
      <Icon />
      {size !== 'icon-xs' && (copied ? 'Copied' : label)}
    </Button>
  )
}
