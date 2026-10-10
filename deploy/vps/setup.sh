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
