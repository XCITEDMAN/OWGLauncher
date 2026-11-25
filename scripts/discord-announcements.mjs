// Reads the latest messages from one Discord channel and writes announcements.json.
// Runs in GitHub Actions. Needs: DISCORD_BOT_TOKEN (secret), DISCORD_CHANNEL_ID (variable).
import fs from 'node:fs';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL = (process.env.DISCORD_CHANNEL_ID || '').trim();
const MAX = Math.min(Math.max(parseInt(process.env.MAX_MESSAGES || '10', 10) || 10, 1), 50);
const OUT = process.env.OUT_FILE || 'announcements.json';
const API = process.env.DISCORD_API || 'https://discord.com/api/v10';

if (!TOKEN) fail('DISCORD_BOT_TOKEN secret is missing (Settings → Secrets and variables → Actions → Secrets).');
if (!/^\d{15,22}$/.test(CHANNEL)) fail('DISCORD_CHANNEL_ID variable is missing or not a channel ID (Settings → Secrets and variables → Actions → Variables).');

function fail(msg) { console.error(`::error::${msg}`); process.exit(1); }

async function api(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API + path, { headers: { Authorization: `Bot ${TOKEN}`, 'User-Agent': 'OWG-Launcher-Announcements (github actions, 1.0)' } });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((j.retry_after || 1) * 1000)));
      continue;
    }
    if (res.status === 401) fail('Discord rejected the bot token. Reset it in the Developer Portal and update the DISCORD_BOT_TOKEN secret.');
    if (res.status === 403) fail(`The bot can't see this channel (${path}). Give it "View Channel" and "Read Message History" there.`);
    if (res.status === 404) fail(`Discord says this doesn't exist: ${path}. Check DISCORD_CHANNEL_ID.`);
    if (!res.ok) fail(`Discord API error ${res.status} on ${path}`);
    return res.json();
  }
  fail('Discord kept rate-limiting the request.');
}

const channel = await api(`/channels/${CHANNEL}`);
const guildId = channel.guild_id;
const [messages, roles, channels] = await Promise.all([
  api(`/channels/${CHANNEL}/messages?limit=${MAX}`),
  guildId ? api(`/guilds/${guildId}/roles`).catch(() => []) : [],
  guildId ? api(`/guilds/${guildId}/channels`).catch(() => []) : [],
]);
const roleName = new Map((roles || []).map((r) => [r.id, r.name]));
const chanName = new Map((channels || []).map((c) => [c.id, c.name]));

if (messages.length && !messages.some((m) => m.content || (m.embeds || []).length || (m.attachments || []).length)) {
  fail('Messages came back empty. Turn on "Message Content Intent" for the bot (Developer Portal → Bot).');
}

const displayName = (u) => (u && ((u.member && u.member.nick) || u.global_name || u.username)) || 'Someone';

function clean(text, m) {
  if (!text) return '';
  const users = new Map((m.mentions || []).map((u) => [u.id, displayName(u)]));
  return text
    .replace(/<@!?(\d+)>/g, (_, id) => `@${users.get(id) || 'member'}`)
    .replace(/<@&(\d+)>/g, (_, id) => `@${roleName.get(id) || 'role'}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${chanName.get(id) || 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::([tTdDfFR]))?>/g, (_, ts, style) => `{{ts:${ts}:${style || 'f'}}}`)
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .trim();
}

const items = messages
  .filter((m) => m.type === 0 || m.type === 19)
  .map((m) => {
    const parts = [clean(m.content, m)];
    for (const e of m.embeds || []) {
      if (e.type && !['rich', 'article', 'link'].includes(e.type)) continue;
      const t = [e.title ? `**${clean(e.title, m)}**` : '', clean(e.description, m)].filter(Boolean).join('\n');
      if (t && !parts[0].includes(t)) parts.push(t);
    }
    return {
      id: m.id,
      timestamp: m.timestamp,
      edited: m.edited_timestamp || null,
      author: displayName({ ...m.author, member: m.member }),
      text: parts.filter(Boolean).join('\n\n').slice(0, 4000),
      attachments: (m.attachments || []).map((a) => a.filename).slice(0, 10),
      url: guildId ? `https://discord.com/channels/${guildId}/${CHANNEL}/${m.id}` : null,
    };
  })
  .filter((i) => i.text || i.attachments.length);

let prev = null;
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
const now = new Date().toISOString();
const same = prev && JSON.stringify(prev.items) === JSON.stringify(items) && prev.channel === channel.name;
// GitHub pauses scheduled jobs in repos with no commits for 60 days; touch the file monthly.
const stale = !prev || !prev.keepalive || Date.now() - Date.parse(prev.keepalive) > 25 * 24 * 3600 * 1000;
if (same && !stale) { console.log(`No changes (${items.length} messages).`); process.exit(0); }

const out = {
  schemaVersion: 1,
  source: 'discord',
  channel: channel.name,
  updated: same ? prev.updated : now,
  keepalive: now,
  items,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(same ? 'Keep-alive update.' : `Saved ${items.length} messages from #${channel.name}.`);
