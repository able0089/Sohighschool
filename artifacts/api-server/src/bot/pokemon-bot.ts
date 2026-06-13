import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  Attachment,
} from "discord.js";
import axios from "axios";
import { db } from "@workspace/db";
import { pokemonHashesTable } from "@workspace/db";
import { computeDHash, hammingDistance } from "../lib/dhash";
import { logger } from "../lib/logger";
import { ilike, sql } from "drizzle-orm";

const POKETWO_BOT_ID = "716390085896962058";
const OWNER_ID = "1396815034247806999";
const PREFIX = "pk!";
const HAMMING_THRESHOLD = 10;

const startedAt = Date.now();

type PendingEntry = {
  hash: string;
  channelId: string;
  guildId: string | null;
};

const pendingHashes = new Map<string, PendingEntry>();
let botUserId: string | null = null;

function makeKey(guildId: string | null, channelId: string): string {
  return `${guildId ?? "dm"}:${channelId}`;
}

function parseCommand(message: Message): { cmd: string; args: string[] } | null {
  const raw = message.content.trim();
  let body: string | null = null;

  if (raw.startsWith(PREFIX)) {
    body = raw.slice(PREFIX.length).trim();
  } else if (botUserId) {
    const mentionFull = `<@!${botUserId}>`;
    const mentionShort = `<@${botUserId}>`;
    if (raw.startsWith(mentionFull)) body = raw.slice(mentionFull.length).trim();
    else if (raw.startsWith(mentionShort)) body = raw.slice(mentionShort.length).trim();
  }

  if (body === null) return null;

  const parts = body.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1);
  return { cmd, args };
}

// ── Name extraction helpers ──────────────────────────────────────────────────

function cleanPokemonName(raw: string): string {
  return raw
    .replace(/\([\d.,]+\s*%[^)]*\)/g, "")   // strip IV % like (61.29% IV)
    .replace(/[♂♀]/g, "")                    // strip gender symbols
    .replace(/:(?:male|female):/gi, "")       // strip :male: :female:
    .replace(/<[^>]+>/g, "")                  // strip Discord custom emojis
    .replace(/\s+/g, " ")
    .trim();
}

function extractCatchName(content: string): string | null {
  // Pokétwo: "Congratulations @user! You caught a level 5 Bulbasaur ♂ (92.71% IV)!"
  const m = content.match(
    /you caught (?:a |an |the )?(?:level \d+\s)?([A-Za-z][A-Za-z\s'\-\.]*[A-Za-z]\.?)/i
  );
  if (!m) return null;
  const name = cleanPokemonName(m[1]);
  if (!name || name.length < 2) return null;
  return toTitleCase(name);
}

function extractFleeName(content: string, embeds: readonly { title?: string | null; description?: string | null }[]): string | null {
  const fleePatterns = [
    /(?:wild|the wild|the)\s+(.+?)\s+(?:has\s+)?fled/i,
    /(.+?)\s+(?:has\s+)?fled the battle/i,
  ];

  for (const pattern of fleePatterns) {
    const m = content.match(pattern);
    if (m) {
      const name = cleanPokemonName(m[1]);
      if (name.length > 1) return toTitleCase(name);
    }
  }

  for (const embed of embeds) {
    const combined = `${embed.title ?? ""} ${embed.description ?? ""}`;
    for (const pattern of fleePatterns) {
      const m = combined.match(pattern);
      if (m) {
        const name = cleanPokemonName(m[1]);
        if (name.length > 1) return toTitleCase(name);
      }
    }
    // Pokétwo sometimes sends embed whose title IS the Pokémon name
    // and description says "fled" / "ran away" etc.
    if (embed.title && /fled|ran away|got away/i.test(combined)) {
      const name = cleanPokemonName(embed.title);
      if (/^[A-Za-z]/.test(name) && name.length > 1) {
        return toTitleCase(name);
      }
    }
  }

  return null;
}

// ── Bot startup ───────────────────────────────────────────────────────────────

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN not set — bot will not start");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    botUserId = c.user.id;
    logger.info({ tag: c.user.tag, id: c.user.id }, "Pokétwo bot logged in");
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      await handleMessage(message);
    } catch (err) {
      logger.error({ err }, "Error handling message");
    }
  });

  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to log in to Discord");
  });
}

