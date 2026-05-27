# Delivery Gate stale verification RED 记录

> **Status**: proposed

## 现象

在实现 `deliver_task(commit=true)` scoped commit 闭环时，交付前曾错误调用 `run_tests` 执行多个 test file：

```text
run_tests src/agent/__tests__/scoped-git-commit.test.ts src/agent/__tests__/deliver-task.test.ts src/tools/__tests__/git.test.ts
```

该调用返回：

```text
Exit code: 1
0 passed, 0 failed, 0 skipped
```

这不是代码测试失败，而是 test runner/filter 用法不适配。随后按项目提示改用：

```text
./node_modules/.bin/tsx --test 'src/agent/__tests__/scoped-git-commit.test.ts' 'src/agent/__tests__/deliver-task.test.ts' 'src/tools/__tests__/git.test.ts'
```

结果通过：

```text
tests 40
pass 40
fail 0
```

类型检查也通过：

```text
npx tsc --noEmit --pretty false --noErrorTruncation
TypeScript compilation completed
```

但 `deliver_task` 仍报告 RED：

```text
Delivery Gate: RED
Blocking: Owned verification failed. Fix failures before delivery.
Attribution: Owned verification failure: run_tests src/agent/__tests__/scoped-git-commit.test.ts src/agent/__tests__/deliver-task.test.ts src/tools/__tests__/git.test.ts
```

## 归因

当前验证 supersession 逻辑按 normalized command 字符串和 scope 生成 key。早先失败的 `run_tests ...` 与后续成功的 `./node_modules/.bin/tsx --test ...` command 字符串不同，因此不会被视为同一验证的失败后成功。

因此这是 stale verification RED false-positive：实际目标测试已通过，但交付门仍保留旧失败记录。

## 当前处理

本次不修改 Delivery Gate 或 VerificationAttribution。该 RED 作为旧验证记录处理，交付说明中显式标注：

- targeted tests 已用 repo 推荐方式通过；
- typecheck 已通过；
- deliver_task RED 来自旧 `run_tests` 误用记录，没有被后续等价验证 supersede。

## 后续优化方向

可以考虑让验证 supersession key 从纯 command 字符串升级为结构化 verification identity：

- tool/channel：`run_tests`、`tsx --test`、`npm exec -- tsx --test` 可映射为同类 test runner；
- target files：提取 `src/**/__tests__/*.test.ts` path 集合并排序；
- scope：targeted/full；
- command result：失败原因若是 `0 passed, 0 failed, 0 skipped`，应考虑标记为 tool invocation failure，而不是 owned test failure。

建议先写 tests 固定以下行为，再实现：

1. 同一组 test files 的 `run_tests` 失败可被后续 `tsx --test` 成功 supersede；
2. `0 passed, 0 failed, 0 skipped` 的失败不应直接归因为 owned_failure；
3. 真正有 failed tests 的 targeted failure 仍必须阻塞交付。
