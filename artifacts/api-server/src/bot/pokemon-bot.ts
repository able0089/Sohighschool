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
import { eq, ilike } from "drizzle-orm";

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

  if (message.author.id === OWNER_ID) {
    const parsed = parseCommand(message);
    if (parsed) {
      await handleOwnerCommand(message, parsed.cmd, parsed.args, key);
    }
  }
}

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

    case "teach":
      await handleTeach(message, args, key);
      break;

    case "pending":
      await handlePending(message);
      break;

    case "clearpending":
      await handleClearPending(message);
      break;

    case "help":
      await handleHelp(message);
      break;

    default:
      break;
  }
}

async function handleStats(message: Message): Promise<void> {
  const entries = await db
    .select({ name: pokemonHashesTable.name })
    .from(pokemonHashesTable);

  const total = entries.length;
  const pending = pendingHashes.size;

  const uptimeMs = Date.now() - startedAt;
  const uptimeHours = Math.floor(uptimeMs / 3600000);
  const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);
  const uptimeSecs = Math.floor((uptimeMs % 60000) / 1000);
  const uptime = `${uptimeHours}h ${uptimeMinutes}m ${uptimeSecs}s`;

  await message.reply(
    `📊 **Bot Stats**\n` +
    `• Pokémon learned: **${total}**\n` +
    `• Pending (unmatched spawns): **${pending}**\n` +
    `• Uptime: **${uptime}**`
  );
}

async function handlePokedex(message: Message): Promise<void> {
  const entries = await db
    .select({ name: pokemonHashesTable.name })
    .from(pokemonHashesTable)
    .orderBy(pokemonHashesTable.name);

  const total = entries.length;

  if (total === 0) {
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
    const header = i === 0 ? `📖 **Pokédex — ${total} learned**\n\n` : "";
    await message.reply(`${header}${chunks[i]}`);
  }

  logger.info({ total }, "Pokedex command used");
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
    const learned = results[0].learnedAt.toLocaleDateString("en-US", {
      year: "numeric", month: "short", day: "numeric",
    });
    await message.reply(`✅ **${results[0].name}** is in the database (learned ${learned}).`);
  }
}

async function handleForget(message: Message, args: string[]): Promise<void> {
  if (args.length === 0) {
    await message.reply("Usage: `pk!forget <name>`");
    return;
  }
  const name = toTitleCase(args.join(" "));
  const deleted = await db
    .delete(pokemonHashesTable)
    .where(ilike(pokemonHashesTable.name, name))
    .returning({ name: pokemonHashesTable.name });

  if (deleted.length === 0) {
    await message.reply(`❌ **${name}** wasn't found in the database.`);
  } else {
    await message.reply(`🗑️ Removed **${deleted[0].name}** from the database.`);
    logger.info({ name: deleted[0].name }, "Pokemon manually removed by owner");
  }
}

async function handleTeach(message: Message, args: string[], key: string): Promise<void> {
  if (args.length === 0) {
    await message.reply(
      "Usage: `pk!teach <name>` — reply to a Pokétwo spawn message with this command to manually teach it."
    );
    return;
  }

  const ref = message.reference;
  if (!ref?.messageId) {
    await message.reply("❌ You need to **reply to a Pokétwo spawn message** while using `pk!teach <name>`.");
    return;
  }

  const name = toTitleCase(args.join(" "));

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

  await message.reply(`✅ Taught **${name}** — this image is now permanently mapped.`);
  logger.info({ hash, name }, "Pokemon manually taught by owner");
}

async function handlePending(message: Message): Promise<void> {
  if (pendingHashes.size === 0) {
    await message.reply("🟡 No pending spawns in memory right now.");
    return;
  }

  const lines = [...pendingHashes.entries()]
    .map(([k, v]) => `• \`${k}\` — hash \`${v.hash}\``)
    .join("\n");

  await message.reply(
    `🟡 **${pendingHashes.size} pending spawn(s) in memory:**\n${lines}\n\n` +
    `These will be learned when the Pokémon is caught or flees.`
  );
}

async function handleClearPending(message: Message): Promise<void> {
  const count = pendingHashes.size;
  pendingHashes.clear();
  await message.reply(`🧹 Cleared **${count}** pending spawn(s) from memory.`);
  logger.info({ count }, "Pending hashes cleared by owner");
}

async function handleHelp(message: Message): Promise<void> {
  await message.reply(
    `**Owner Commands** (prefix: \`pk!\` or mention me)\n\n` +
    `\`pk!ping\` — check bot is alive\n` +
    `\`pk!stats\` — total learned, pending spawns, uptime\n` +
    `\`pk!pokedex\` — list every Pokémon the bot knows\n` +
    `\`pk!lookup <name>\` — check if a Pokémon is in the database\n` +
    `\`pk!forget <name>\` — remove a wrong mapping from the database\n` +
    `\`pk!teach <name>\` — reply to a spawn image to manually teach it\n` +
    `\`pk!pending\` — show unresolved spawns currently in memory\n` +
    `\`pk!clearpending\` — wipe all pending spawns from memory\n` +
    `\`pk!help\` — show this list`
  );
}

async function handlePoketwoMessage(
  message: Message,
  key: string,
  guildId: string | null,
  channelId: string
): Promise<void> {
  const content = message.content ?? "";
  const embeds = message.embeds ?? [];

  const isSpawn =
    embeds.some(
      (e) =>
        (e.title ?? "").toLowerCase().includes("wild pokémon") ||
        (e.description ?? "").toLowerCase().includes("wild pokémon") ||
        (e.footer?.text ?? "").toLowerCase().includes("pokémon appeared")
    ) ||
    content.toLowerCase().includes("wild pokémon has appeared") ||
    content.toLowerCase().includes("a wild pokémon") ||
    (embeds.length > 0 && embeds[0].image != null && content === "");

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

  const catchMatch = content.match(
    /congratulations .+?! you caught (the )?(?:level \d+ )?(.+?)!/i
  );
  if (catchMatch) {
    const name = toTitleCase(catchMatch[2].trim());
    await learnFromText(key, name, "catch");
    return;
  }

  const embedCatchMatch = embeds.some(
    (e) =>
      (e.title ?? "").toLowerCase().includes("pokémon caught") ||
      (e.description ?? "").toLowerCase().includes("you caught")
  );
  if (embedCatchMatch) {
    const embedText = embeds
      .map((e) => `${e.title ?? ""} ${e.description ?? ""}`)
      .join(" ");
    const nameMatch = embedText.match(/caught.*?(?:level \d+ )?([A-Za-z'-]+)(?:\.|!|\s*$)/i);
    if (nameMatch) {
      await learnFromText(key, toTitleCase(nameMatch[1].trim()), "catch");
    }
    return;
  }

  const fleeMatch = content.match(/wild (.+?) fled\./i);
  if (fleeMatch) {
    const name = toTitleCase(fleeMatch[1].trim());
    await learnFromText(key, name, "flee");
    return;
  }
}

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
  if (existing) {
    logger.info({ name: existing.name, hash: pending.hash }, "Hash already mapped — skipping insert");
    return;
  }

  await db
    .insert(pokemonHashesTable)
    .values({ hash: pending.hash, name })
    .onConflictDoNothing();

  logger.info({ hash: pending.hash, name, source }, "Learned new Pokémon mapping");
}

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

  if (bestDistance <= HAMMING_THRESHOLD && bestMatch) {
    return bestMatch;
  }

  return null;
}

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
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
