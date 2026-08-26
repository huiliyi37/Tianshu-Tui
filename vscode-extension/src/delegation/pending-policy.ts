/**
 * 委托编辑的人审策略。
 *
 * 文件已先落地（红绿装饰可见）。超时自动 ok 会让人还没看见 CodeLens
 * 就被当成接受。0 = 只等接受/拒绝；服务端超时才 fail-back 本地写。
 */
export const APPLY_EDIT_AUTO_ACCEPT_MS = 0
