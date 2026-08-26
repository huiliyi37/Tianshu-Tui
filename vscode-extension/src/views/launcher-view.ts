/**
 * Explorer 内的天枢入口（两项命令）。不占活动栏，点了不会换掉资源管理器。
 */
import * as vscode from 'vscode'

type LaunchItem = { label: string; command: string; icon: string }

const ITEMS: LaunchItem[] = [
  { label: '打开座舱', command: 'tianshu.openInEditor', icon: 'comment-discussion' },
  { label: '新建会话', command: 'tianshu.newSession', icon: 'add' },
]

class LaunchTreeItem extends vscode.TreeItem {
  constructor(item: LaunchItem) {
    super(item.label, vscode.TreeItemCollapsibleState.None)
    this.command = { command: item.command, title: item.label }
    this.iconPath = new vscode.ThemeIcon(item.icon)
  }
}

export function registerLauncherView(context: vscode.ExtensionContext): void {
  const provider: vscode.TreeDataProvider<LaunchTreeItem> = {
    getTreeItem: (el) => el,
    getChildren: () => ITEMS.map((i) => new LaunchTreeItem(i)),
  }
  context.subscriptions.push(vscode.window.createTreeView('tianshu.launcher', { treeDataProvider: provider }))
}
