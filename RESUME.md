# RESUME — 2026-08-16 · `fix/bun-test-failures` 已验证并 push，等合并

> snapshot: HEAD `5d49a98` · `fix/bun-test-failures` → `origin/fix/bun-test-failures` · 2026-08-16T00:09:06-07:00
> · ⚠️ **这份的第一版是从 git 证据重建的，不是某个 session 的现场快照。** 它只写机械可查的事实
>   （分支拓扑 / 文件 mtime / commit 内容 / 测试输出），不含任何「当时在想什么」—— 那部分没有来源，不编。
>   下次在这个 repo 里干完活，用 `/handoff` 覆盖它，那才是真正的现场快照。

## Now

`fix/bun-test-failures` 上那一个 commit（`5d49a98` "Fix bun test isolation failures"，3 文件 +21/−6：
`src/critic/tools/run-eslint.ts` · `src/few-shot/index.ts` · `src/repo-memory/index-builder.ts`）
**已经跑过测试验证，并已 push 到 origin**。

测试结果（2026-08-16，`bun test`，本机）：**5611 pass · 6 skip · 1 todo · 0 fail**，
486 个文件、16597 次 `expect()`，114 秒。

`main` 停在 `2d250e8`（v0.1.1 发布），与 `origin/main` 同步。

## 下一个具体动作

**给 `fix/bun-test-failures` 开 PR 合进 `main`**，或者确认不需要 review 就直接合。
分支已经在远端，测试证据在上面那一节 —— 挡在中间的只剩「合不合」这个决定本身。

## State so far

- **v0.1.1 已发布**（`2d250e8`）。此前的公开历史：初次公开发布 → 换 license 到 Perimeter 1.0.1 →
  cut v0.1.0 → 退掉 legacy `/dashboard` 路由（报告改为在 `/` 打开 Home）→ v0.1.1。
- **2026-07-06 跑过一次 project-lifecycle 的 `init-harness` bootstrap，产物一个都没提交，而且此后
  一个多月没再动过。** 仍是未跟踪状态（`git status` 里的 `??`）：
  `CLAUDE.md` · `CONTEXT.md` · `Makefile` · `docs/RESUME.md` · `docs/ROADMAP.md` · `docs/archive/` ·
  `docs/iteration-journal.md` · `scripts/close-gate.sh` · `scripts/test-close-gate.sh` ·
  `.claude/` · `.githooks/` · `tests/web/screens/fixtures/`。
  这些文件的 mtime 全部是 `Jul 6 17:29`–`17:30`，而 repo 的实际工作一直在往前走 ⇒
  **harness 文档与这个 repo 的真实进展已经脱节一个多月**，别把它们当现状读。
- `docs/ROADMAP.md` 里的里程碑仍是 bootstrap 骨架：`M0 Lifecycle harness bootstrap` 在做，
  `M1 First product milestone` 写着 "To be selected by the user"。**从来没有人选过那个 M1。**

## What NOT to retry

- **别把 bootstrap 产物照原样 `git add` 进来。** 这是公开仓库，那批文件是 2026-07-06 的模板骨架，
  内容与现状不符；要提交先逐个核对内容，而不是因为「它们躺在那儿碍眼」就一次性收编。
  （本文件是例外：它是 2026-08-15 新写的，内容逐条对过 git 事实。）

## Blockers / Gotchas

- **`docs/RESUME.md` 和本文件同时存在，两份内容不一样。** `docs/` 那份是 2026-07-06 的 bootstrap
  骨架（"Ask the user for the first milestone goal"），本文件是从证据重建并持续更新的那一份。
  **两份都能被 `/catchup` 读到，但根目录的这份优先** —— `docs/` 只是兜底路径。
  （改之前只有根目录能被读到，`docs/` 那份完全不可见，卡片会报 `LAST CHECKPOINT: (none — clean start)`，
  跟「压根没有 RESUME」长得一模一样。修在 PLC 的 `session_card.py`，2026-08-15。）
- **测试要跑满约 2 分钟**（486 文件 / 5618 个 case）。别用 `| tail` 接 `bun test` 判成败 ——
  拿到的是 `tail` 的退出码，永远是 0。看输出里的 `N fail` 那一行。
