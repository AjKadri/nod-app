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
