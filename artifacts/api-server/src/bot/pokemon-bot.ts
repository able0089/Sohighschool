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

const POKETWO_BOT_ID = "716390085896962058";
const OWNER_ID = "1396815034247806999";
const HAMMING_THRESHOLD = 10;

type PendingEntry = {
  hash: string;
  channelId: string;
  guildId: string | null;
};

const pendingHashes = new Map<string, PendingEntry>();

function makeKey(guildId: string | null, channelId: string): string {
  return `${guildId ?? "dm"}:${channelId}`;
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
    logger.info({ tag: c.user.tag }, "Pokétwo bot logged in");
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

  if (message.author.bot && message.author.id === POKETWO_BOT_ID) {
    await handlePoketwoMessage(message, key, guildId, channelId);
    return;
  }

  if (!message.author.bot && message.author.id === OWNER_ID) {
    const content = message.content.trim();
    if (content === "!pokedex") {
      await handlePokedex(message);
      return;
    }
  }
}

async function handlePokedex(message: Message): Promise<void> {
  const entries = await db
    .select({ name: pokemonHashesTable.name, learnedAt: pokemonHashesTable.learnedAt })
    .from(pokemonHashesTable)
    .orderBy(pokemonHashesTable.name);

  const total = entries.length;

  if (total === 0) {
    await message.reply("📖 Pokédex is empty — no Pokémon learned yet. Let some spawn and get caught!");
    return;
  }

  const names = entries.map((e) => e.name);

  const chunks: string[] = [];
  let current = "";
  for (const name of names) {
    const line = `• ${name}\n`;
    if ((current + line).length > 1800) {
      chunks.push(current);
      current = line;
    } else {
      current += line;
    }
  }
  if (current) chunks.push(current);

  const header = `📖 **Pokédex — ${total} Pokémon learned**\n\n`;

  for (let i = 0; i < chunks.length; i++) {
    const prefix = i === 0 ? header : "";
    await message.reply(`${prefix}${chunks[i]}`);
  }

  logger.info({ total, requestedBy: message.author.id }, "Pokedex command used");
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
