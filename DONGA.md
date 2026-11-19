# Đông A's Metabase

This is Đông A's fork of [Metabase](https://github.com/metabase/metabase). Branch `donga/v0.65.2` is upstream's tag
`v0.65.2` plus one change: **Đông A OS signs people in to Metabase.** Whoever is signed in to the OS opens Metabase as
that same person, with Metabase groups that follow their OS roles. There is no Metabase login page and no extra step.

The fork is public, as upstream is. No secret ever goes in it.

## What we changed

| File | What |
|---|---|
| `src/metabase/sso/api/donga.clj` | New. `GET /auth/donga`: checks the door's secret, then signs the person in and redirects. |
| `src/metabase/sso/providers/donga.clj` | New. Đông A OS as an identity provider: reads the person from the headers, finds or creates the user, maps OS roles to groups. |
| `src/metabase/sso/auth_wrapper.clj` | Mounts `/auth/donga` beside Slack Connect, the other OSS sign-in route. |
| `src/metabase/sso/init.clj` | Loads the provider. |
| `src/metabase/sso/db.clj` | Three small queries: `user-in-group?`, `group-by-name`, `insert-group!`. |
| `.clj-kondo/config/modules/config.edn` | The sso module now uses the PermissionsGroup models. |
| `test/metabase/sso/api/donga_test.clj` | New. Tests for all of the above. |
| `donga/Dockerfile` | New. Upstream's own `metabase/metabase:v0.65.2` image (pinned by digest) with `/app/metabase.jar` replaced. |
| `.github/workflows/donga.yml` | Our only workflow. Upstream's 97 workflows are deleted on this branch. |
| `DONGA.md` | This file. |

Everything else is upstream's, unchanged.

## How sign-in works

Metabase sits behind Đông A OS's door, a Caddy server (`infra/metabase/Caddyfile` in `Dong-A-Haus/donga-os`). For
every request except the public signed-embed paths, the door:

1. drops any `X-Donga-*` header the browser sent;
2. asks the OS's gate who is signed in, and refuses anyone the OS refuses (it fails closed);
3. copies the gate's identity headers onto the request and adds `X-Donga-Door`, a secret it shares with Metabase.

When there is no Metabase session yet, the door sends the request to `/auth/donga`. The headers are:

| Header | Value (each percent-encoded UTF-8, as JavaScript's `encodeURIComponent` writes it) |
|---|---|
| `X-Donga-Door` | The shared secret, env `MB_DONGA_DOOR_SECRET` on both sides. |
| `X-Donga-User` | The OS login. Kept as the AuthIdentity's `provider_id`. |
| `X-Donga-Email` | The person's email. Metabase finds the user by it. |
| `X-Donga-Name` | The name people see. Optional. |
| `X-Donga-Roles` | The OS roles, each encoded, joined by `,`. |
| `X-Donga-Redirect` | Set by the door for a page asked for with no session: where to land. |

`GET /auth/donga?redirect=<path>` then does this:

- With `MB_DONGA_DOOR_SECRET` unset, or shorter than 32 characters, it answers 404. The route is off.
- If `X-Donga-Door` is not that secret, it answers 403. The compare is constant-time, over SHA-256 digests.
- If the landing place could leave this origin (a scheme, `//host`, a backslash or a control character), it answers 400.
  Metabase's own sign-in pages land on `/`.
- Otherwise it finds or creates the user, marked as from Đông A OS: `sso_source` is `donga`, plus an AuthIdentity
  with provider `donga`.
- It sets the user's groups from their roles:
  - OS role `CEO` is the Administrators group, so admin.
  - Every other role is the group of the same name, created when missing.
  - A role the OS took away is gone at the next sign-in. That includes admin.
- It makes the session and sets cookies exactly as Metabase's password login does: `metabase.SESSION` (HttpOnly)
  and `metabase.TIMEOUT`. Then it redirects.

It never signs in a Metabase account the OS did not make, such as the break-glass admin or a password user (403).
Password login stays upstream's. Đông A's door blocks it from the outside, so the break-glass admin uses it only on
the machine itself.

Known limits:

- Group membership for OS people follows their OS roles exactly. Changes made by hand in Metabase's admin are put
  back at their next sign-in.
- A new role's group starts with Metabase's default permissions for a new group.
- A person deactivated in Metabase stays deactivated. The OS does not reactivate them.

## Rebuild

Push to `donga/v0.65.2`, or run the workflow by hand: Actions → "Đông A build" → Run workflow. The workflow:

1. runs `./bin/test-agent --oss :only '[metabase.sso.api.donga-test]'`;
2. builds the jar with `MB_EDITION=oss ./bin/build.sh '{:version "v0.65.2-donga.<run>"}'`;
3. starts it and checks that `/auth/donga` refuses a request without the door;
4. pushes `ghcr.io/dong-a-haus/metabase:v0.65.2-donga.<run>` for linux/amd64 and linux/arm64, labelled
   `org.opencontainers.image.revision=<fork commit>`. This proves the jar runs in upstream's image on both;
5. publishes the jar, `metabase.jar.sha256` and `donga/Dockerfile` as the GitHub release `v0.65.2-donga.<run>` at the
   fork commit.

The box does not pull from ghcr: the package is private, and a box should not hold a GitHub token. The repo is public,
so donga-os `infra/metabase/setup.sh` downloads the release's jar and Dockerfile with no login, checks the jar against
the sha256 that `infra/metabase/compose.yaml` pins (its `DONGA_JAR_SHA256` line), and builds
`donga/metabase:v0.65.2-donga.<run>` on the box. The run's summary shows that sha256; to move donga-os to a new build,
change the image tag and the `DONGA_JAR_SHA256` line in that compose.yaml.

To build locally, with Java 25, the Clojure CLI, Node and bun, and uv:

```sh
MB_EDITION=oss ./bin/build.sh '{:version "v0.65.2-donga.local"}'
cp target/uberjar/metabase.jar /tmp/mbimg/
docker build -f donga/Dockerfile -t donga/metabase:local /tmp/mbimg
```

## Roll back to upstream

1. In donga-os `infra/metabase/compose.yaml`, set the Metabase image back to `metabase/metabase:v0.65.2`.
2. Recreate the Metabase container.

The application database is the same: this change adds no migration. Users the OS made keep their accounts and
groups. With upstream's image `/auth/donga` is gone, so people reach Metabase's login page. Only the break-glass
admin has a password.

## Move to a newer upstream version

1. Fetch the new tag, shallow: `git fetch --depth 1 upstream tag vX.Y.Z`.
2. Branch `donga/vX.Y.Z` from it.
3. Cherry-pick this branch's commits on top.
4. Bump the version in `donga/Dockerfile` (tag and digest) and in `.github/workflows/donga.yml`.
5. Make the new branch the default.
