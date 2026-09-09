import { defineCollection, z } from "astro:content";

const docs = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.string(),
    order: z.number(),
    sourceVersion: z.string(),
    sourcePaths: z.array(z.string()),
    screenshots: z.array(z.string()).default([]),
  }),
});

export const collections = { docs };
