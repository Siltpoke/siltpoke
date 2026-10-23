# Siltpoke hook launcher — Windows. One file, both hooks.
#
# ONE launcher rather than the stop.ps1 + session-start.ps1 the plan named.
# Deliberate deviation: the two would have differed by a single argument while
# each carrying ~100 lines of identical stdin/bun/spawn handling, and this
# file's own argument for existing is that a launcher must be too small to
# drift out of step with its twin. Two copies of it would have been the drift.
#
# The Unix side of this is hooks/stop.sh, 108 lines of failure-mode defence.
# NONE of that logic lives here. This file finds bun and hands over; the
# decisions are in dist/siltpoke-hook-guard.js, written in the one language
# this repo already ships on every platform. A second copy of those 108 lines
# in a shell dialect with different failure semantics would have to be kept in
# step by hand forever, and this launcher is deliberately too small to drift.
#
# WHY IT EXISTS: hooks.json registers the review hook as `sh ".../stop.sh"`.
# Native Windows has no `sh` on PATH, so the host cannot start that command —
# and because the guard's whole contract is silence, the user gets a pet, a
# working statusline, a healthy /siltpoke:siltpoke-doctor, and no review, ever, with
# nothing saying why.
#
# THE CONTRACT, inherited from stop.sh and not negotiable here:
#   - Nothing may reach the user's session. Every failure is exit 0, silent.
#     Two exceptions, both chosen by the guard and never by a failure: the
#     `-SelfTest` line (no hook passes it), and the once-ever setup nudge that
#     stop.sh also prints (defect [33]).
#   - The payload is read from stdin on EVERY path, before anything else. A
#     hook that leaves stdin unread can make the host block on its pipe write.
#   - Exit 0 no matter what, including when bun is missing or the guard throws.

