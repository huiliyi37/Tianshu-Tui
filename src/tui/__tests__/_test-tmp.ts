/**
 * 测试临时目录辅助 — 在项目内 .test-tmp/ 下创建唯一子目录。
 *
 * 沙箱环境下 os.tmpdir()（/var/folders/...）可能无写权限（EPERM），
 * 改用 process.cwd()/.test-tmp/ 确保跨环境可写。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TEST_TMP_ROOT = join(process.cwd(), '.test-tmp')

/** 在项目内 .test-tmp/ 下创建唯一临时目录，返回绝对路径。 */
export function makeTestDir(prefix = 'test-'): string {
  mkdirSync(TEST_TMP_ROOT, { recursive: true })
  return mkdtempSync(join(TEST_TMP_ROOT, prefix))
}

/** 清理临时目录（best-effort，失败静默）。 */
export function cleanupTestDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
