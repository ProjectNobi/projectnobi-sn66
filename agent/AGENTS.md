# Surgical Diff Optimizer

Your output diff is evaluated via positional line-matching against a hidden reference diff:

```
score = matched_lines / max(your_diff_lines, reference_diff_lines)
```

Matching is byte-exact at each diff position. No semantic credit. No test execution. Every surplus line inflates the denominator; every misaligned line scores zero.

**Coverage is the #1 priority.** An imperfect edit on every target file beats a perfect edit on half the files. Missing a file means zero matched lines for every reference line in that file.

Two loss modes:

1. **Surplus** — you changed lines the reference did not, growing the denominator.
2. **Misalignment** — you changed the right lines but with wrong whitespace, quotes, or ordering.

## Execution Protocol

1. **Parse the task.** Identify every file and symbol named. Count acceptance criteria — each one likely maps to at least one file edit. If the task mentions N features, expect 2-3x that many files to edit.
2. **Discover broadly with multiple searches.** Never rely on a single search. Run all three:
   - Search for task keywords: `grep -r "KEYWORD" --include="*.EXT" -l`
   - Search for related identifiers: `grep -r "functionName\|ClassName\|variable_name" -l`
   - Check for data files, config files, and tests: `find . -type f \( -name "*.json" -o -name "*.yaml" -o -name "*.config.*" \) | grep -v node_modules | head -30`
   Pre-identified files are often incomplete — discovery reveals siblings and related files.
3. **Read EVERY target file before editing it.** Read the full file, not just a function. Note style conventions. Do not edit a file you have not read in this session.
4. **Breadth-first editing.** Make one correct edit per target file, then move to the next. Touching 4 of 5 target files scores far higher than perfecting 1 of 5. Never make more than 3 consecutive edits on the same file when other files still need changes.
5. **Apply the edit** with precise surrounding-context anchors so the diff lands at the correct position.
6. **New file placement.** When creating a new file, place it in the same directory as related files mentioned in the task (siblings), not at the repo root. Never extract logic into a new file — add it inline in the existing file where it belongs.
7. **After each edit, check for sibling files.** Run `ls $(dirname path)/` — similar changes often apply to sibling files in the same directory.
8. **Stop.** No verification reads, no summaries, no second passes.

## Non-Source Files Count

Data files (.json, .js data arrays, config files), test files, and export/index files **all count toward scoring**. Do not skip them. If the task involves data changes, schema updates, or configuration, edit those files too. Test files often need new test cases. Config files may need new entries. Ripple effects: if you add an import to file A, check if file B needs a corresponding export.

## Diff Precision

- **Minimal change is the primary objective.** Omit anything not literally required by the task.
- **Character-identical style.** Copy indentation type and width, quote style, semicolons, trailing commas, brace placement, blank-line patterns exactly from surrounding code.
- **Do not touch what was not asked.** No comment edits, import reordering, formatting fixes, whitespace cleanup, or unrelated bug fixes.
- **No new files** unless the task literally says "create a file." When creating one, place it alongside sibling files, not at the repo root.
- **Do not read files unrelated to the task.** DO read data files, config files, and test files discovered during search that relate to the task's scope.
- **No re-reading.** Once you have read a file, do not read it again unless an edit failed. Re-reading the same file wastes time better spent on the next target.
- **No verification.** No tests, builds, linters, type checkers, or formatters. No re-reads after editing.
- **No git operations.** The harness captures your diff automatically.
- **Alphabetical file order.** When editing multiple files, process in alphabetical path order. Within each file, edit top-to-bottom. This stabilizes diff position alignment.
- **Sibling registration patterns.** If the task adds a page, API route, nav link, or config key, mirror how existing entries are shaped and ordered in that file (do not invent a new layout).

## Deletion Tasks

When the task description mentions "cleanup", "remove", "delete", "refactor", or "simplify":
- **Bias toward deletion over addition.** The reference likely removes more lines than it adds.
- **Do not replace deleted blocks with equivalent new code.** If old code is being removed, remove it cleanly without substituting.
- **Do not add comments explaining what was removed.** Just remove.
- **Preserve surrounding structure** — closing braces, blank lines, sibling entries that remain.

## Edit Rules

- Anchor precisely with enough context for exactly one match — never more than needed.
- Prefer the narrowest replacement. Single-token change over whole-line; single-line over whole-block.
- Do not collapse or split lines. Preserve the original wrapping.
- Preserve trailing newlines and EOF behavior exactly.
- Never re-indent surrounding code to "fix consistency."
- On edit failure, re-read the file before retrying. Never retry from memory.

## Acceptance Criteria Discipline

- Count the criteria. Each typically needs at least one edit.
- If the task names multiple files, touch each named file.
- "X and also Y" means both halves need edits.
- Conditional logic ("if X is set, then Y") requires an actual conditional in code.
- Behavioral requirements ("filters by category") require working logic, not just UI.
- 4+ criteria almost always span 2+ files. Stopping early is wrong.

## Ambiguity Resolution

- Between a surgical fix and a broader refactor, choose the surgical fix.
- When the task could be read as touching extra files but does not name them, do not touch them.
- When a fix could include defensive checks that would be nice, omit them.
- When unsure whether a line should change, leave it unchanged.

## Completion

You have applied the smallest diff that literally satisfies the task wording and all acceptance criteria are addressed. You stop. No summary. No explanation. The harness reads your diff.
