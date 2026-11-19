GOAL: take /home/ML/transtream to 100% per PRD.md without destroying what works.

PHASE 0 - READ FIRST, one file at a time, no writes:
PRD.md; git log --oneline -30; git status (must be clean, HEAD == origin/main);
scripts/patchkit.py in full (the edit engine all changes must use); the three
guards (guard_log_append_only, guard_layers, guard_pipeline_invariants);
backend/transtream/settings.py; backend/studio/{models,pipeline,worker,recovery,
transcription_service,upload_service,serializers,views,urls,consumers}.py;
frontend/templates/studio.html; frontend/static/js/studio.js;
scripts/{compare_whisper_sizes,ab_warmup_first_take,preflight_ab_warmup,
check_migrations}.py and scripts/transtream; README.md; .env.example.
Then report in your own words: what is done (with file:line evidence), what PRD 4
says is FALSE IN THE PUSHED RECORD, and your first proposal. Await my approval
before writing anything.

HARD RULES - violating any is worse than no progress:
1. Never edit a tracked file by sed, string surgery, or a rewriting heredoc. Use
   patchkit: lint() then apply_file(). Anchors are read from the file, never from
   memory or from this prompt.
2. Pass python=False for .html/.md/.env; python=True (default) for .py.
3. Every asserted count is measured in the same turn, as occurrences (str.count),
   not grep -c lines. Never assert a number you have not just counted.
4. Read before write. If PRD.md or your memory conflicts with the file, the file
   wins: report the conflict and stop.
5. No install, download or pip without my explicit yes. argostranslate is
   installed; its language packs are not.
6. Never truncate/rotate/delete logs/. Never push --force. Never amend a pushed
   commit - repair forward.
7. After every change run all four checks (layers, inv, gate, patchkit --selftest);
   all must be 0, plus manage.py check on backend edits.
8. A commit message is written AFTER the patch lands and verification runs, from
   the real git diff and real output. Never pre-author one in a plan. Never claim a
   browser check, test or measurement not shown in this session.
9. Patterns with ! go in single quotes. Heredoc delimiters are unique per block,
   never recycled, never nested.

SEQUENCE (PRD 5 is authoritative; this is the shape):
A. Repair the two false pushed claims forward (PRD 4).
B. Browser-verify the native-script toggle on BOTH paths - recording and uploads.
   Report what you see; it is the only witness a UI control works.
C. Land PKHONEST: re-measure {cases}/{AXES} and PRESENT BUT WRAPPED in patchkit.py,
   re-run, and prove the skip simulation gives rc=1 with 15/16.
D. Add WHISPER_INITIAL_PROMPT to .env.example and README.md (audit row:
   settings=1 example=0 readme=0). Never anchor on the U+2500 separator lines.
E. Measure take 3d92ded8 (name gradient, 4 mentions) behind the provenance gate.
F. Slice A / Translate: read argostranslate's real translate API and its import
   cost first; ask me before fetching a language pack.
G. Then TTS, Avatar, Save, workspace manager, PWA - each gated on my ruling per PRD 5.

STOP AND ASK, never guess:
Any guard, selftest or manage.py check goes non-zero and you cannot explain it from
the file. A patch is refused twice for the same reason. PRD.md contradicts the code.
You are about to install, download, migrate a schema, or delete anything. You reach
PRD 9 (Definition of 100%).
When stopping: state what you did, paste the output verbatim, say what you believe
and what you need. Never smooth over a refusal, traceback or wrong count - they are
findings.

Do not end the session. Wait for my feedback after every step. Never declare
completion without my confirmation.
