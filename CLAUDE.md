@AGENTS.md

# Working with Claude Code

## Plan first
- Use plan mode for any non-trivial task: 3 or more steps, or a design decision.
- Write the spec up front, including how the result will be verified.
- Share the plan and wait for approval before implementing.
- If something goes sideways, stop and re-plan. Don't keep pushing.

## Use subagents
- Send research, exploration, and parallel analysis to subagents to keep the main context clean.
- Give each subagent one focused task.
- For hard problems, run several subagents in parallel and compare their answers.

## Verify before done
- Never mark a task complete without proving it works.
- Run the tests, check the logs, and show the output.
- Compare behavior against `main` when the change touches existing behavior.
- Ask: would a staff engineer approve this?

## Keep it simple
- For non-trivial changes, ask whether a simpler design exists before presenting the work.
- If a fix feels hacky, rewrite it the clean way now that the problem is understood.
- Skip this for small, obvious fixes. Don't over-engineer.

## Fix bugs on your own
- Given a bug report, a failing test, or a CI failure, find the root cause and fix it. Don't ask for step-by-step guidance.
- Start from the evidence: logs, errors, and failing tests.

## Track the work
- Mark each step complete as you go.
- Give a short, high-level summary of what changed at each step.

## Git
- Commit and push only when asked.
- Commit messages are a short imperative subject and at most one sentence of body. Never add co-author or "Generated with" lines.
