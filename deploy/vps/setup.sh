#!/bin/bash
# Nod relay on a fresh Ubuntu/Debian VPS (tested target: Hetzner, Ubuntu 22.04/24.04).
#   sudo bash setup.sh relay.example.com
# Installs Node 22 and Caddy, runs the relay as user 'nod' on 127.0.0.1:8787,
# Caddy serves https://<domain> with an automatic certificate, firewall allows 22/80/443.
# Safe to run again: updates the relay code, keeps the registration key and the state.
set -euo pipefail
DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "usage: sudo bash setup.sh relay.example.com"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
say() { echo; echo "==> $*"; }

say "Checking DNS for $DOMAIN"
MYIP=$(curl -4 -fsS https://api.ipify.org || true)
DNSIP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
echo "this server: ${MYIP:-unknown}   $DOMAIN points to: ${DNSIP:-nothing}"
if [ -n "$MYIP" ] && [ "$MYIP" != "$DNSIP" ]; then
  echo "WARNING: $DOMAIN does not point at this server yet. The HTTPS certificate will fail until it does."
  echo "Fix the A record, wait a few minutes, then run this script again."
fi

say "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "node $(node -v), $(caddy version | cut -d' ' -f1)"

say "Installing the relay"
id nod >/dev/null 2>&1 || useradd --system --home /var/lib/nod --shell /usr/sbin/nologin nod
install -d -o nod -g nod -m 700 /var/lib/nod
install -d -m 755 /opt/nod-relay /etc/nod
echo "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" | base64 -d | tar -xzf - -C /opt/nod-relay --strip-components=1
(cd /opt/nod-relay && npm install --omit=dev --no-audit --no-fund --silent)
if [ ! -f /etc/nod/relay.env ]; then
  KEY=$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | cut -c1-40)
  printf 'RELAY_REGISTRATION_KEY=%s\n' "$KEY" > /etc/nod/relay.env
  chmod 600 /etc/nod/relay.env
fi

cat > /etc/systemd/system/nod-relay.service <<'UNIT'
[Unit]
Description=Nod relay
After=network-online.target
Wants=network-online.target

[Service]
User=nod
Group=nod
WorkingDirectory=/opt/nod-relay
EnvironmentFile=/etc/nod/relay.env
Environment=HOST=127.0.0.1 PORT=8787 RELAY_REQUIRE_HTTPS=1 RELAY_STATE_FILE=/var/lib/nod/relay-state.json NODE_ENV=production
ExecStart=/usr/bin/node /opt/nod-relay/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/nod

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now nod-relay >/dev/null 2>&1
systemctl restart nod-relay

say "Configuring HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy 127.0.0.1:8787
}
CADDY
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Firewall: allowing only SSH, HTTP and HTTPS"
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "Checking"
sleep 3
systemctl is-active --quiet nod-relay && echo "relay: running" || { echo "relay: NOT running"; journalctl -u nod-relay -n 20 --no-pager; exit 1; }
for i in $(seq 1 20); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then echo "https://$DOMAIN/health: OK"; OK=1; break; fi
  sleep 3
done
[ "${OK:-}" = 1 ] || echo "HTTPS not answering yet (certificate may still be issuing). Check: journalctl -u caddy -n 30"

echo
echo "==================================================================="
echo " Relay:            https://$DOMAIN"
echo " Registration key: $(cut -d= -f2 /etc/nod/relay.env)"
echo " Keep the key private. Pair from your Mac with:"
echo "   RELAY_REGISTRATION_KEY=<key> npm run pair -- --relay https://$DOMAIN"
echo "==================================================================="
