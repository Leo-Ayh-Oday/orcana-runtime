#!/usr/bin/env bash
#
# runner-isolation-migrate.sh — migrate the Orcana self-hosted runner from the
# personal user (fuqiang) to a dedicated, unprivileged `github-runner` user.
#
# MUST be executed as root (e.g. `wsl -u root -d Ubuntu -- bash <this script>`).
# Idempotent: safe to re-run after a partial failure.
#
# Assumptions:
#   - runner currently installed at /home/fuqiang/actions-runner
#   - systemd service: actions.runner.Leo-Ayh-Oday-orcana-runtime.orcana-linux-runtime
#   - runner registered for repo Leo-Ayh-Oday/orcana-runtime (PUBLIC)
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: must run as root" >&2
  exit 64
fi

SERVICE="actions.runner.Leo-Ayh-Oday-orcana-runtime.orcana-linux-runtime"
SRC_DIR="/home/fuqiang/actions-runner"
DST_USER="github-runner"
DST_HOME="/home/${DST_USER}"
DST_DIR="${DST_HOME}/actions-runner"

echo "==> [1/6] create dedicated user"
if id "${DST_USER}" >/dev/null 2>&1; then
  echo "    user ${DST_USER} already exists, skipping"
else
  useradd --system --no-create-home --home-dir "${DST_HOME}" \
    --shell /usr/sbin/nologin "${DST_USER}"
  install -d -o "${DST_USER}" -g "${DST_USER}" -m 0700 "${DST_HOME}"
  echo "    created ${DST_USER}"
fi

echo "==> [2/6] enable lingering for user manager (cgroup delegation)"
loginctl enable-linger "${DST_USER}" 2>/dev/null || true

echo "==> [3/6] migrate runner directory"
# Purge per-user /tmp residue owned by the old account (e.g. execd log dirs
# created under /tmp/orcana-execd) — the new user cannot mkdir inside them.
rm -rf /tmp/orcana-execd 2>/dev/null || true
if [ -d "${DST_DIR}" ]; then
  echo "    ${DST_DIR} already exists, skipping copy"
else
  cp -a "${SRC_DIR}" "${DST_DIR}"
fi
chown -R "${DST_USER}:${DST_USER}" "${DST_DIR}"
find "${DST_DIR}" -type d -exec chmod 0755 {} +
chmod 0600 "${DST_DIR}/.credentials" "${DST_DIR}/.runner" "${DST_DIR}/.env" 2>/dev/null || true
echo "    runner home is now ${DST_DIR} (owner ${DST_USER})"

echo "==> [4/6] reinstall systemd service as ${DST_USER}"
if systemctl is-active "${SERVICE}" >/dev/null 2>&1; then
  systemctl stop "${SERVICE}"
fi
systemctl disable "${SERVICE}" >/dev/null 2>&1 || true
rm -f "/etc/systemd/system/${SERVICE}.service"
rm -rf "/etc/systemd/system/${SERVICE}.service.d"

# Update runtime paths inside the copied runner before installing the service.
sed -i "s|${SRC_DIR}|${DST_DIR}|g" "${DST_DIR}/runsvc.sh" "${DST_DIR}/svc.sh" 2>/dev/null || true

cd "${DST_DIR}"
if ! ./svc.sh install "${DST_USER}" >/dev/null 2>&1; then
  echo "WARN: svc.sh install failed; falling back to manual unit" >&2
  cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=GitHub Actions runner (${SERVICE})
After=network-online.target

[Service]
User=${DST_USER}
WorkingDirectory=${DST_DIR}
ExecStart=${DST_DIR}/bin/Runner.Listener run --startuptype service
Restart=always
RestartSec=5
Environment=HOME=${DST_HOME}

[Install]
WantedBy=multi-user.target
EOF
fi

install -d -m 0755 "/etc/systemd/system/${SERVICE}.service.d"
cat > "/etc/systemd/system/${SERVICE}.service.d/override.conf" <<EOF
[Service]
Restart=always
RestartSec=5
EOF

systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null 2>&1 || true
systemctl start "${SERVICE}"

echo "==> [5/6] verify"
sleep 5
systemctl is-active "${SERVICE}"
systemctl show "${SERVICE}" -p User -p ExecStart | head -2
su -s /bin/bash "${DST_USER}" -c 'systemctl --user show-environment' >/dev/null 2>&1 \
  && echo "    user manager OK (systemctl --user works)" \
  || echo "WARN: systemctl --user not reachable yet — check XDG_RUNTIME_DIR in ${DST_DIR}/.env"

echo "==> [6/6] post-migration review checklist"
cat <<'EOF'
Manual review required:
  1. Confirm old listener is gone: pgrep -f Runner.Listener (fuqiang-owned PID must not exist)
  2. Private dirs: chmod 700 ~fuqiang/.ssh ~fuqiang/.orcana ~fuqiang/.aws (fuqiang-owned)
  3. Dispatch CI + Linux Sandbox Lanes from GitHub; expect all green
  4. Old /home/fuqiang/actions-runner may be removed once verified
EOF
