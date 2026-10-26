# Deploying clipQ on an Oracle Cloud Always Free VM

What you end up with: one free Ubuntu server running two containers.

- **clipq**: the app. It listens to Kick chat 24/7 and keeps the queue in SQLite on a Docker volume.
- **caddy**: the HTTPS front door. It gets and renews a Let's Encrypt certificate on its own.

Expect about 30–45 minutes the first time. You need:

- an international Visa/Mastercard, for Oracle's identity check
- a domain or subdomain you can point at the server. A free `*.duckdns.org` name works.
- a Kick account with 2FA on, to create a Kick developer app

---

## 1. Create the Oracle account

1. Sign up at <https://signup.cloud.oracle.com>.
2. **Pick the home region carefully. It can't be changed later.** Free Arm (Ampere) capacity is often sold out in busy regions. Frankfurt, Amsterdam, Stockholm, Zurich, Marseille and Jeddah usually work.
3. The card is verified with a small hold that is refunded. Always Free resources never charge.

> **Recommended: upgrade to "Pay As You Go"** (Billing → Upgrade). It costs nothing as long as you stay
> within Always Free limits. Free-only accounts can have **idle** instances reclaimed by Oracle, and
> clipQ uses very little CPU, so it can look idle. Pay As You Go accounts are exempt.
> To be safe, also set a budget alert: Billing → Budgets → $1.

## 2. Create the server

Compute → Instances → **Create instance**:

| Setting | Value |
|---|---|
| Image | **Canonical Ubuntu 24.04** |
| Shape | **VM.Standard.A1.Flex** (Ampere, arm64), **1 OCPU, 6 GB RAM**. It's marked *Always Free-eligible*. |
| Networking | Keep the default new VCN and public subnet, with **Assign a public IPv4 address** on |
| SSH keys | **Paste public key**: the contents of `~/.ssh/id_ed25519.pub` on your Mac |

If it says **"Out of capacity"**, try a different *Availability domain* in the same form, or retry later.
If you're still stuck, use the **VM.Standard.E2.1.Micro** shape (amd64, 1 GB RAM, also free). clipQ fits in either.

Write down the instance's **Public IP address**.

## 3. Open ports 80 and 443

Two firewalls block web traffic by default. Open both.

**a) Oracle's cloud firewall.** Instance page → *Subnet* link → *Security Lists* → the default list → **Add Ingress Rules**:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

**b) The firewall inside Ubuntu.** SSH in first:

```bash
ssh ubuntu@<PUBLIC_IP>
```

Then run:

```bash
sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
sudo netfilter-persistent save
```

## 4. Point your domain at the server

Create a DNS **A record** for your (sub)domain pointing to the public IP, for example `clipq.yourdomain.com → <PUBLIC_IP>`.

If you don't have a domain, use DuckDNS: log in at <https://www.duckdns.org>, create a name such as `myclipq`, and set its IP to the server's public IP. Your domain is then `myclipq.duckdns.org`.

Check it from your Mac. It must print the server's IP before you continue:

```bash
dig +short clipq.yourdomain.com
```

## 5. Install Docker on the server

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit
```

SSH back in, so the group change applies, and check:

```bash
docker run --rm hello-world
```

## 6. Create the Kick developer app

1. Go to <https://kick.com/settings/developer> and click **Create App**. Kick asks you to enable 2FA first.
2. **Redirect URL:** `https://<your domain>/auth/callback`. It must match exactly: https, no trailing slash.
3. **Scopes:** `user:read` and `channel:read`.
4. Copy the **Client ID** and **Client Secret**.

## 7. Configure and start clipQ

```bash
git clone https://github.com/sinafayazi/clipQ.git
cd clipQ
cp .env.example .env
nano .env
```

Set these values. Leave the rest as they are.

```ini
DOMAIN=clipq.yourdomain.com
PUBLIC_URL=https://clipq.yourdomain.com
KICK_CLIENT_ID=<from step 6>
KICK_CLIENT_SECRET=<from step 6>
DEV_LOGIN=0
```

Start it. The first build takes a few minutes on the free server:

```bash
docker compose up -d --build
docker compose logs -f
```

Look for `Server listening at http://0.0.0.0:3000`. Caddy should then log that it obtained a certificate. Press Ctrl+C to stop following the logs; the app keeps running.

## 8. Check it works

1. `https://<your domain>/healthz` should return `{"ok":true,"chat":true}`.
2. Open `https://<your domain>`, click **Log in with Kick** and approve.
3. Click **Open queue**, then post a YouTube or Kick clip link in your Kick chat. It should appear in the queue within a few seconds.

---

## Everyday commands

Run these on the server, inside `~/clipQ`.

| Task | Command |
|---|---|
| Update to the latest code | `git pull && docker compose up -d --build` |
| See logs | `docker compose logs -f clipq` |
| Restart | `docker compose restart clipq` |
| Status | `docker compose ps` |
| Back up the database | `docker compose stop clipq && docker compose cp clipq:/app/data/. ./backup-$(date +%F)/ && docker compose start clipq` |

The queue lives in the `clipq-data` Docker volume. It survives restarts, updates and reboots. Only `docker compose down -v` deletes it, so don't use `-v`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Site doesn't load, or Caddy logs `timeout during connect` | Port 80/443 is closed. Recheck **both** firewalls in step 3, and that DNS points to the right IP. |
| `Kick login failed` after approving | The redirect URL in the Kick app doesn't exactly match `PUBLIC_URL` + `/auth/callback`, or the client secret is wrong. |
| Yellow "Chatroom not found" box after login | Kick's API blocked the server. Open `https://kick.com/api/v2/channels/<your-channel>` in your browser, copy `chatroom.id` and paste it into the box. |
| `/healthz` shows `"chat":false` for a long time | Kick may have changed the Pusher key. Update `PUSHER_KEY` in `.env`, then run `docker compose up -d`. |
| Instance disappeared or was stopped by Oracle | Idle reclamation. Upgrade to Pay As You Go (see step 1). |