// ── Message routing ───────────────────────────────────────────────────────────

async function handleMessage(message: Message): Promise<void> {
  const guildId = message.guildId;
  const channelId = message.channelId;
  const key = makeKey(guildId, channelId);

  if (message.author.bot) {
    if (message.author.id === POKETWO_BOT_ID) {
      await handlePoketwoMessage(message, key, guildId, channelId);
    }
    return;
  }

  // Owner commands
  if (message.author.id === OWNER_ID) {
    const parsed = parseCommand(message);
    if (parsed) {
      await handleOwnerCommand(message, parsed.cmd, parsed.args, key);
      return;
    }
    return;
  }

  // Non-owner tried a command → react with ❌
  const parsed = parseCommand(message);
  if (parsed && parsed.cmd) {
    try {
      await message.react("❌");
    } catch {
      // ignore if no permission to react
    }
  }
}

// ── Owner commands ────────────────────────────────────────────────────────────

async function handleOwnerCommand(
  message: Message,
  cmd: string,
  args: string[],
  key: string
): Promise<void> {
  switch (cmd) {
    case "ping":
      await message.reply("🟢 Online and watching!");
      break;
    case "stats":
      await handleStats(message);
      break;
    case "pokedex":
      await handlePokedex(message);
      break;
    case "lookup":
      await handleLookup(message, args);
      break;
    case "forget":
      await handleForget(message, args);
      break;
    case "rename":
      await handleRename(message, args);
      break;
    case "teach":
      await handleTeach(message, args, key);
      break;
    case "guess":
      await handleGuess(message);
      break;
    case "pending":
      await handlePending(message);
      break;
    case "clearpending":
      await handleClearPending(message);
      break;
    case "cleandb":
      await handleCleanDb(message);
      break;
    case "help":
      await handleHelp(message);
      break;
    default:
      break;
  }
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleStats(message: Message): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pokemonHashesTable);

  const pending = pendingHashes.size;
  const ms = Date.now() - startedAt;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);

  await message.reply(
    `📊 **Bot Stats**\n` +
    `• Pokémon learned: **${count}**\n` +
    `• Pending spawns in memory: **${pending}**\n` +
    `• Uptime: **${h}h ${m}m ${s}s**`
  );
}

