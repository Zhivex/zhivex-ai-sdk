---
"@zhivex-ai/sandbox-docker": patch
"@zhivex-ai/openai": patch
"@zhivex-ai/azure-openai": patch
---

Close sandbox escapes and resource leaks. Workspace reads refuse symlink escapes, snapshot run ids cannot be `.` or `..`, command process groups are killed on return, and the allowlist proxy enforces connection and byte quotas. Sweep deletes only containers with a matching owner and fingerprint. Expired leases drop snapshots, docker-commit images stay referenced until deletion succeeds, and CPU and PID limits are part of the environment fingerprint. OpenAI and Azure apply-patch containment now uses realpath.
