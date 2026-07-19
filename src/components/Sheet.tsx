import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'

interface SheetProps {
  open: boolean
  onClose: () => void
  children: ReactNode
}

export function Sheet({ open, onClose, children }: SheetProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto border-t-4 border-felt-500 bg-stone-900 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.22, ease: (t: number) => Math.ceil(t * 5) / 5 }}
          >
            <div className="mx-auto mb-4 h-1.5 w-12 bg-felt-500" />
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
