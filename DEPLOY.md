# Deploying clipQ

Two free ways to run clipQ:

- **[Option A: Render + Turso + UptimeRobot](#option-a-render--turso--uptimerobot-no-card)**: needs no card. It's three free services working together.
- **[Option B: Oracle Cloud Always Free VM](#option-b-oracle-cloud-always-free-vm)**: needs an international card. It's one real server and is the most robust option.

---

# Option A: Render + Turso + UptimeRobot (no card)

| Service | Job | Free limits |
|---|---|---|
| **Render** | Runs clipQ and gives you `https://<name>.onrender.com` with HTTPS | 750 hours/month for all free services together. One service running all month uses ~744. |
| **Turso** | Keeps the database. Render's free disk is wiped whenever the app restarts. | Far more than clipQ needs |
| **UptimeRobot** | Opens clipQ every 5 minutes so Render never puts it to sleep | 50 monitors |

How the data flows: clipQ works on a local SQLite file as before. When it starts, it copies everything from Turso, and every change is pushed back to Turso within about a second.

Two things to know:

- **Don't deploy while streaming.** A deploy restarts clipQ. The queue survives, but chat links posted during the ~1 minute switch can be missed. Auto-deploy is off, so nothing deploys unless you click it.
- If Turso can't be reached when clipQ starts, clipQ refuses to start, and Render retries. This is deliberate: starting empty could overwrite your data.

## A1. Create the Turso database

1. Sign up at <https://turso.tech> with GitHub. No card needed.
2. **Databases → Create Database.** Name: `clipq`. Location: **Frankfurt (aws-eu-central-1)**, the same region as the Render service.
3. Open the database and copy its **URL**, which looks like `libsql://clipq-<you>.turso.io`.
4. Click **Create Token** with read & write access, no expiry. Copy the token. It's shown only once.

clipQ creates its tables in Turso by itself on first start.

## A2. Create the Render service

1. Sign up at <https://render.com> with GitHub. No card needed for free services.
2. **New → Blueprint**, pick the `clipQ` repository. Render reads `render.yaml` and proposes a free web service named `clipq`.
   - If the name `clipq` is taken, Render picks another. Your URL is whatever Render shows, such as `https://clipq-ab12.onrender.com`.
   - If you'd rather not use a Blueprint, use **New → Web Service** → the repo, with **Language: Docker**, **Instance type: Free**, **Region: Frankfurt** and **Health check path: `/healthz`**. Turn **Auto-Deploy** off in Settings.
3. Fill in the environment variables it asks for:

| Key | Value |
|---|---|
| `PUBLIC_URL` | Your Render URL, e.g. `https://clipq-ab12.onrender.com` (no trailing slash) |
| `TURSO_DATABASE_URL` | From A1 |
| `TURSO_AUTH_TOKEN` | From A1 |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | From step A3. Put `-` for now and edit them after A3. |

4. Click **Apply** or **Create**. The first build takes ~5 minutes. When it's done, open `https://<your-url>/healthz`. It should show `{"ok":true,...}`.

## A3. Create the Kick developer app

1. Go to <https://kick.com/settings/developer> and click **Create App**. Kick asks you to enable 2FA first.
2. **Redirect URL:** `https://<your-render-url>/auth/callback`
3. **Scopes:** `user:read` and `channel:read`.
4. Copy the **Client ID** and **Client Secret** into the Render service's **Environment** page. Saving restarts the service.

## A4. Keep it awake with UptimeRobot

1. Sign up at <https://uptimerobot.com>, free.
2. **New monitor** → type **HTTP(s)**, URL `https://<your-render-url>/healthz`, interval **5 minutes**.
3. That's it. Render only sleeps after 15 minutes without visits, and this visits every 5.

If UptimeRobot doesn't work for you, <https://cron-job.org> does the same job: a free job that GETs `/healthz` every 5 minutes.

## A5. Check it works

1. Open your Render URL, click **Log in with Kick** and approve.
2. Click **Open queue** and post a clip link in your Kick chat. It should appear within a few seconds.
3. In Render's dashboard, **Manual Deploy → Restart service**. After it's back, your queue should still be there. That's Turso working.

## Updating (Option A)

Push to GitHub, then in Render: **Manual Deploy → Deploy latest commit**. Do it when nobody is streaming.

## Troubleshooting (Option A)

| Symptom | Likely cause |
|---|---|
| Deploy fails, logs say `turso` / `SERVER_ERROR` / `401` | Wrong `TURSO_DATABASE_URL` or token, or the token expired. Create a new token and update the env var. |
| App is slow to open, then works | It was asleep. Check that the UptimeRobot monitor is running and hitting `/healthz`. |
| Yellow "Chatroom not found" box after login | Kick's Cloudflare blocked Render's IP. Open `https://kick.com/api/v2/channels/<your-channel>` in your browser, copy `chatroom.id` and paste it into the box. It's saved in Turso, so you only do this once. |
| Kick clips show "Loading clip…" then "can't be embedded" | Kick's API refused both the server and your browser. Use **Open clip in a new tab** for that clip. |
| `Kick login failed` | The Kick app's redirect URL doesn't exactly match `PUBLIC_URL` + `/auth/callback`. |
| Service suspended near the end of the month | Free hours ran out because another free Render service shares them. Delete the other one. |

---

# Option B: Oracle Cloud Always Free VM

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
