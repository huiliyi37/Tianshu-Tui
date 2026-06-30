import { relaunch } from '@tauri-apps/plugin-process'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { StorageLocationPanel } from './StorageLocationPanel'

export function FirstRunStorageDialog({ open }: { open: boolean }) {
  const handleApplied = async (requiresRestart: boolean) => {
    if (requiresRestart) {
      try {
        await relaunch()
      } catch {
        window.location.reload()
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => { /* first-run dialog cannot be dismissed */ }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>选择数据存储位置</DialogTitle>
          <DialogDescription>
            首次启动需要指定天枢数据目录，之后可以在「设置 → 系统 → 存储位置」中修改。
          </DialogDescription>
        </DialogHeader>
        <StorageLocationPanel onApplied={handleApplied} />
      </DialogContent>
    </Dialog>
  )
}
