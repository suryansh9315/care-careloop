#!/usr/bin/env bash
# CareLoop bridge bootstrap.
#
# Ubuntu 24.04 is chosen deliberately: it ships glibc 2.39, which the Moss
# native binding needs. On an older base image Moss silently degrades to mock
# retrieval, which is much worse than failing loudly.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https unzip

# --- Node 22 ---------------------------------------------------------------
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# --- AWS CLI (for reading the SSM parameter at boot) -----------------------
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip
unzip -q /tmp/awscli.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/awscli.zip /tmp/aws

# --- Caddy (TLS termination + WebSocket forwarding) ------------------------
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# --- Application -----------------------------------------------------------
useradd --system --create-home --shell /usr/sbin/nologin careloop || true
install -d -o careloop -g careloop /opt/careloop

sudo -u careloop git clone "${repo_url}" /opt/careloop/app
cd /opt/careloop/app
sudo -u careloop npm ci
sudo -u careloop npm run build

# --- Runtime environment from SSM ------------------------------------------
# Fetched at boot rather than baked into the image, so rotating a credential is
# a parameter update plus a restart.
cat >/usr/local/bin/careloop-fetch-env <<EOF
#!/usr/bin/env bash
set -euo pipefail
aws ssm get-parameter --region "${region}" --name "${env_parameter_name}" \
  --with-decryption --query Parameter.Value --output text > /opt/careloop/app/.env
chown careloop:careloop /opt/careloop/app/.env
chmod 600 /opt/careloop/app/.env
EOF
chmod +x /usr/local/bin/careloop-fetch-env
/usr/local/bin/careloop-fetch-env || echo "WARN: SSM parameter not populated yet"

# --- systemd ---------------------------------------------------------------
cat >/etc/systemd/system/careloop-bridge.service <<'EOF'
[Unit]
Description=CareLoop bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=careloop
WorkingDirectory=/opt/careloop/app
ExecStartPre=/usr/local/bin/careloop-fetch-env
ExecStart=/usr/bin/node dist/src/bridge/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/careloop/app

[Install]
WantedBy=multi-user.target
EOF

# --- Caddy config ----------------------------------------------------------
# Caddy obtains and renews the certificate automatically once DNS resolves.
cat >/etc/caddy/Caddyfile <<EOF
${public_host} {
  encode gzip
  reverse_proxy localhost:3000
}
EOF

systemctl daemon-reload
systemctl enable --now careloop-bridge
systemctl reload caddy || systemctl restart caddy
