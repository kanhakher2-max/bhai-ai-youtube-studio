import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const studioOwnersTable = pgTable(
  "studio_owners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("owner"),
    youtubeTokenCiphertext: text("youtube_token_ciphertext"),
    youtubeChannelId: text("youtube_channel_id"),
    youtubeChannelTitle: text("youtube_channel_title"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("studio_owners_user_id_idx").on(table.userId),
    uniqueIndex("studio_owners_role_idx").on(table.role),
  ],
);

export const studioProjectsTable = pgTable(
  "studio_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    idea: text("idea").notNull().default(""),
    language: text("language").notNull(),
    genre: text("genre").notNull(),
    targetMinutes: integer("target_minutes").notNull(),
    visualStyle: text("visual_style").notNull(),
    scriptText: text("script_text").notNull().default(""),
    status: text("status").notNull().default("concept"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("studio_projects_updated_at_idx").on(table.updatedAt)],
);

export const studioScenesTable = pgTable(
  "studio_scenes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => studioProjectsTable.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    title: text("title").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    action: text("action").notNull().default(""),
    dialogue: text("dialogue").notNull().default(""),
    narration: text("narration").notNull().default(""),
    background: text("background").notNull().default(""),
    camera: text("camera").notNull().default(""),
    visualPrompt: text("visual_prompt").notNull().default(""),
    audioNotes: text("audio_notes").notNull().default(""),
    assetPath: text("asset_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("studio_scenes_project_sequence_idx").on(
      table.projectId,
      table.sequence,
    ),
  ],
);

export const studioCharactersTable = pgTable(
  "studio_characters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    appearance: text("appearance").notNull().default(""),
    voiceNotes: text("voice_notes").notNull().default(""),
    visualStyle: text("visual_style").notNull().default(""),
    referencePath: text("reference_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("studio_characters_name_idx").on(table.name)],
);

export const studioJobsTable = pgTable(
  "studio_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => studioProjectsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    message: text("message").notNull().default("Waiting in queue"),
    error: text("error"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("studio_jobs_status_available_idx").on(
      table.status,
      table.availableAt,
    ),
    index("studio_jobs_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
  ],
);
