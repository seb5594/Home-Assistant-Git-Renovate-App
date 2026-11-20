ARG BUILD_FROM=ghcr.io/seb5594/home-assistant-base:3.24-2026.11.0@sha256:d116b9e5b612e6fcd997c86642d21b61953fcbe390c39c9b03443a577ed5e2a6

# Node.js runs Renovate and the app's own server; Git is what Renovate shells out to for every repository.
# renovate: datasource=repology depName=alpine_3_24/nodejs
ARG NODEJS_VERSION=24.22.3-r0
# renovate: datasource=repology depName=alpine_3_24/npm
ARG NPM_VERSION=11.12.1-r0
# renovate: datasource=repology depName=alpine_3_24/git
ARG GIT_VERSION=2.54.1-r0

# Renovate is published as an npm package and as a container image under the same version number. The image
# tag is what the release pipeline follows (see .github/workflows/upstream.yml): a new Renovate release raises
# this line, the app version and the changelog by itself. The package is installed from npm below, because the
# official image is built for glibc and this base image uses musl.
# renovate: datasource=docker depName=ghcr.io/renovatebot/renovate
ARG RENOVATE_VERSION=44.256.1

FROM ${BUILD_FROM} AS engine

ARG NODEJS_VERSION
ARG NPM_VERSION
ARG RENOVATE_VERSION

RUN apk add --no-cache \
    nodejs=${NODEJS_VERSION} \
    npm=${NPM_VERSION}

# Scripts are skipped on purpose: Renovate's only native module (re2, a regular expression engine) would have to
# be compiled for musl, which needs a compiler and minutes of build time on every architecture. Renovate falls
# back to the built-in engine (RENOVATE_X_IGNORE_RE2). Everything that is only useful for development is removed:
# source maps, type declarations, documentation and tests take about half of the installed size.
RUN npm install --prefix /opt/renovate --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error "renovate@${RENOVATE_VERSION}" \
    && rm -rf /opt/renovate/node_modules/re2 /root/.npm \
    && find /opt/renovate/node_modules -type f \
        \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.md' -o -name '*.markdown' -o -name '*.tsbuildinfo' -o -name 'CHANGELOG*' \) -delete \
    && find /opt/renovate/node_modules -type d \
        \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name examples \) -prune -exec rm -rf {} + \
    && RENOVATE_X_IGNORE_RE2=true node /opt/renovate/node_modules/renovate/dist/renovate.js --version

FROM ${BUILD_FROM}

ARG NODEJS_VERSION
ARG NPM_VERSION
ARG GIT_VERSION

# npm is needed at runtime because Renovate calls it to update lock files of JavaScript projects.
RUN apk add --no-cache \
    nodejs=${NODEJS_VERSION} \
    npm=${NPM_VERSION} \
    git=${GIT_VERSION} \
    && addgroup -S -g 1001 renovate \
    && adduser -S -D -H -u 1001 -G renovate -h /data/home renovate

COPY --from=engine /opt/renovate /opt/renovate

COPY rootfs/ /
COPY licenses/ /usr/share/licenses/renovate-app/
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/licenses/renovate-app/

# Git does not keep the executable bit when files are uploaded through the GitHub API.
RUN find /etc/s6-overlay/s6-rc.d -type f \( -name run -o -name finish \) -exec chmod a+x {} +

ENV NODE_ENV=production

ARG BUILD_VERSION=2026.11.20
ARG BUILD_ARCH=amd64
RUN mkdir -p /etc/renovate-app && echo "${BUILD_VERSION}" >/etc/renovate-app/version
LABEL io.hass.version="${BUILD_VERSION}" \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.source="https://github.com/seb5594/Home-Assistant-Git-Renovate-App"

HEALTHCHECK --interval=1m --timeout=10s --start-period=1m --retries=3 \
    CMD ["curl", "--fail", "--silent", "--max-time", "5", "--output", "/dev/null", "http://127.0.0.1:8099/api/health"]
