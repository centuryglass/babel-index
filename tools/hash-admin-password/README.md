# tools/hash-admin-password

Prints an `ADMIN_PASSWORD_HASH` value for the admin log viewer
(`packages/server/admin-auth.ts`, `/admin/logs`).

## Run

```sh
npm run hash-admin-password
```

Prompts twice, with the terminal echo off, and prints one line: `salt:hash`
(both hex, from `node:crypto`'s `scryptSync`). Paste it into
`ADMIN_PASSWORD_HASH` wherever the server's environment is set (see
`deploy/README.md`) and restart the service. The plaintext password is never
written anywhere - not to disk, not to shell history (the prompt is
interactive, not a CLI argument) - only this hash is.

Run it again to rotate the password; the old hash is simply overwritten
wherever you pasted it.
