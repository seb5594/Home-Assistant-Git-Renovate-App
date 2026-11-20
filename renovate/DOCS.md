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
| GitHub | `repo` and `workflow` (classic), or contents, pull requests, issues and workflows with write access (fine-grained) |
| GitLab | `api` and `write_repository` |
| Gitea, Forgejo | `write:repository`, `write:issue`, `read:user`, `read:organization` |

The pull requests are opened by the account the token belongs to. Create a separate account such as `renovate` for a clean history.

### Password (Gitea and Forgejo)

Enter your login once. The app asks the server for a token with exactly the permissions above and stores that token, encrypted. **Your password is not stored** and is used for this one request. With two-factor authentication the assistant asks for the current code. If you later remove the connection, delete the token (named `renovate-home-assistant-…`) in your server's settings; the app cannot do that without your password.

### The Gitea app of Home Assistant

The assistant looks for the Gitea app of [alexbelgium/hassio-addons](https://github.com/alexbelgium/hassio-addons) at `http://db21ed7f-gitea:3000` and offers its address. Other addresses work as well; use the one your server answers on from inside Home Assistant.

## Repositories

Each connection has a **mode**:

- **By hand** (default): only repositories you switch on are processed. New repositories stay off.
- **Automatically**: every repository the account can push to is processed, including new ones. Narrow it with *include* and *exclude* patterns (`my-org/*`, `**/archive-*`). Forks and archived repositories are skipped unless you change that.

A switch in the repository list always wins over the rules. The list is refreshed before every automatic run and whenever you press **Refresh list**.

## Schedule and runs

By default Renovate runs every six hours (`0 */6 * * *`). Choose a cron schedule, a fixed interval or manual runs only. Runs for different connections can overlap only if the resource profile allows parallel runs; two runs for the same connection never do.

A run starts from the schedule, from you (**Run now**, **Preview run**, or a single repository) or from a webhook. Requests for the same connection that arrive while a run waits are merged into one. A run that takes longer than the time limit is stopped, and **Cancel** stops one at any time.

## Webhooks

With webhooks the git server tells the app when something happens, so Renovate reacts within about a minute: after you merge a pull request, push to the default branch, or tick a box in the *Dependency Dashboard* issue. Events caused by Renovate itself are ignored.

1. Switch on **Webhooks → Receive webhooks**.
2. In the app's **Network** settings give port `8092` a number (or the port you chose).
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

The profile *Automatic* picks **Light** below 2 GB of memory, **Balanced** up to 6 GB and **Performance** above. Light runs one batch of three repositories at a time with 512 MB and a very low CPU priority; the other profiles give Renovate more room. Override single values under *Resources → Advanced*. The Settings page shows what is in effect for your machine.

If a run ends with *Renovate ran out of memory*, choose the Light profile or raise the memory per run.

## Configuration

Everything can be set in the web interface. Values written in the **app configuration** (Settings → Apps → Renovate → Configuration) win and show a lock in the interface. Use the configuration when you want your setup described in one place, and the interface for everything else.

### Connections in the configuration

```yaml
connections:
  - name: Home Gitea
    provider: gitea
    url: http://db21ed7f-gitea:3000
    token: !secret renovate_gitea_token
    repositories: sven/home-assistant-config, sven/esphome-devices
  - name: GitHub
    provider: github
    token: !secret renovate_github_token
    include: my-org/*
    exclude: my-org/archive-*
```

Connections defined here are created, updated and removed at every start and are read-only in the interface. With `repositories` only those are switched on; without, every repository the account can push to is processed, narrowed by `include` and `exclude`.

### Your own Renovate options

Put a JSON file in the app's configuration folder (`/addon_configs/<id>_renovate/`, reachable with the Samba or File editor apps) and name it under *Renovate → Configuration file in the app folder*. Its contents are merged over the app's defaults. Per connection there is a field for extra options in the connection's settings. Options the app controls itself (platform, endpoint, repositories, directories) cannot be overridden.

Repositories keep their own `renovate.json` as usual; it decides *what* is updated and how.

### Extra tools

The image contains Node.js, npm and Git. Renovate calls other tools to update lock files of other ecosystems. List their Alpine packages under *Advanced → Extra system packages*, for example `python3`, `py3-pip` or `go`. They are installed when the app starts.

### Certificates

For a server with a certificate of your own CA, put the CA file in `/ssl` (or the app's configuration folder) and enter its name under *Advanced → CA certificate*. As a last resort *Do not verify certificates* accepts anything.

## Options

<!-- options:begin -->

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

### Schedule

When Renovate runs by itself.

| Option | Description | Default |
| --- | --- | --- |
| `schedule.mode`<br>**Automatic runs** | Cron uses a schedule, interval repeats after a fixed time, manual never starts by itself. | `cron` |
| `schedule.cron`<br>**Cron schedule** | Five fields: minute hour day month weekday. 0 */6 * * * means every six hours. | `0 */6 * * *` |
| `schedule.interval_minutes`<br>**Interval (minutes)** | Used when automatic runs are set to Interval. | `360` |
| `schedule.run_on_start`<br>**Run when the app starts** | Start a run a moment after the app started. | `false` |

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

### History

How long runs and their logs are kept.

| Option | Description | Default |
| --- | --- | --- |
| `history.keep_runs`<br>**Runs to keep** | Older runs are removed. | `100` |
| `history.keep_log_days`<br>**Days to keep logs** | Runs older than this are removed with their logs. | `30` |

### Renovate

Defaults for all repositories. A renovate.json in a repository can override most of them.

| Option | Description | Default |
| --- | --- | --- |
| `renovate.dry_run`<br>**Dry run** | Off makes real changes. The other modes only look: extract finds dependencies, lookup also checks for updates, full simulates everything. | `off` |
| `renovate.onboarding`<br>**Onboarding pull request** | Open a "Configure Renovate" pull request in repositories without configuration. Off means Renovate needs no configuration, see below. | `true` |
| `renovate.onboarding_preset`<br>**Onboarding preset** | The preset written into the onboarding pull request. | `config:recommended` |
| `renovate.require_config`<br>**Configuration file** | Required: only repositories with a configuration are processed. Optional: repositories without one are processed with defaults. Ignored: repository files are not read. | `required` |
| `renovate.git_author`<br>**Commit author** | Name and address of the commits, as Name <address>. Empty uses Renovate's default. | automatic |
| `renovate.default_extends`<br>**Default presets** | Presets applied to every repository, for example group:allNonMajor. | none |
| `renovate.default_labels`<br>**Default labels** | Labels added to every pull request. | none |
| `renovate.pr_concurrent_limit`<br>**Open pull requests at once** | Maximum per repository. 0 means no limit. Empty uses Renovate's default. | automatic |
| `renovate.pr_hourly_limit`<br>**New pull requests per hour** | Maximum per repository. 0 means no limit. Empty uses Renovate's default. | automatic |
| `renovate.github_com_token`<br>**Token for github.com** | Lets Renovate read release notes and changelogs from GitHub without hitting rate limits. A token without any permissions is enough. | – |
| `renovate.host_rules`<br>**Credentials for registries** | Logins for private package sources such as a Docker registry or an npm proxy. | none |
| `renovate.config_file`<br>**Configuration file in the app folder** | A JSON file with Renovate options, placed in the app's configuration folder (addon_configs). Merged over the defaults above. | automatic |

### Webhooks

Let the git server trigger runs when something happens.

| Option | Description | Default |
| --- | --- | --- |
| `webhooks.enabled`<br>**Receive webhooks** | Opens a port that git servers can send events to. | `false` |
| `webhooks.port`<br>**Port** | Also enable this port in the network settings of the app. | `8092` |
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

Raise the log detail under *Advanced → Renovate log level* to `debug` for a run when you need more. Debug logs are large.

## Security

- The interface is only reachable through Home Assistant's ingress; every other address on the network is refused. State-changing requests need a header a foreign website cannot send.
- Tokens are encrypted in the database with a key stored next to it (`/data/keys`). A backup contains both, like the app configuration does.
- Renovate runs as an unprivileged user and receives only the variables it needs. The Home Assistant token never reaches it.
- Renovate executes package managers on your repositories. Only connect repositories you trust to this machine, and keep *Ignore scripts* (Renovate's default) in place.
