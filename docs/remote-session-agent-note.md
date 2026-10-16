# Remote Session design note

The server plugin consumes the official `sessionPersistence` service. `persist.open` delegates write ownership to the backend's `SessionHandle` lease and forwards `SessionAlreadyOwnedError`; the plugin has no lock files and no alternate JSONL format. Standalone profiles keep a small workspace index, while profiles with `workspaceRegistry` use the official registry directly.
