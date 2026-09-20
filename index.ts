// ============================================================
//  notify-request — alerts you when someone submits a pandal
//  through the "Request a pandal" tab.
//
//  The database trigger posts only { id }. This function then
//  looks that id up itself, using the service-role key Supabase
//  injects automatically, and atomically CLAIMS it: a row can be
//  notified once, and only within five minutes of being created.
//  So there is no shared secret to configure, and nothing an
//  outsider could usefully forge.
//
//  Channels — every one that is configured fires:
//
//  PUSH via ntfy.sh  (no account, no key, works out of the box)
//    NTFY_TOPIC    optional override of the built-in topic
//
//  EMAIL via Resend
//    RESEND_KEY    API key from resend.com
//    EMAIL_TO      defaults to dhakertal@gmail.com
//    EMAIL_FROM    defaults to Resend's shared sender
//
//  WHATSAPP via Meta Cloud API
//    META_TOKEN, META_PHONE_ID, WHATSAPP_PHONE
//    META_TEMPLATE, META_TEMPLATE_LANG (needed outside Meta's
//    24-hour window, since alerts are business-initiated)
//
//  WHATSAPP via CallMeBot
//    CALLMEBOT_KEY, WHATSAPP_PHONE
// ============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// A private channel name. Anyone who knows it can read the alerts,
// so it is long and random rather than guessable. Change it by
// setting NTFY_TOPIC in Edge Function secrets.
const DEFAULT_NTFY_TOPIC = "REPLACE-WITH-YOUR-OWN-RANDOM-TOPIC";
const DEFAULT_EMAIL_TO = "dhakertal@gmail.com";
const DEFAULT_EMAIL_FROM = "Dhaker Tal <onboarding@resend.dev>";

