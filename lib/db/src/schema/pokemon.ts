import { pgTable, text, timestamp, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pokemonHashesTable = pgTable("pokemon_hashes", {
  id: serial("id").primaryKey(),
  hash: text("hash").notNull().unique(),
  name: text("name").notNull(),
  learnedAt: timestamp("learned_at").defaultNow().notNull(),
});

export const insertPokemonHashSchema = createInsertSchema(pokemonHashesTable).omit({ id: true, learnedAt: true });
export type InsertPokemonHash = z.infer<typeof insertPokemonHashSchema>;
export type PokemonHash = typeof pokemonHashesTable.$inferSelect;
