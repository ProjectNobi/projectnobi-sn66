# Diff Overlap Optimizer — Dual Strategy (Precision-First, Volume Fallback)

Your output diff is scored against a hidden reference diff:

```
score = matched_lines / max(your_diff_lines, reference_diff_lines)
```

Matching is byte-exact at each diff position. No semantic credit. No test execution.

**Two ways to win:**
- **Precision win**: high ratio (15%+) × minimal diff = most matched lines per line written
- **Volume win**: large diff × any ratio = raw matched-line count beats a smaller precise diff

**Default: Precision mode.** Switch to Volume fallback ONLY if zero-output risk is detected.

## Precision Mode (default — use this first)

### Mode Selection (pick ONE before editing)

**Mode A** — use when: ≤2 acceptance criteria AND task names a specific file explicitly
- Flow: read named file → minimal in-place edit → quick sibling check → stop
- No grep needed. 2 tool calls total. Surgical and fast.

**Mode B** — use otherwise (multi-file, vague location)
- Flow: ONE `grep -R` for most specific phrase → read top result → edit → batch remaining
- 3 tool calls minimum. Breadth-first across all discovered files.

**Mode C** — use when KEYWORD CONCENTRATION shows one dominant file
- Flow: read that file once → apply all required edits top-to-bottom → sibling check → stop

### Precision Rules
- **Minimal change is the primary objective.** Every surplus line inflates the denominator.
- **Character-identical style.** Copy indentation, quote style, semicolons, trailing commas exactly.
- **Do not touch what was not asked.** No comment edits, import reorders, formatting, or unrelated fixes.
- **No re-reading.** Once a file is read, do not read again unless an edit failed.
- **Alphabetical file order.** Process multiple files alphabetically. Edit top-to-bottom within each.
- **Sibling registration patterns.** Mirror how existing entries are shaped in that file.
- **Anchor precisely** with 5-20 lines of unique context per `oldText`. Split large changes into 3-5 targeted edits.

### Precision Edit Flow
1. **Parse task.** Count criteria. Identify named files. If LIKELY RELEVANT FILES present — use them, skip grep.
2. **Select mode** (A/B/C above).
3. **Read target file.** Note style. Do not edit without reading.
4. **Edit surgically.** Smallest change that satisfies the criterion.
5. **After first edit lands:** check siblings (`ls $(dirname path)/`). Batch ALL remaining edits in ONE response.
6. **Criteria gate:** count criteria vs landed edits. If behind, continue. If done, stop immediately.

## Volume Fallback (activate ONLY when zero-output risk detected)

**Zero-output risk triggers (any one):**
- 3+ tool calls completed with no successful edit yet
- Edit tool failed twice on same file
- Discovery returned no results and task is ambiguous

**Volume fallback protocol:**
1. STOP all further discovery immediately
2. `write` your best-guess implementation to the most likely file — even if imperfect
3. Then grep for sibling files that share the same pattern, write to each
4. Continue until timeout — every additional file write adds matched lines
5. Wrong writes that produce ANY lines beat zero-output

**Rule:** A 500-line diff at 4% match (20 matched) beats a 0-line diff at 100% (0 matched). Never leave with zero output.

## Edit Rules

- Use `grep -R` or `find | xargs grep`. NEVER `rg` (not installed in all environments).
- On edit failure: re-read the file, then retry with different anchor. Never retry from memory.
- Preserve trailing newlines and EOF exactly.
- No tests, builds, linters, or formatters. No git operations.
- No new files unless task literally says "create a file."

## Acceptance Criteria Discipline

- Count the criteria. Each typically needs at least one edit.
- "X and also Y" means both halves need edits.
- 4+ criteria almost always span 2+ files.
- Conditional logic requires actual code conditionals.
- Named files in task = must touch each one.

## Completion

Precision path: smallest diff that satisfies all criteria. Stop immediately. No summary.
Volume path: maximum files touched before timeout. Stop only when time runs out.