param(
    # Which hook this invocation is. Passed by hooks.json (`stop`,
    # `session-start`) or by codex's plugin-root hooks.json (`codex-stop`,
    # `codex-session-start`); anything else is treated as `stop`, so a mangled
    # argument degrades to the hook that matters rather than to nothing at all.
    [string]$Mode = 'stop',

    # Probe mode, used ONLY by /siltpoke:siltpoke-doctor's "review hook can start" row.
    # Prints exactly one `siltpoke-guard …` line to stdout and starts no review.
    #
    # A PowerShell SWITCH, not the `--self-test` the guard bundle takes, and the
    # difference is load-bearing rather than cosmetic. PowerShell 5.1 binds any
    # `-`-prefixed token on a `-File` command line as a parameter NAME, so
    # `--self-test` arrives as a request for a parameter called `-self-test`,
    # matches nothing, and terminates the script before its first statement —
    # on a perfectly healthy machine. The first draft of this file took the flag
    # as a bare extra argument and could therefore never run at all in the one
    # mode doctor invokes it in. Caught in review, 2026-09-24. The bundle's own
    # flag stays `--self-test`; it is Node-style argv and is forwarded below.
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

try {
    # --- 1. Drain stdin as BYTES, before any decision. -------------------
    #
    # Bytes, not a string, and this is not a style preference. Windows
    # PowerShell 5.1 does not default to UTF-8 on its pipes — it uses the
    # system codepage, or UTF-16LE. A `$input | Out-String` round-trip
    # silently mangles any non-ASCII in the payload, and this product's
    # transcripts routinely carry CJK and emoji. The guard would then fail to
    # parse the JSON and, obeying its own never-print contract, exit 0 in
    # silence — indistinguishable from "no review was needed". That is the
    # exact defect this file exists to remove, reproduced by the fix for it.
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object System.IO.MemoryStream
    $stdin.CopyTo($buffer)
    $payload = $buffer.ToArray()

    # --- 1b. Stand down when the Unix entry already handled this turn. ---
    #
    # `hooks.json` registers BOTH commands for each event, because the host
    # picks the shell and nothing in the schema lets a hook say which OS it is
    # for. On Windows WITH Git Bash the host runs shell-form commands through
    # Git Bash, so `sh ".../stop.sh"` starts normally AND this launcher starts
    # too: one turn, two reviews, racing on the same anchor. That race is the
    # shape defect `[27]` was — an anchor advanced by one path while another is
    # still working — so this is a correctness guard, not tidiness.
    #
    # `sh` on PATH is an INFERENCE, not a verified match to the host's logic.
    # The docs say only "Git Bash on Windows, or PowerShell when Git Bash isn't
    # installed" and never say how that is detected. The evidence is one
    # negative data point: on a real Windows machine `where.exe sh` found nothing
    # AND the `sh` entry really had not been running (audit §39.3). That is a
    # correlation on one box.
    #
    # RESIDUAL, stated rather than implied: a Windows machine carrying some
    # OTHER `sh.exe` (MSYS2, Cygwin, busybox-w32) would stand this launcher
    # down. If the host does not count that as Git Bash, it runs the `sh` entry
    # through PowerShell instead, where it may not execute stop.sh at all — and
    # then BOTH paths are silent and that turn gets no review. Chosen anyway
    # because the alternative failure, two reviews racing one anchor, is the
    # `[27]` shape and destroys a diff rather than skipping one. Narrow this
    # the day someone can observe the host's real choice. Audit §43.2.
    #
    # AFTER the stdin drain, never before: leaving the payload unread can make
    # the host block on its pipe write, and that contract has no exceptions.
    #
    # NOT under -SelfTest. `/siltpoke:siltpoke-doctor` invokes this launcher directly to
    # ask whether the review hook can start, and on a Git Bash machine the
    # honest answer is still "yes" — standing down there would turn the probe
    # into a silent pass, which is the `[23]` failure this file's own doctor
    # row exists to remove.
    #
    # NOT for the `codex-` modes either. codex reads `commandWindows` INSTEAD of
    # `command` on Windows, so its `sh` entry never starts there and nothing
    # else would run the turn.
    if ((-not $SelfTest) -and ($Mode -notlike 'codex-*') -and (Get-Command sh -ErrorAction SilentlyContinue)) { exit 0 }

    # --- 2. Resolve bun.exe, same ladder as hooks/lib/resolve-bun.sh. ----
    #
    # PATH first (the normal case, and the only rung that keeps working if the
    # user moves bun), then the absolute path setup recorded from its own
    # process, then bun's default install location.
    #
    # The two lower rungs are skipped when USERPROFILE is unset rather than
    # joined onto nothing: `Join-Path` throws on a null path, and under
    # `$ErrorActionPreference = 'Stop'` that would jump to the catch block and
    # lose the PATH answer we may already have.
    $bun = $null
    $onPath = Get-Command bun -ErrorAction SilentlyContinue
    if ($onPath) { $bun = $onPath.Source }

    if ((-not $bun) -and $env:USERPROFILE) {
        $pointer = Join-Path $env:USERPROFILE '.siltpoke\bun-path'
        if (Test-Path $pointer) {
            $recorded = (Get-Content $pointer -Raw -ErrorAction SilentlyContinue)
            if ($recorded) {
                $recorded = $recorded.Trim()
                if ($recorded -and (Test-Path $recorded)) { $bun = $recorded }
            }
        }
    }

    if ((-not $bun) -and $env:USERPROFILE) {
        $fallback = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
        if (Test-Path $fallback) { $bun = $fallback }
    }

    # No bun, no review, and NO message. config.json existing means setup
    # already succeeded, so "run /siltpoke:siltpoke-setup" would send the user to redo
    # the one step that worked. /siltpoke:siltpoke-doctor is the surface that says this
    # out loud — and it says it by RUNNING this launcher with -SelfTest,
    # rather than by asking the same question a second way.
    #
    # Under -SelfTest the launcher answers for the guard it cannot reach. The
    # guard owns the `no-bun` vocabulary, but the guard cannot be started
    # WITHOUT bun, so a silent exit here would reach doctor as empty stdout and
    # be read as "PowerShell refused to run the launcher" — sending a user with
    # no bun to go fix an ExecutionPolicy. Conflating those two is the exact
    # failure a real-machine test exists to catch.
    if (-not $bun) {
        if ($SelfTest) { [Console]::Out.Write("siltpoke-guard no-bun`n") }
        exit 0
    }

    # --- 3. Hand the bytes to the guard. --------------------------------
    $guard = Join-Path $PSScriptRoot '..\dist\siltpoke-hook-guard.js'
    if (-not (Test-Path $guard)) {
        # Distinct from the guard's own `no-bundle` (which is the stop /
        # session-start bundle missing): this is the guard itself missing, so
        # nothing downstream ever ran. Same remedy, different sentence.
        if ($SelfTest) { [Console]::Out.Write("siltpoke-guard no-guard`n") }
        exit 0
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $bun
    $hookMode = if (@('session-start', 'codex-stop', 'codex-session-start') -contains $Mode) { $Mode } else { 'stop' }
    $psi.Arguments = '"' + $guard + '" ' + $hookMode
    if ($SelfTest) { $psi.Arguments = $psi.Arguments + ' --self-test' }
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($psi)

    # Start draining BOTH output pipes BEFORE writing the payload, and do it
    # asynchronously. Order and asynchrony are the whole point.
    #
    # The first draft wrote the entire payload, then called ReadToEnd(). That is
    # the textbook .NET process-I/O deadlock: a child that writes more than a
    # pipe buffer holds — a bun that crashes on startup and prints a stack
    # trace, a case this file's own comments predicted — blocks on its write
    # while the parent is still blocked on its own, and neither side ever moves.
    # What hangs is the HOST'S Stop hook, inside this `try`, so `finally { exit
    # 0 }` is never reached either. Caught in review, 2026-09-24.
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    # A child that has already died leaves a broken pipe, and writing to it
    # throws. That is a normal outcome here, not an error worth propagating.
    # (Residual, stated rather than implied: a child that started and then never
    # read its stdin could still block this write. The guard drains stdin on
    # every path before any decision, by contract, which is what makes that
    # case a guard bug rather than a launcher one.)
    try {
        $proc.StandardInput.BaseStream.Write($payload, 0, $payload.Length)
        $proc.StandardInput.BaseStream.Flush()
    }
    catch { }
    $proc.StandardInput.Close()

    if ($SelfTest) {
        # A probe must answer or give up; it may not hang doctor. Five seconds
        # is far past a cold bun start and deliberately SHORTER than doctor's
        # own 8s cap on this process, so the bound that fires first is normally
        # the one that can still kill the grandchild — a doctor-side kill reaps
        # PowerShell and orphans bun.
        #
        # RESIDUAL, stated rather than implied: that ordering is a preference,
        # not a guarantee. This 5s starts only when the script body reaches this
        # line, while doctor's 8s is wall-clock from the spawn — so PowerShell's
        # own interpreter start-up eats into the 3s margin, and enough AV latency
        # on powershell.exe alone would let the outer bound fire first and orphan
        # bun after all. Inherent to two-tier timeouts with unpredictable cold
        # starts, and scoped to this diagnostic: the real hook path has no
        # timeout at all. The real hook path below waits without one too, exactly
        # as `stop.sh:104` does, because it is waiting on an actual review.
        if (-not $proc.WaitForExit(5000)) {
            try { $proc.Kill() } catch { }
        }
    }
    else {
        $proc.WaitForExit()
    }

    # Both pipes are read to completion on every path so the child can never
    # block on a full one. stderr is always discarded: a crashing guard's stack
    # trace must never reach the session. The guard's stdout is passed through,
    # because it carries exactly two things and both are meant to leave: the
    # -SelfTest line, and the once-ever setup nudge as `systemMessage` JSON.
    # A BUNDLE's output cannot be in it — the guard spawns bundles with stdio
    # "ignore". Defect [33]: this line used to be `if ($SelfTest)` only, and the
    # nudge (then on stderr) was dropped here while `.nudged` burned it for good.
    $out = ''
    try { $out = $stdoutTask.GetAwaiter().GetResult() } catch { }
    try { $stderrTask.GetAwaiter().GetResult() | Out-Null } catch { }
    [Console]::Out.Write($out)
}
catch {
    # Deliberately empty. An error record escaping this script is the one thing
    # this whole file exists to prevent.
}
finally {
    exit 0
}
