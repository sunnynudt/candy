# Read-only workspace fixture

This Candy-owned fixture defines the first read-only tool boundary.

- Reads inside this directory are allowed without approval.
- Traversal, symlink or reparse-point escape, mutation, and Shell execution are rejected.
- The fixture contains no provider credential or private source.
