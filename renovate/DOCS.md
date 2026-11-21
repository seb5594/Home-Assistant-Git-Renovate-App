# Renovate

Renovate keeps the dependencies of your repositories up to date: it opens a pull request when a Docker image, a GitHub Action, an npm or Python package or one of [many other things](https://docs.renovatebot.com/modules/manager/) has a new version. This app runs it on your Home Assistant, with a web interface and a schedule.

**This app is experimental.** Please report problems with the run log attached (remove secrets first).

Contents: [How it works](#how-it-works) · [Quick start](#quick-start) · [Signing in](#signing-in) · [Repositories](#repositories) · [Schedule and runs](#schedule-and-runs) · [Webhooks](#webhooks) · [Home Assistant](#home-assistant) · [Resources](#resources) · [Configuration](#configuration) · [Options](#options) · [Troubleshooting](#troubleshooting) · [Security](#security)

## How it works

The web interface is the page of this app (**Open Web UI**, or *Renovate* in the sidebar). Home Assistant forwards it through *ingress*, so no port has to be opened and your Home Assistant login protects it. By default only administrators see it.

Behind it, a small server keeps your connections and settings in a SQLite database, starts Renovate on a schedule (or when a webhook arrives), and records every run: a result per repository and a log. Renovate runs one connection after another in small batches, so even a Raspberry Pi copes.

## Quick start

1. Start the app and open the web interface.
2. **Connect a git server**: choose the server type, sign in, choose repositories.
3. Run a **preview** first. It looks for updates and shows what would happen without changing anything.
4. Run it for real. In every repository without a Renovate configuration, Renovate opens a pull request named **Configure Renovate**. Merge it to switch Renovate on there.
5. Review the update pull requests as they arrive. You decide what gets merged.

## Signing in

### Sign in with a code (GitHub)

You get a short code, type it on github.com and confirm. No token to create or copy. This needs an OAuth app with *Enable Device Flow* switched on:

1. On GitHub open **Settings → Developer settings → OAuth Apps → New OAuth App**. Any name, any URL.
2. Tick **Enable Device Flow** and register the app.
3. Copy the **Client ID** into the option **Advanced → GitHub OAuth client ID** and restart the app.

Without a client ID the assistant offers the token method for GitHub instead. A published release of this app can ship its own client ID; see `providers/github.mjs`.

### Token

For GitHub and GitLab the assistant opens the token page with the name and permissions already filled in. Create the token, copy it and paste it into the assistant.

| Server | Permissions the token needs |
| --- | --- |
| GitHub | `repo` and `workflow` (classic), or, fine-grained: contents, pull requests, issues, workflows, commit statuses and checks with read and write access, metadata with read access |
| GitLab | `api` and `write_repository` |
| Gitea, Forgejo | `write:repository`, `write:issue`, `read:user`, `read:organization`, `read:misc` (`read:misc` is only needed by Gitea 1.20.0 and 1.20.1). Add `read:packages` if you use Gitea packages. |

On Gitea and Forgejo the account should have its **full name and email address** set; Renovate uses them for its commits, and the assistant warns when they are missing. Renovate skips mirrors and repositories with pull requests switched off. Choose the server type *Forgejo* for Forgejo and Codeberg: Renovate is removing Forgejo support from its Gitea platform.

The pull requests are opened by the account the token belongs to. Create a separate account such as `renovate` for a clean history.

### Password (Gitea and Forgejo)

Enter your login once. The app asks the server for a token with exactly the permissions above and stores that token, encrypted. **Your password is not stored** and is used for this one request. With two-factor authentication the assistant asks for the current code. If you later remove the connection, delete the token (named `renovate-home-assistant-…`) in your server's settings; the app cannot do that without your password.

### Browser sign-in (passkey, YubiKey, SSO)

For **Gitea, Forgejo and GitLab**. You sign in on the page of your server itself, so everything that page accepts works: password, a **passkey**, a **security key such as a YubiKey 5 NFC**, single sign-on. The app never sees your password. This is the way for accounts that have a security key enrolled, because those cannot create a token with their password.

It works from any device and needs no public address. Once per server:

1. In the assistant choose *Passkey, security key or SSO*. It shows what to enter and links to the application settings of your server (Gitea: *Settings → Applications*, GitLab: *Preferences → Applications*).
2. Create an **OAuth2 application** named `Renovate` with the redirect URI `http://127.0.0.1:5594/callback` and **Confidential client switched off** (a public client, no secret). GitLab additionally needs the scopes `api` and `write_repository`. Copy the **client ID** the server shows.
3. Paste the client ID, press *Prepare the sign-in* and open the sign-in page. Sign in as you always do (passkey, YubiKey on the back of the phone, ...) and approve.
4. The browser then shows an error page, because it tries to open `127.0.0.1`. That is expected. Copy the **address of that page** from the address bar and paste it into the assistant.

The tokens of such a sign-in expire after an hour (Gitea) or two (GitLab). The app renews them with the refresh token **before every run and every batch**, so a run never starts with a dying token. If the server revokes the sign-in or the refresh token expires (Gitea: 30 days without a run), the run fails with a hint, and the connection has to be added anew.

### The Gitea app of Home Assistant

The assistant looks for the Gitea app of [alexbelgium/hassio-addons](https://github.com/alexbelgium/hassio-addons) at `http://db21ed7f-gitea:3000` and offers its address. Other addresses work as well; use the one your server answers on from inside Home Assistant.

### Other servers

| Server | What the assistant asks for |
| --- | --- |
| Bitbucket Cloud | Your **user name** and an **API token** with the scopes for repositories, pull requests, user and workspace (read and write). Renovate also wants a workspace group with *Create repositories* permission that contains the account. |
| Bitbucket Server / Data Center | The address of your server and an **HTTP access token** of the account |
| Azure DevOps | The address of your organization (`https://dev.azure.com/my-organization`, or your Server collection) and a **personal access token** with *Code* and *Work Items* read and write |
| Gerrit | The address of the server, your **user name** and the **HTTP password** of the account. For automerge the account must be allowed to give Code-Review +2. |
| SCM-Manager 3 | The address including `/scm` and an **API key** of the account; the Review plugin from version 3.11 must be installed |

These servers are **beta**: built from Renovate's documentation and tested against recorded API answers, not against real installations. They have no webhooks. Repository names follow Renovate's format (`workspace/repo`, `PROJECT/repo`, `Project/Repo`).

## Repositories

Each connection has a **mode**:

- **By hand** (default): only repositories you switch on are processed. New repositories stay off.
- **Automatically**: every repository the account can push to is processed, including new ones. Narrow it with *include* and *exclude* patterns (`my-org/*`, `**/archive-*`). Forks and archived repositories are skipped unless you change that.

A switch in the repository list always wins over the rules. The list is refreshed before every automatic run and whenever you press **Refresh list**.

## Updates: what is merged automatically

Every update has a kind: **major** (1.x to 2.x), **minor** (1.1 to 1.2) or **patch** (1.1.1 to 1.1.2). Digests and pins follow the patch setting. Under *Settings → Updates and merging* you choose, for each kind, one of these actions:

| Action | What happens |
| --- | --- |
| As the repository decides (default) | The app adds nothing. The repository's own `renovate.json` applies, so existing setups keep working. |
| Pull request, I merge | A pull request is opened. Renovate never merges it. |
| Ask me first | The update is only listed in the *Dependency Dashboard* issue of the repository and gets its pull request when you tick it. |
| Merge automatically | A pull request is opened and merged as soon as its checks are green. |
| Skip | The update is not offered at all. |

Four **recipes** fill the options in one click (under *Settings → Updates and merging* and in the guide of the web interface):

| Recipe | Major | Minor and patch | Also |
| --- | --- | --- | --- |
| Careful | pull request | pull request | |
| Balanced (recommended) | pull request | merged automatically | a release must be 3 days old |
| Quiet | ask first | merged automatically, one pull request for all | a release must be 3 days old |
| Hands off | merged automatically | merged automatically | a release must be 3 days old |

"Balanced" is the answer to "merge everything except major updates by itself". Notes:

- Renovate merges only when the checks of the pull request are green. A repository without any checks has nothing that can stop a bad update, so be careful there and protect the default branch.
- The settings of the app are package rules. A repository can still make exceptions with its own `packageRules` in its `renovate.json`; rules written there win. A plain `"automerge": false` at the top level of a repository does **not** win against a rule of the app, because package rules are applied on top of it.
- *Wait after a release* holds back versions that are younger than the given days. Versions without a release date are not held back.

An example of an exception in a repository:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "packageRules": [
    { "matchPackageNames": ["react"], "matchUpdateTypes": ["major"], "enabled": false },
    { "matchManagers": ["github-actions"], "automerge": true }
  ]
}
```

## Your own account for commits, issues and pull requests

Everything Renovate does is done as the account behind the token: pull requests, issues, comments and commits. Give it its own account, for example `renovate-bot`:

1. Create the account on your git server (GitHub: a normal free account; GitLab, Gitea, Forgejo: a regular user).
2. Give it access: add it as a collaborator with write access, or to an organization through a team with write access.
3. Sign in as that account, create the token (see [Token](#token)) and use it for the connection. Not your own token.
4. Optional, for the author of the commits only: *Settings → Renovate → Commit author*, for example `Renovate Bot <renovate-bot@example.org>`. Left empty, Renovate uses the name and address of the account. For GitHub to show the account's picture on the commits, use its no-reply address `ID+USERNAME@users.noreply.github.com` (the ID is at `https://api.github.com/users/USERNAME`).

Pull requests and issues always carry the name of the account behind the token. The commit author setting changes the commits only. A GitHub App is not supported: the app works with tokens.

## Coming from the Mend Renovate app

The free cloud app of Mend and this app use the same Renovate. Your `renovate.json` (also `.github/renovate.json`) keeps working as it is. Three things to know:

- **Uninstall the Mend app** from the repositories or the organization. Otherwise two bots work on the same branches.
- **Old pull requests look "edited".** Their commits have another author than the new account, and Renovate leaves branches alone that someone else has changed. The app therefore ignores the commits of the Mend bot by default (*Settings → Renovate → Ignored commit authors*, `29139614+renovate[bot]@users.noreply.github.com`). If a branch is still marked *Edited/Blocked* in the Dependency Dashboard, tick its rebase box, or close the pull request and delete the branch.
- Repositories that already have a configuration get no onboarding pull request again.

## One setup for many repositories

With many repositories you do not want to repeat yourself. Three layers each have their own job, and the lower one wins:

| Layer | Job | Where |
| --- | --- | --- |
| The app | **Who and how much**: commit author, labels, update actions and recipes, limits, onboarding, registry tokens, when Renovate runs | *Settings*, applies to every repository |
| A shared preset | **What is updated and how**: package rules, grouping, version rules, custom managers that all repositories share | One repository, for example `owner/renovate-config` with a `default.json`, named under *Settings → Renovate → Default presets* as `github>owner/renovate-config` (`local>owner/renovate-config` on your own server) |
| The repository | **Only the exceptions** of that project | `.github/renovate.json`, can be nearly empty |

A repository that uses the shared preset needs only this:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>owner/renovate-config"]
}
```

The alternative is a full copy of the shared file in every repository, kept in step by a script. That also works when the preset repository is private (Renovate does not load a preset from a private repository into a public one), but every change has to reach every repository.

**Recommended settings** for a setup like this:

| Setting | Recommendation | Why |
| --- | --- | --- |
| Configuration file | `required` | Only repositories that carry a Renovate file are touched. Switch the onboarding pull request off if all of them have one. |
| Commit author and account | A dedicated account, for example `Renovate Bot <renovate-bot@example.org>` | A clean history, see [above](#your-own-account-for-commits-issues-and-pull-requests) |
| Update actions | Recipe *Balanced* | Small updates merge by themselves, major updates wait for you |
| Open pull requests at once | 6 to 10 | Keeps the review queue short |
| New pull requests per hour | 0 (no limit) | The runs are hours apart anyway |
| Default labels | `dependencies` | One label for every pull request |
| Token for github.com | A token without scopes | Release notes in the pull requests, no rate limits, also for repositories on other servers |

**The schedule.** There are two, and they do different things. The schedule of the app (*Settings → Schedule*) decides when Renovate **looks**. A `schedule` in a repository's file (for example `"before 6am on monday"`) decides when Renovate may **open pull requests**. A run outside that window only updates the Dependency Dashboard issue, which looks exactly like "issues, but no pull requests". Either leave the repository schedule out and let the app decide, or run the app inside the window, for example `0 4 * * 1` (Monday, 04:00 in the time zone set under *Appearance → Time zone*).

## Schedule and runs

By default Renovate runs every six hours (`0 */6 * * *`). Choose a cron schedule, a fixed interval or manual runs only. Runs for different connections can overlap only if the resource profile allows parallel runs; two runs for the same connection never do.

A run starts from the schedule, from you (**Run now**, **Preview run**, or a single repository) or from a webhook. Requests for the same connection that arrive while a run waits are merged into one. A run that takes longer than the time limit is stopped, and **Cancel** stops one at any time.

## Webhooks

With webhooks (GitHub, GitLab, Gitea and Forgejo) the git server tells the app when something happens, so Renovate reacts within about a minute: after you merge a pull request, push to the default branch, or tick a box in the *Dependency Dashboard* issue. Events caused by Renovate itself are ignored.

1. Switch on **Webhooks → Receive webhooks**.
2. In the app's **Network** settings give port `5594` a number (or the port you chose). The default is 5594, and the port stays closed until you open it.
3. Make that port reachable from your git server, for example through a reverse proxy, and enter the address as **Public address**.
4. Open the connection, tab **Webhooks**, and press **Set up in all switched-on repositories**. The address and secret are shown for manual setup as well.

Deliveries are verified with the secret of the connection (HMAC signature, or the secret token for GitLab).

## Home Assistant

- `sensor.renovate_status`: `idle`, `running` or `error`, with the next run time.
- `sensor.renovate_open_pull_requests`: how many pull requests Renovate has open, per connection in the attributes.
- `sensor.renovate_last_run`: when the last run finished and its result.
- The event `renovate_run_finished` after every run, with `status`, `connection`, `pull_requests_created`, `pull_requests_updated` and `errors`.

```yaml
automation:
  - alias: Tell me about new dependency updates
    triggers:
      - trigger: event
        event_type: renovate_run_finished
    conditions:
      - condition: template
        value_template: "{{ trigger.event.data.pull_requests_created > 0 }}"
    actions:
      - action: notify.notify
        data:
          message: "Renovate opened {{ trigger.event.data.pull_requests_created }} pull request(s) for {{ trigger.event.data.connection }}."
```

The sensors are created through the Core API and do not have a unique ID. They disappear when Home Assistant restarts and come back as soon as the app updates them again, a few seconds after its start.

## Resources

The profile *Automatic* looks at the memory of the machine Home Assistant runs on, not at what the app may use: **Light** below 2 GB, **Balanced** up to 6 GB and **Performance** above. On a mini PC or server with plenty of memory, *Automatic* therefore means *Performance*; choose *Light* by hand if the machine should stay free for other things. Light runs one batch of three repositories at a time with 512 MB and a very low CPU priority; the other profiles give Renovate more room. Override single values under *Resources → Advanced*. The Settings page shows what is in effect for your machine.

If a run ends with *Renovate ran out of memory*, choose the Light profile or raise the memory per run.

## Configuration

Everything can be set in the web interface. Values written in the **app configuration** (Settings → Apps → Renovate → Configuration) win and show a lock in the interface. Use the configuration when you want your setup described in one place, and the interface for everything else.

**Changes in the configuration apply within seconds, without a restart.** Home Assistant writes the saved configuration to the app, which notices it, applies the new values. Only *Extra system packages* and *CA certificate* are read when the app starts; the interface then shows **Restart needed**. If the configuration cannot be read or an entry is not valid, the pages of the interface say so, and **Settings → App configuration → Compare now** checks again at any time.

Connections are created in the web interface (the setup assistant), not in the app configuration: a git server needs a sign-in, and the assistant is the place that can check it and tell you what is wrong.

### Your own Renovate options

Put a JSON file in the app's configuration folder (`/addon_configs/<id>_renovate/`, reachable with the Samba or File editor apps) and name it under *Renovate → Configuration file in the app folder*. Its contents are merged over the app's defaults. Per connection there is a field for extra options in the connection's settings. Options the app controls itself (platform, endpoint, repositories, directories) cannot be overridden.

Repositories keep their own `renovate.json` as usual; it decides *what* is updated and how.

### Extra tools

The image contains Node.js, npm and Git. Renovate calls other tools to update lock files of other ecosystems. List their Alpine packages under *Advanced → Extra system packages*, for example `python3`, `py3-pip` or `go`. They are installed when the app starts.

### Certificates

For a server with a certificate of your own CA, put the CA file in `/ssl` (or the app's configuration folder) and enter its name under *Advanced → CA certificate*. As a last resort *Do not verify certificates* accepts anything.

## Options

<!-- options:begin -->

### Renovate

Defaults for all repositories. A renovate.json in a repository can override most of them.

| Option | Description | Default |
| --- | --- | --- |
| `renovate.dry_run`<br>**Dry run** | Off makes real changes. The other modes only look: extract finds dependencies, lookup also checks for updates, full simulates everything. | `off` |
| `renovate.onboarding`<br>**Onboarding pull request** | Open a "Configure Renovate" pull request in repositories without configuration. Off means Renovate needs no configuration, see below. | `true` |
| `renovate.onboarding_preset`<br>**Onboarding preset** | The preset written into the onboarding pull request. | `config:recommended` |
| `renovate.require_config`<br>**Configuration file** | Required: only repositories with a configuration are processed. Optional: repositories without one are processed with defaults. Ignored: repository files are not read. | `required` |
| `renovate.git_author`<br>**Commit author** | Name and address of the commits, as Name <address>. Empty uses Renovate's default. | automatic |
| `renovate.ignored_authors`<br>**Ignored commit authors** | Commits by these authors do not count as manual edits. The default is the Mend Renovate app, so pull requests it opened can be taken over. | `29139614+renovate[bot]@users.noreply.github.com` |
| `renovate.default_extends`<br>**Default presets** | Presets applied to every repository, for example group:allNonMajor. | none |
| `renovate.default_labels`<br>**Default labels** | Labels added to every pull request. | none |
| `renovate.pr_concurrent_limit`<br>**Open pull requests at once** | Maximum per repository. 0 means no limit. Empty uses Renovate's default. | automatic |
| `renovate.pr_hourly_limit`<br>**New pull requests per hour** | Maximum per repository and run. 0 means no limit. Renovate's own default is 2, which with a run every few hours opens only two new pull requests per repository each time. | `0` |
| `renovate.github_com_token`<br>**Token for github.com** | Lets Renovate read release notes and changelogs from GitHub without hitting rate limits. A token without any permissions is enough. | – |
| `renovate.host_rules`<br>**Credentials for registries** | Logins for private package sources such as a Docker registry or an npm proxy. | none |
| `renovate.config_file`<br>**Configuration file in the app folder** | A JSON file with Renovate options, placed in the app's configuration folder (addon_configs). Merged over the defaults above. | automatic |

### Updates and merging

What happens to each kind of update: a pull request for you to merge, an automatic merge, a question first, or nothing. Applies to all repositories; a repository can still make exceptions in its own renovate.json.

| Option | Description | Default |
| --- | --- | --- |
| `updates.major`<br>**Major updates** | New versions that may break things, for example 1.x to 2.x. | `repository` |
| `updates.minor`<br>**Minor updates** | New features that should stay compatible, for example 1.1 to 1.2. | `repository` |
| `updates.patch`<br>**Patch updates** | Bug fixes and small changes, for example 1.1.1 to 1.1.2. Digests and pins follow this setting. | `repository` |
| `updates.group_non_major`<br>**One pull request for minor and patch** | Combines all minor and patch updates of a repository into a single pull request. Works best when both use the same action. | `false` |
| `updates.minimum_age_days`<br>**Wait after a release (days)** | A version is offered only after it has been out this long, so broken releases are found by others first. 0 switches the wait off. | `0` |
| `updates.merge_method`<br>**Merge method** | How automatic merges are made. Automatic uses what the repository allows. | `auto` |
| `updates.dashboard`<br>**Dependency Dashboard** | One issue per repository that lists all pending updates. Empty leaves it to the repository. It is always on while an action is set to "Ask me first". | automatic |

### History

How long runs and their logs are kept.

| Option | Description | Default |
| --- | --- | --- |
| `history.keep_runs`<br>**Runs to keep** | Older runs are removed. | `100` |
| `history.keep_log_days`<br>**Days to keep logs** | Runs older than this are removed with their logs. | `30` |

### Resources

How much of this machine a run may use. The automatic profile fits the memory of your system.

| Option | Description | Default |
| --- | --- | --- |
| `resources.profile`<br>**Resource profile** | Light for a Raspberry Pi, Balanced for most systems, Performance for strong machines. Automatic chooses by memory. | `auto` |
| `resources.max_concurrent_runs`<br>**Parallel runs** | How many connections are processed at the same time. Overrides the profile. | automatic |
| `resources.memory_limit_mb`<br>**Memory per run (MB)** | Upper limit for the memory of one Renovate process. Overrides the profile. | automatic |
| `resources.batch_size`<br>**Repositories per batch** | Renovate is restarted after this many repositories, which keeps memory low. Overrides the profile. | automatic |
| `resources.cpu_priority`<br>**CPU niceness** | 0 is normal, 19 is the most considerate. Higher values keep Home Assistant responsive. Overrides the profile. | automatic |
| `resources.run_timeout_minutes`<br>**Time limit per run (minutes)** | A run that takes longer is stopped. | `90` |

### Schedule

When Renovate runs by itself.

| Option | Description | Default |
| --- | --- | --- |
| `schedule.mode`<br>**Automatic runs** | Cron uses a schedule, interval repeats after a fixed time, manual never starts by itself. | `cron` |
| `schedule.cron`<br>**Cron schedule** | Five fields: minute hour day month weekday. 0 */6 * * * means every six hours. | `0 */6 * * *` |
| `schedule.interval_minutes`<br>**Interval (minutes)** | Used when automatic runs are set to Interval. | `360` |
| `schedule.run_on_start`<br>**Run when the app starts** | Start a run a moment after the app started. | `false` |

### Webhooks

Let the git server trigger runs when something happens.

| Option | Description | Default |
| --- | --- | --- |
| `webhooks.enabled`<br>**Receive webhooks** | Opens a port that git servers can send events to. | `false` |
| `webhooks.port`<br>**Port** | Also enable this port in the network settings of the app. | `5594` |
| `webhooks.public_url`<br>**Public address** | The address your git server uses to reach the port, for example https://hooks.example.org. Without it, webhooks cannot be set up automatically. | automatic |
| `webhooks.debounce_seconds`<br>**Wait before running (seconds)** | Events within this time are combined into one run. | `60` |
| `webhooks.ignore_own_events`<br>**Ignore events caused by Renovate** | Prevents Renovate's own pull requests from starting new runs in a loop. | `true` |

### Home Assistant

What the app reports to Home Assistant.

| Option | Description | Default |
| --- | --- | --- |
| `home_assistant.sensors`<br>**Sensors** | Creates sensor.renovate_status, sensor.renovate_open_pull_requests and sensor.renovate_last_run. | `true` |
| `home_assistant.events`<br>**Events** | Fires the event renovate_run_finished after every run, for automations. | `true` |
| `home_assistant.failure_notification`<br>**Notify on failure** | Shows a notification in Home Assistant when a run fails. | `false` |

### Appearance

Language, colors and logging.

| Option | Description | Default |
| --- | --- | --- |
| `general.language`<br>**Language** | Auto follows Home Assistant. | `auto` |
| `general.theme`<br>**Theme** | Auto follows Home Assistant, then your system. | `auto` |
| `general.accent`<br>**Accent color** | Blue is the default. Home Assistant uses the primary color of your Home Assistant theme. | `blue` |
| `general.accent_color`<br>**Custom accent color** | Used when the accent color is set to Custom. Format #RRGGBB. | automatic |
| `general.log_level`<br>**Log level of the app** | How much the app writes to its log. Renovate's own detail level is set under Advanced. | `info` |
| `general.timezone`<br>**Time zone** | Used for the schedule, for example Europe/Berlin. Empty uses the time zone of Home Assistant. | automatic |

### Advanced

For special setups: certificates, extra tools, environment variables.

| Option | Description | Default |
| --- | --- | --- |
| `advanced.renovate_log_level`<br>**Renovate log level** | Detail level of the run logs. Debug is very verbose. | `info` |
| `advanced.extra_packages`<br>**Extra system packages** | Alpine packages installed when the app starts, for example python3, py3-pip or go. Needed when Renovate has to run those tools to update lock files. *(Only in the app configuration)* | none |
| `advanced.extra_env`<br>**Extra environment variables** | Passed to every Renovate run, for example proxy or registry settings. | none |
| `advanced.ca_certificate`<br>**CA certificate** | File name of a certificate authority in /ssl or in the app folder. Needed for servers with a self-made certificate. *(Only in the app configuration)* | automatic |
| `advanced.insecure_tls`<br>**Do not verify certificates** | Accepts any certificate. Insecure: prefer providing the CA certificate. *(Only in the app configuration)* | `false` |
| `advanced.github_client_id`<br>**GitHub OAuth client ID** | Use your own GitHub OAuth app (with device flow enabled) for the sign-in with a code. *(Only in the app configuration)* | automatic |

<!-- options:end -->

## Troubleshooting

| Message in the run | What to do |
| --- | --- |
| The git server rejected the token | The token expired or was revoked. Create a new one and replace it in the connection's settings. |
| The server could not be reached | Check the address. A Home Assistant app is reachable by its internal name only from inside Home Assistant. |
| The certificate is not trusted | Provide the CA certificate, see [Certificates](#certificates). |
| The server limits how often it can be asked | Add a token for github.com under *Renovate → Token for github.com*, or run less often. |
| Renovate ran out of memory | Use the Light profile, lower the batch size or raise the memory per run. |
| No repositories are switched on | Open the connection and switch repositories on. |
| Done with problems | Open the run and look at the repositories marked with errors. |

### Issues appear, but no pull requests

Open the latest run: the yellow box of a repository names the reason. The usual causes, from most to least likely:

1. **A branch or pull request was changed by someone else**, or was opened by another bot account (see [Coming from the Mend Renovate app](#coming-from-the-mend-renovate-app)).
2. **The token cannot create pull requests.** Issues work and pull requests fail when the token lacks the pull request permission (see [Token](#token)).
3. **An action waits for you.** *Ask me first* shows the update only in the Dependency Dashboard issue until you tick it.
4. **Dry run** is not *Off* (*Settings → Renovate*). Renovate then only looks.
5. **A schedule in the repository** (`"schedule"` in its `renovate.json`) restricts when pull requests are opened.
6. **Limits.** The number of open pull requests (10 per repository by default) or the wait after a release.

Raise the log detail under *Advanced → Renovate log level* to `debug` for a run when you need more. Debug logs are large.

## Security

- The interface is only reachable through Home Assistant's ingress; every other address on the network is refused. State-changing requests need a header a foreign website cannot send.
- Tokens are encrypted in the database with a key stored next to it (`/data/keys`). A backup contains both, like the app configuration does.
- The server runs with the rights of the container, because Home Assistant keeps the app configuration readable for root only and the app follows it live. **Renovate itself always starts as an unprivileged user** and receives only the variables it needs. The Home Assistant token never reaches it.
- Renovate executes package managers on your repositories. Only connect repositories you trust to this machine, and keep *Ignore scripts* (Renovate's default) in place.
