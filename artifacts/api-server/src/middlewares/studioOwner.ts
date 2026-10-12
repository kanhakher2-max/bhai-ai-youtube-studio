import { getAuth } from "@clerk/express";
import { asc } from "drizzle-orm";
import type { RequestHandler } from "express";
import { db, studioOwnersTable } from "@workspace/db";

export const requireStudioOwner: RequestHandler = async (req, res, next) => {
  try {
    const userId = getAuth(req).userId;
    if (!userId) {
      res.status(401).json({ error: "Sign in to use this studio." });
      return;
    }

    let [owner] = await db
      .select()
      .from(studioOwnersTable)
      .orderBy(asc(studioOwnersTable.createdAt))
      .limit(1);

    if (!owner) {
      await db
        .insert(studioOwnersTable)
        .values({ userId, role: "owner" })
        .onConflictDoNothing();
      [owner] = await db
        .select()
        .from(studioOwnersTable)
        .orderBy(asc(studioOwnersTable.createdAt))
        .limit(1);
    }

    if (owner?.userId !== userId) {
      res.status(403).json({
        error: "This is a single-owner studio and your account is not its owner.",
      });
      return;
    }

    next();
  } catch (error) {
    req.log.error({ err: error }, "Studio owner authorization failed");
    res.status(500).json({ error: "Unable to verify studio ownership." });
  }
};
