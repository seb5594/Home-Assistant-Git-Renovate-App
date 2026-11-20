# Third-party notices

The code of this app is MIT licensed (see `LICENSE`). The image also contains software of other projects,
which keeps its own license.

| Component | License | Source |
| --- | --- | --- |
| Renovate, installed unmodified from the npm package `renovate` | AGPL-3.0, see `licenses/renovate-AGPL-3.0.txt` | <https://github.com/renovatebot/renovate> |
| The dependencies of Renovate, each with its license file in `/opt/renovate/node_modules` | various, mostly MIT, ISC, Apache-2.0 | <https://www.npmjs.com> |
| Node.js, npm and Git (Alpine packages) | MIT, Artistic-2.0, GPL-2.0 | <https://pkgs.alpinelinux.org> |
| Home Assistant base image with bashio and s6-overlay | Apache-2.0, MIT | <https://github.com/seb5594/home-assistant-base-multi-arch> |

The version of Renovate in this app is the one named in the `Dockerfile` (`RENOVATE_VERSION`). Its source
code is available at the address above under the tag of that release. Renovate is not modified; this app
only starts it, writes its configuration and shows its results.

This app is an independent community project. It is not affiliated with, endorsed or supported by Mend.io or
the Renovate project. "Renovate" is a trademark of its owners and is used here only to name the packaged software.
