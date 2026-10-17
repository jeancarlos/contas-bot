# Add-ons

contas-bot does not talk to other systems. It serves read-only HTTP endpoints, and add-ons read them. An add-on can never change a bill or a payment: every change happens in the WhatsApp group.

## What the bot serves

HTTP is off unless you set `HTTP_PORT` (for example `8080`). The port is not published to the host by default, and requests are only answered for an IP address, a Docker service name, or a host name listed in `HTTP_HOSTS`.

| Path | What |
|---|---|
| `/summary.json` | Current month per group: unpaid count, total, and each bill's paid / amount / paused state |
| `/metrics` | Prometheus metrics (`contas_whatsapp_connected`, `contas_bills_unpaid`, `contas_paid_amount`, `contas_month_paid`) |
| `/export.csv`, `/export.json` | One row per payment, `?from=YYYY-MM&to=YYYY-MM` (last 24 months by default) |
| `/` | Read-only dashboard |

Set `HTTP_TOKEN` to require `Authorization: Bearer <token>` on every request (Prometheus: `authorization: { credentials: <token> }` in the job; Home Assistant: `headers:` on the `rest` resource).

These endpoints contain your household's payments and who paid them. Keep the port on a private network (for example a Docker network shared only with the services that need it, or behind a Tailscale-only reverse proxy).

## Home Assistant, polling (this folder)

`home-assistant/contas_bot.yaml` is a Home Assistant package that polls `/summary.json` every 5 minutes. It needs nothing besides Home Assistant.

1. Enable packages in `configuration.yaml`, if they are not already:
   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```
2. Copy `contas_bot.yaml` into `packages/`.
3. Add the bot's address to `secrets.yaml`:
   ```yaml
   contas_bot_summary_url: http://contas-bot:8080/summary.json
   ```
4. Restart Home Assistant.

You get `sensor.contas_a_pagar` (unpaid bills, with the bill list and total as attributes) and `sensor.contas_total_do_mes`. The package reads the first group; set `unit_of_measurement` to your `BOT_CURRENCY` if it is not `BRL`.

## Home Assistant over MQTT (separate repo)

[contas-bot-mqtt](https://github.com/jeancarlos/contas-bot-mqtt) is a small service that polls `/summary.json` and publishes Home Assistant MQTT discovery to your broker: two sensors per group, created automatically, with an availability topic that goes `offline` when the bot is unreachable. Use it if you already run Mosquitto and prefer push-style entities or more than one group.
