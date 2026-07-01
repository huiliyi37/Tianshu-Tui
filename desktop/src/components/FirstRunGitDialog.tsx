import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { openExternal } from '../runtime/client'
import { qk } from '../state/queries'

const GIT_WIN_DOWNLOAD = 'https://git-scm.com/download/win'

/**
 * First-run Git install gate. On Windows the bash tool prefers Git Bash for
 * reliable command execution, so a missing Git degrades command execution to
 * PowerShell/cmd. This blocking dialog guides the user to install Git, then
 * re-checks the environment. "稍后" lets them proceed this session (escape hatch
 * so a false-negative detection never traps the user).
 */
export function FirstRunGitDialog({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const queryClient = useQueryClient()
  const [opening, setOpening] = useState(false)
  const [rechecking, setRechecking] = useState(false)

  const handleOpenDownload = async () => {
    setOpening(true)
    try {
      await openExternal(GIT_WIN_DOWNLOAD)
    } catch {
      // sidecar opener failed — fall back to a webview tab
      window.open(GIT_WIN_DOWNLOAD, '_blank')
    } finally {
      setOpening(false)
    }
  }

  const handleRecheck = async () => {
    setRechecking(true)
    try {
      await queryClient.invalidateQueries({ queryKey: qk.environment })
    } finally {
      setRechecking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => { /* gated dialog: dismiss only via explicit buttons */ }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>需要安装 Git</DialogTitle>
          <DialogDescription>
            天枢在 Windows 上优先使用 Git 自带的 Git Bash 执行命令(构建、测试、git 等)。
            未检测到 Git,命令执行会退回 PowerShell/cmd,部分命令可能行为异常或无输出。
            建议安装 Git for Windows 后重新检测。
          </DialogDescription>
        </DialogHeader>
        <div className="git-install-panel">
          <ol className="git-install-steps">
            <li>点击「打开下载页」获取 Git for Windows 安装程序。</li>
            <li>安装时保持默认选项(确保勾选「Git from the command line」)。</li>
            <li>装完后点「我已安装,重新检测」。</li>
          </ol>
          <div className="git-install-actions">
            <Button onClick={handleOpenDownload} disabled={opening}>
              {opening ? '正在打开…' : '打开下载页'}
            </Button>
            <Button variant="outline" onClick={handleRecheck} disabled={rechecking}>
              {rechecking ? '检测中…' : '我已安装,重新检测'}
            </Button>
            <Button variant="ghost" onClick={onDismiss}>
              稍后
            </Button>
          </div>
          <p className="git-install-hint">
            已装在非默认位置?可设置环境变量 RIVET_GIT_BASH_PATH 指向 bash.exe。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
