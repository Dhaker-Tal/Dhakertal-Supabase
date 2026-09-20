# Dhaker Tal — Database

Postgres on Supabase, with row-level security on every table. The client key is
public by design; the policies are what actually protect the data.

```
seed.sql            starting pandals, amenities, metro lines and stations
schema-fixes.sql    migrations applied after the first schema
notifications.sql   the trigger that fires when someone requests a pandal
functions/notify-request/   Edge Function: push, email and WhatsApp alerts
```

## Tables

`pandals` · `amenities` · `metro_stations` · `metro_lines` · `profiles` ·
`crowd_reports` · `saved_places` · `groups`

Check RLS is enabled on all of them before exposing anything publicly.

## Edge Function secrets

Every credential is read at runtime with `Deno.env.get()` — nothing is hardcoded.
Set these under Edge Functions → Secrets:

| Secret | Purpose |
|---|---|
| `NTFY_TOPIC` | push channel name — treat it like a password, anyone who knows it can read the alerts |
| `RESEND_KEY`, `EMAIL_TO`, `EMAIL_FROM` | email alerts |
| `CALLMEBOT_KEY`, `WHATSAPP_PHONE` | WhatsApp alerts |
| `META_TOKEN`, `META_PHONE_ID`, `META_TEMPLATE` | WhatsApp via the official API |

Deploy with `supabase functions deploy notify-request`.