/** Template parameters may not contain newlines, tabs, or long runs of spaces. */
function oneLine(v: unknown, max = 120): string {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

/** HTTP headers must be latin-1; strip anything that is not. */
function headerSafe(s: string, max = 90): string {
  return s.replace(/[^\x20-\x7E]/g, "").trim().slice(0, max) || "Dhaker Tal";
}

/** Requests are written by the public — never drop them into HTML raw. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function num(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(5) : "?";
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Meta error codes meaning "you are outside the 24-hour service window". */
const NEEDS_TEMPLATE = new Set([131047, 131026, 132000, 470]);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const id = String(body.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return json({ ok: false, error: "service role not available" });

  // Atomically claim the row. A second call for the same id gets nothing back.
  let row: Record<string, unknown> | null = null;
  try {
    const r = await fetch(`${url}/rest/v1/rpc/claim_request_for_notify`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_id: id }),
    });
    const out = await r.json();
    row = Array.isArray(out) ? out[0] ?? null : null;
  } catch (e) {
    return json({ ok: false, error: "lookup failed: " + String(e).slice(0, 150) });
  }

  // unknown id, already notified, or too old — say nothing useful
  if (!row) return new Response("Not found", { status: 404 });

  const name = oneLine(row.name) || "(no name)";
  const area = oneLine(row.area, 80);
  const zone = oneLine(row.zone, 20);
  const who = oneLine(row.requester_name, 60);
  const contact = oneLine(row.requester_contact, 60);
  const note = oneLine(row.description, 200);
  const lat = num(row.lat), lng = num(row.lng);

  const where = [area, zone].filter(Boolean).join(", ") || "not given";
  const from = [who, contact].filter(Boolean).join(" · ") || "anonymous";
  const coords = lat !== "?" ? `${lat}, ${lng}` : "not given";
  const mapUrl = lat !== "?" ? `https://maps.google.com/?q=${lat},${lng}` : "";

  const plain = [
    `\u{1F3EF} ${name}`,
    `\u{1F4CD} ${where}`,
    mapUrl ? `\u{1F5FA} ${mapUrl}` : "",
    note ? `\u{1F4DD} ${note}` : "",
    `\u{1F464} ${from}`,
    "",
    "Open the Admin tab on the site to approve or reject it.",
  ].filter(Boolean).join("\n");

  const results: Record<string, unknown> = {};

  // ---------------- Push via ntfy.sh (no account needed) ----------------
  const topic = Deno.env.get("NTFY_TOPIC") || DEFAULT_NTFY_TOPIC;
  if (topic) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "text/plain; charset=utf-8",
        Title: headerSafe(`New pandal request: ${name}`),
        Priority: "default",
        Tags: "tada",
      };
      if (mapUrl) headers.Click = mapUrl;
      const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers,
        body: plain,
      });
      results.push = r.ok
        ? { ok: true, topic }
        : { ok: false, status: r.status, out: (await r.text()).slice(0, 200) };
    } catch (e) {
      results.push = { ok: false, error: String(e).slice(0, 200) };
    }
  }

  // ---------------- Email via Resend ----------------
  const resendKey = Deno.env.get("RESEND_KEY");
  if (resendKey) {
    const mailTo = Deno.env.get("EMAIL_TO") || DEFAULT_EMAIL_TO;
    const sender = Deno.env.get("EMAIL_FROM") || DEFAULT_EMAIL_FROM;

    const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
            max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
  <div style="background:#b8232f;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
    <div style="font-size:13px;letter-spacing:.08em;opacity:.85">DHAKER TAL</div>
    <div style="font-size:20px;font-weight:700;margin-top:2px">New pandal request</div>
  </div>
  <div style="border:1px solid #e6e6e6;border-top:none;border-radius:0 0 12px 12px;padding:20px">
    <h2 style="margin:0 0 16px;font-size:22px">${esc(name)}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:15px">
      <tr><td style="padding:6px 0;color:#666;width:90px">Area</td>
          <td style="padding:6px 0">${esc(where)}</td></tr>
      <tr><td style="padding:6px 0;color:#666">Location</td>
          <td style="padding:6px 0">${
            mapUrl
              ? `<a href="${esc(mapUrl)}" style="color:#b8232f">${esc(coords)}</a>`
              : esc(coords)
          }</td></tr>
      ${note ? `<tr><td style="padding:6px 0;color:#666">Note</td>
          <td style="padding:6px 0">${esc(note)}</td></tr>` : ""}
      <tr><td style="padding:6px 0;color:#666">From</td>
          <td style="padding:6px 0">${esc(from)}</td></tr>
    </table>
    <p style="margin:20px 0 0;padding-top:16px;border-top:1px solid #eee;
              font-size:14px;color:#666">
      Open the <b>Admin</b> tab on the site to approve or reject it.
    </p>
  </div>
</div>`.trim();

    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: sender,
          to: [mailTo],
          subject: `New pandal request: ${name}`,
          text: plain,
          html,
        }),
      });
      const out = await r.text();
      results.email = r.ok
        ? { ok: true, to: mailTo, id: out.slice(0, 120) }
        : { ok: false, status: r.status, out: out.slice(0, 300) };
    } catch (e) {
      results.email = { ok: false, error: String(e).slice(0, 200) };
    }
  }

  // ---------------- WhatsApp (optional, if ever configured) ----------------
  const phone = Deno.env.get("WHATSAPP_PHONE") ?? "";
  const metaToken = Deno.env.get("META_TOKEN");
  const metaPhoneId = Deno.env.get("META_PHONE_ID");
  const metaTemplate = Deno.env.get("META_TEMPLATE");
  const metaLang = Deno.env.get("META_TEMPLATE_LANG") || "en";
  const cmbKey = Deno.env.get("CALLMEBOT_KEY");
  const to = phone.replace(/[^0-9]/g, "");

  if (to && metaToken && metaPhoneId) {
    try {
      const endpoint = `https://graph.facebook.com/v21.0/${metaPhoneId}/messages`;
      const headers = { Authorization: `Bearer ${metaToken}`, "Content-Type": "application/json" };
      const send = async (payload: unknown) => {
        const r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
        let out: Record<string, unknown> = {};
        try { out = await r.json(); } catch { /* keep {} */ }
        return { ok: r.ok, status: r.status, out };
      };

      const text = await send({
        messaging_product: "whatsapp", to, type: "text",
        text: { preview_url: false, body: plain },
      });
      if (text.ok) {
        results.whatsapp = { ok: true, via: "meta:text" };
      } else {
        const err = (text.out?.error ?? {}) as Record<string, unknown>;
        const code = Number(err.code ?? 0);
        if (metaTemplate && NEEDS_TEMPLATE.has(code)) {
          const tpl = await send({
            messaging_product: "whatsapp", to, type: "template",
            template: {
              name: metaTemplate,
              language: { code: metaLang },
              components: [{
                type: "body",
                parameters: [
                  { type: "text", text: name },
                  { type: "text", text: where },
                  { type: "text", text: coords },
                  { type: "text", text: from },
                ],
              }],
            },
          });
          results.whatsapp = tpl.ok
            ? { ok: true, via: "meta:template" }
            : { ok: false, via: "meta:template", error: (tpl.out?.error as Record<string, unknown>)?.message };
        } else {
          results.whatsapp = { ok: false, via: "meta:text", code, error: err.message };
        }
      }
    } catch (e) {
      results.whatsapp = { ok: false, error: String(e).slice(0, 200) };
    }
  } else if (to && cmbKey) {
    try {
      const r = await fetch(
        "https://api.callmebot.com/whatsapp.php"
        + `?phone=${encodeURIComponent(phone)}`
        + `&apikey=${encodeURIComponent(cmbKey)}`
        + `&text=${encodeURIComponent(plain)}`,
      );
      results.whatsapp = { ok: r.ok, via: "callmebot", status: r.status };
    } catch (e) {
      results.whatsapp = { ok: false, error: String(e).slice(0, 200) };
    }
  }

  if (!Object.keys(results).length) {
    return json({ ok: false, error: "No channel configured" });
  }
  const ok = Object.values(results).some((r) => (r as { ok?: boolean }).ok);
  return json({ ok, ...results });
});
