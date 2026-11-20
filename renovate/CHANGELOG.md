# Changelog

## 2026.11.20.2

* 🐛 Fixed: the mobile layout was wider than the screen. The resource profile box showed the old profile after a change. Changes in the app configuration now apply within seconds without a restart, and connections that cannot be applied are shown with the reason. New: Settings → App configuration → Compare now, and a "Restart needed" hint for extra packages and certificates.

## 2026.11.20.1

* 🐛 Fixed: the app did not start ("unable to open database file"). The database now lives in its own folder that the app user can write to.

## 2026.11.20

- ✨ First release (experimental). Renovate 44.256.1 with a web interface inside Home Assistant: connect GitHub, GitLab, Gitea or Forgejo, choose repositories, run on a schedule or on webhooks, follow every run live.