async function handlePokedex(message: Message): Promise<void> {
  const entries = await db
    .select({ name: pokemonHashesTable.name })
    .from(pokemonHashesTable)
    .orderBy(pokemonHashesTable.name);

  if (entries.length === 0) {
    await message.reply("📖 Pokédex is empty — no Pokémon learned yet!");
    return;
  }

  const chunks: string[] = [];
  let current = "";
  for (const entry of entries) {
    const line = `• ${entry.name}\n`;
    if ((current + line).length > 1800) {
      chunks.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    const header = i === 0 ? `📖 **Pokédex — ${entries.length} learned**\n\n` : "";
    await message.reply(`${header}${chunks[i]}`);
  }
}

async function handleLookup(message: Message, args: string[]): Promise<void> {
  if (args.length === 0) {
    await message.reply("Usage: `pk!lookup <name>`");
    return;
  }
  const name = toTitleCase(args.join(" "));
  const results = await db
    .select({ name: pokemonHashesTable.name, learnedAt: pokemonHashesTable.learnedAt })
    .from(pokemonHashesTable)
    .where(ilike(pokemonHashesTable.name, name));

  if (results.length === 0) {
    await message.reply(`❌ **${name}** is not in the database yet.`);
  } else {
    const d = results[0].learnedAt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    await message.reply(`✅ **${results[0].name}** is in the database (learned ${d}).`);
  }
}

async function handleForget(message: Message, args: string[]): Promise<void> {
  if (args.length === 0) {
    await message.reply("Usage: `pk!forget <name>`");
    return;
  }
  const name = args.join(" ");
  const deleted = await db
    .delete(pokemonHashesTable)
    .where(ilike(pokemonHashesTable.name, name))
    .returning({ name: pokemonHashesTable.name });

  if (deleted.length === 0) {
    await message.reply(`❌ **${name}** wasn't found in the database.`);
  } else {
    await message.reply(`🗑️ Removed **${deleted.map((d) => d.name).join(", ")}** from the database.`);
    logger.info({ names: deleted.map((d) => d.name) }, "Pokémon removed by owner");
  }
}

async function handleRename(message: Message, args: string[]): Promise<void> {
  const sep = args.indexOf("→") !== -1 ? "→" : "->";
  const sepIdx = args.indexOf(sep);
  if (sepIdx < 1 || sepIdx === args.length - 1) {
    await message.reply("Usage: `pk!rename <old> → <new>` or `pk!rename <old> -> <new>`");
    return;
  }
  const oldName = args.slice(0, sepIdx).join(" ");
  const newName = toTitleCase(args.slice(sepIdx + 1).join(" "));

  const results = await db
    .select({ hash: pokemonHashesTable.hash })
    .from(pokemonHashesTable)
    .where(ilike(pokemonHashesTable.name, oldName));

  if (results.length === 0) {
    await message.reply(`❌ **${oldName}** wasn't found in the database.`);
    return;
  }

  for (const row of results) {
    await db
      .update(pokemonHashesTable)
      .set({ name: newName })
      .where(ilike(pokemonHashesTable.name, oldName));
  }
  await message.reply(`✏️ Renamed **${results.length}** entr${results.length === 1 ? "y" : "ies"}: **${oldName}** → **${newName}**`);
}

async function handleTeach(message: Message, args: string[], key: string): Promise<void> {
  if (args.length === 0) {
    await message.reply("Usage: Reply to a Pokétwo spawn with `pk!teach <name>`");
    return;
  }
  const ref = message.reference;
  if (!ref?.messageId) {
    await message.reply("❌ You need to **reply to a Pokétwo spawn message** when using `pk!teach <name>`.");
    return;
  }

  const name = toTitleCase(cleanPokemonName(args.join(" ")));
  let targetMsg: Message;
  try {
    targetMsg = await message.channel.messages.fetch(ref.messageId) as Message;
  } catch {
    await message.reply("❌ Couldn't fetch the referenced message.");
    return;
  }

  const imageUrl = getImageUrl(targetMsg);
  if (!imageUrl) {
    await message.reply("❌ No image found in the referenced message.");
    return;
  }
  const imageBuffer = await downloadImage(imageUrl);
  if (!imageBuffer) {
    await message.reply("❌ Failed to download the image.");
    return;
  }

  const hash = await computeDHash(imageBuffer);
  await db
    .insert(pokemonHashesTable)
    .values({ hash, name })
    .onConflictDoUpdate({ target: pokemonHashesTable.hash, set: { name } });

  await message.reply(`✅ Taught **${name}** — permanently mapped.`);
  logger.info({ hash, name }, "Pokémon manually taught by owner");
}

async function handleGuess(message: Message): Promise<void> {
  const ref = message.reference;
  if (!ref?.messageId) {
    await message.reply("❌ Reply to a Pokétwo spawn message with `pk!guess`.");
    return;
  }

  let targetMsg: Message;
  try {
    targetMsg = await message.channel.messages.fetch(ref.messageId) as Message;
  } catch {
    await message.reply("❌ Couldn't fetch the referenced message.");
    return;
  }

  const imageUrl = getImageUrl(targetMsg);
  if (!imageUrl) {
    await message.reply("❌ No image found in the referenced message.");
    return;
  }
  const imageBuffer = await downloadImage(imageUrl);
  if (!imageBuffer) {
    await message.reply("❌ Failed to download the image.");
    return;
  }

  const hash = await computeDHash(imageBuffer);
  const allEntries = await db
    .select({ hash: pokemonHashesTable.hash, name: pokemonHashesTable.name })
    .from(pokemonHashesTable);

  if (allEntries.length === 0) {
    await message.reply("📖 No Pokémon learned yet — I have nothing to guess from.");
    return;
  }

  let bestMatch = allEntries[0];
  let bestDistance = hammingDistance(hash, allEntries[0].hash);
  for (const entry of allEntries.slice(1)) {
    const d = hammingDistance(hash, entry.hash);
    if (d < bestDistance) {
      bestDistance = d;
      bestMatch = entry;
    }
  }

  const confidence = (((64 - bestDistance) / 64) * 100).toFixed(1);
  const certain = bestDistance <= HAMMING_THRESHOLD;
  const prefix = certain ? "🎯" : "🤔 Best guess:";
  await message.reply(`${prefix} **${bestMatch.name}** (${confidence}%)`);
}

async function handlePending(message: Message): Promise<void> {
  if (pendingHashes.size === 0) {
    await message.reply("🟡 No pending spawns in memory right now.");
    return;
  }
  const lines = [...pendingHashes.entries()]
    .map(([k, v]) => `• \`${k}\` → \`${v.hash}\``)
    .join("\n");
  await message.reply(
    `🟡 **${pendingHashes.size} pending spawn(s):**\n${lines}\n\n` +
    `These will be learned when the Pokémon is caught or flees.`
  );
}

async function handleClearPending(message: Message): Promise<void> {
  const count = pendingHashes.size;
  pendingHashes.clear();
  await message.reply(`🧹 Cleared **${count}** pending spawn(s) from memory.`);
}

async function handleCleanDb(message: Message): Promise<void> {
  // Remove entries where name contains digits, parentheses, or is suspiciously long
  const deleted = await db
    .delete(pokemonHashesTable)
    .where(sql`name ~ '[0-9():]' OR length(name) > 40`)
    .returning({ name: pokemonHashesTable.name });

  if (deleted.length === 0) {
    await message.reply("✅ Database looks clean — nothing to remove.");
  } else {
    const names = deleted.map((d) => d.name).join(", ");
    await message.reply(
      `🧹 Removed **${deleted.length}** bad entr${deleted.length === 1 ? "y" : "ies"}:\n\`${names}\``
    );
    logger.info({ count: deleted.length }, "Bad DB entries cleaned by owner");
  }
}

async function handleHelp(message: Message): Promise<void> {
  await message.reply(
    `**Owner Commands** (prefix \`pk!\` or mention me)\n\n` +
    `\`pk!ping\` — check bot is alive\n` +
    `\`pk!stats\` — learned count, pending spawns, uptime\n` +
    `\`pk!pokedex\` — list every Pokémon the bot knows\n` +
    `\`pk!lookup <name>\` — check if a Pokémon is in the database\n` +
    `\`pk!forget <name>\` — remove a wrong mapping\n` +
    `\`pk!rename <old> → <new>\` — fix a wrong name\n` +
    `\`pk!teach <name>\` — reply to a spawn to manually teach it\n` +
    `\`pk!guess\` — reply to a spawn to get the bot's best guess\n` +
    `\`pk!pending\` — show unresolved spawns in memory\n` +
    `\`pk!clearpending\` — wipe all pending spawns\n` +
    `\`pk!cleandb\` — remove invalid entries (level/gender/IV garbage)\n` +
    `\`pk!help\` — show this list`
  );
}

// ── Pokétwo message handling ──────────────────────────────────────────────────

async function handlePoketwoMessage(
  message: Message,
  key: string,
  guildId: string | null,
  channelId: string
): Promise<void> {
  const content = message.content ?? "";
  const embeds = message.embeds ?? [];

  // ── Spawn detection ──
  const isSpawn =
    embeds.some(
      (e) =>
        (e.title ?? "").toLowerCase().includes("wild pokémon") ||
        (e.description ?? "").toLowerCase().includes("wild pokémon") ||
        (e.footer?.text ?? "").toLowerCase().includes("pokémon appeared")
    ) ||
    content.toLowerCase().includes("wild pokémon has appeared") ||
    content.toLowerCase().includes("a wild pokémon");

  if (isSpawn) {
    const imageUrl = getImageUrl(message);
    if (!imageUrl) return;

    const imageBuffer = await downloadImage(imageUrl);
    if (!imageBuffer) return;

    const hash = await computeDHash(imageBuffer);
    logger.info({ hash, channelId }, "Spawn detected — computed dHash");

    const existing = await lookupHash(hash);
    if (existing) {
      const confidence = (((64 - existing.distance) / 64) * 100).toFixed(1);
      logger.info({ name: existing.name, confidence }, "Recognized Pokémon — replying");
      await message.reply(`**${existing.name}** (${confidence}%)`);
    } else {
      if (pendingHashes.has(key)) {
        logger.info({ key }, "New spawn replaced old pending hash");
      }
      pendingHashes.set(key, { hash, channelId, guildId });
      logger.info({ hash, key }, "Unknown Pokémon — stored pending hash");
    }
    return;
  }

  // ── Catch detection ──
  if (content.toLowerCase().includes("congratulations") && content.toLowerCase().includes("caught")) {
    const name = extractCatchName(content);
    if (name) {
      await learnFromText(key, name, "catch");
      return;
    }
  }

  // Embed-based catch (some servers use embed confirmations)
  const isCatchEmbed = embeds.some(
    (e) =>
      (e.title ?? "").toLowerCase().includes("caught") ||
      (e.description ?? "").toLowerCase().includes("congratulations")
  );
  if (isCatchEmbed) {
    const embedText = embeds.map((e) => `${e.title ?? ""} ${e.description ?? ""}`).join(" ");
    const name = extractCatchName(embedText);
    if (name) {
      await learnFromText(key, name, "catch");
      return;
    }
  }

  // ── Flee detection ──
  const isFleeText =
    content.toLowerCase().includes("fled") ||
    content.toLowerCase().includes("ran away") ||
    content.toLowerCase().includes("got away");
  const isFleeEmbed = embeds.some(
    (e) =>
      (e.title ?? "").toLowerCase().includes("fled") ||
      (e.title ?? "").toLowerCase().includes("ran away") ||
      (e.description ?? "").toLowerCase().includes("fled") ||
      (e.description ?? "").toLowerCase().includes("ran away")
  );

  if (isFleeText || isFleeEmbed) {
    const name = extractFleeName(content, embeds);
    if (name) {
      await learnFromText(key, name, "flee");
    } else {
      logger.debug({ content: content.slice(0, 100) }, "Flee detected but couldn't extract name");
    }
    return;
  }
}

// ── Learning ──────────────────────────────────────────────────────────────────

async function learnFromText(
  key: string,
  name: string,
  source: "catch" | "flee"
): Promise<void> {
  const pending = pendingHashes.get(key);
  if (!pending) {
    logger.debug({ key, name, source }, "No pending hash for this channel — skipping");
    return;
  }

  pendingHashes.delete(key);

  const existing = await lookupHash(pending.hash);
  if (existing && existing.distance === 0) {
    logger.info({ name: existing.name }, "Exact hash already mapped — skipping");
    return;
  }

  await db
    .insert(pokemonHashesTable)
    .values({ hash: pending.hash, name })
    .onConflictDoUpdate({ target: pokemonHashesTable.hash, set: { name } });

  logger.info({ hash: pending.hash, name, source }, "✅ Learned new Pokémon mapping");
}

// ── Lookup ────────────────────────────────────────────────────────────────────

async function lookupHash(hash: string): Promise<{ name: string; distance: number } | null> {
  const allEntries = await db
    .select({ hash: pokemonHashesTable.hash, name: pokemonHashesTable.name })
    .from(pokemonHashesTable);

  let bestMatch: { name: string; distance: number } | null = null;
  let bestDistance = Infinity;

  for (const entry of allEntries) {
    const dist = hammingDistance(hash, entry.hash);
    if (dist < bestDistance) {
      bestDistance = dist;
      bestMatch = { name: entry.name, distance: dist };
    }
  }

  return bestDistance <= HAMMING_THRESHOLD && bestMatch ? bestMatch : null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 10000,
    });
    return Buffer.from(response.data);
  } catch (err) {
    logger.error({ err, url }, "Failed to download image");
    return null;
  }
}

function getImageUrl(message: Message): string | null {
  for (const embed of message.embeds) {
    if (embed.image?.url) return embed.image.url;
    if (embed.thumbnail?.url) return embed.thumbnail.url;
  }
  for (const [, attachment] of message.attachments) {
    const a = attachment as Attachment;
    if (a.contentType?.startsWith("image/")) return a.url;
  }
  return null;
}

function toTitleCase(str: string): string {
  return str
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .trim();
}
