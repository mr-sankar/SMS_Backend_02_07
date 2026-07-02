import { Router } from "express";
import { db } from "@workspace/db";
import { announcementsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import multer from "multer";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireRole } from "../middlewares/auth";

const router = Router();
const ANNOUNCEMENT_READ = ["admin", "teacher", "student", "parent", "clerk", "accountant", "hostel_warden", "transport_manager", "driver", "store_manager", "vendor", "librarian"];
const ANNOUNCEMENT_WRITE = ["admin", "teacher", "clerk", "accountant", "hostel_warden", "transport_manager", "store_manager", "librarian", "driver"];
const objectStorage = new ObjectStorageService();
const attachmentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

function attachmentUploadMw(req, res, next) {
    attachmentUpload.single("file")(req, res, (err) => {
        if (!err) {
            next();
            return;
        }
        const e = err;
        if (e?.name === "MulterError" || (typeof e?.code === "string" && e.code.startsWith("LIMIT_"))) {
            if (e.code === "LIMIT_FILE_SIZE") {
                return res.status(413).json({ error: "File exceeds maximum size of 15 MB" });
            }
            if (e.code === "LIMIT_FILE_COUNT" || e.code === "LIMIT_UNEXPECTED_FILE") {
                return res.status(400).json({ error: "Exactly one file is allowed (multipart field 'file')" });
            }
            return res.status(400).json({ error: `Upload error: ${e.code ?? "unknown"}` });
        }
        next(err);
    });
}

function normalizeDbFileData(fileData) {
    if (!fileData)
        return null;
    if (Buffer.isBuffer(fileData))
        return fileData;
    if (fileData instanceof Uint8Array)
        return Buffer.from(fileData);
    if (typeof fileData === "string") {
        const hex = fileData.startsWith("\\x") ? fileData.slice(2) : fileData;
        return Buffer.from(hex, "hex");
    }
    return null;
}

function announcementAttachmentFileName(announcement) {
    if (announcement.attachmentName) {
        return String(announcement.attachmentName).replace(/["\r\n]/g, "").slice(0, 180) || `announcement-${announcement.id}`;
    }
    const safeTitle = String(announcement.title ?? "announcement").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "announcement";
    return `${safeTitle}-${announcement.id}`;
}

function parseOptionalDate(value) {
    if (!value)
        return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "invalid" : date;
}

function announcementState(announcement, now = new Date()) {
    const publishAt = announcement.publishAt ? new Date(announcement.publishAt) : null;
    const expiresAt = announcement.expiresAt ? new Date(announcement.expiresAt) : null;
    if (publishAt && publishAt > now)
        return "scheduled";
    if (expiresAt && expiresAt <= now)
        return "expired";
    return "active";
}

function isVisibleAnnouncement(announcement, now = new Date()) {
    return announcementState(announcement, now) === "active";
}

function normalizeAnnouncement(announcement, authorName, now = new Date()) {
    return {
        ...announcement,
        authorName,
        state: announcementState(announcement, now),
        createdAt: announcement.createdAt.toISOString(),
        publishAt: announcement.publishAt?.toISOString() ?? null,
        expiresAt: announcement.expiresAt?.toISOString() ?? null,
        attachmentUrl: (announcement.attachmentData || announcement.attachmentUrl) ? `/api/announcements/${announcement.id}/attachment` : null,
        attachmentName: announcement.attachmentName ?? null,
        attachmentMimeType: announcement.attachmentMimeType ?? null,
        attachmentSize: announcement.attachmentSize ?? null,
        attachmentData: undefined,
    };
}

function audiencesFor(role) {
    switch (role) {
        case "admin":
            return [];
        case "teacher":
            return ["all", "teachers", "staff"];
        case "student":
            return ["all", "students"];
        case "parent":
            return ["all", "parents"];
        case "hostel_warden":
            return ["all", "hostel"];
        case "store_manager":
            return ["all", "store"];
        case "transport_manager":
            return ["all", "transport"];
        case "accountant":
            return ["all", "accounts"];
        case "clerk":
            return ["all", "staff"];
        case "librarian":
            return ["all", "library"];
        case "vendor":
            return ["all", "vendors"];
        case "driver":
            return ["all", "transport"];
        default:
            return ["all"];
    }
}

async function canReadAnnouncementForUser(announcement, me, now = new Date()) {
    const allowed = audiencesFor(me.role);

    if (allowed.length > 0 && !allowed.includes(announcement.audience)) {
        return false;
    }

    if ((me.role === "student" || me.role === "parent") && announcement.classId != null) {
        const { resolveOwnClassIds } = await import("../lib/scope");
        const ownClassIds = new Set(await resolveOwnClassIds(me));
        if (!ownClassIds.has(announcement.classId))
            return false;
    }

    if (me.role !== "admin" && !isVisibleAnnouncement(announcement, now) && announcement.authorId !== me.id) {
        return false;
    }

    return true;
}

router.get("/announcements", requireRole(...ANNOUNCEMENT_READ), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });

        const me = req.user;
        const { audience, priority, q, state } = req.query;
        const now = new Date();
        const users = await db.select().from(usersTable);
        const userMap = Object.fromEntries(users.map((u) => [u.id, u.name]));

        let all = await db.select().from(announcementsTable);
        const allowed = audiencesFor(me.role);

        if (allowed.length > 0) {
            all = all.filter((a) => allowed.includes(a.audience));
        }

        if (me.role === "student" || me.role === "parent") {
            const { resolveOwnClassIds } = await import("../lib/scope");
            const ownClassIds = new Set(await resolveOwnClassIds(me));
            all = all.filter((a) => a.classId == null || ownClassIds.has(a.classId));
        }

        if (me.role !== "admin") {
            all = all.filter((a) => isVisibleAnnouncement(a, now) || a.authorId === me.id);
        }

        if (audience) {
            all = all.filter((a) => a.audience === String(audience));
        }

        if (priority) {
            all = all.filter((a) => a.priority === String(priority));
        }

        if (state) {
            all = all.filter((a) => announcementState(a, now) === String(state));
        }

        if (q) {
            const query = String(q).trim().toLowerCase();
            if (query) {
                all = all.filter((a) => a.title.toLowerCase().includes(query) || a.content.toLowerCase().includes(query));
            }
        }

        all.sort((a, b) => {
            const bTime = new Date(b.createdAt).getTime();
            const aTime = new Date(a.createdAt).getTime();
            if (bTime !== aTime)
                return bTime - aTime;
            return (b.id ?? 0) - (a.id ?? 0);
        });

        return res.json(all.map((a) => normalizeAnnouncement(a, userMap[a.authorId] ?? "Admin", now)));
    }
    catch (err) {
        req.log.error({ err }, "List announcements error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/announcements", requireRole(...ANNOUNCEMENT_WRITE), attachmentUploadMw, async (req, res) => {
    try {
        const me = req.user;
        const data = req.body;
        const file = req.file;
        const publishAt = parseOptionalDate(data.publishAt);
        const expiresAt = parseOptionalDate(data.expiresAt);

        if (!data.title || !data.content || !data.audience) {
            return res.status(400).json({ error: "Title, content, and audience are required" });
        }

        if (publishAt === "invalid") {
            return res.status(400).json({ error: "Invalid publishAt value" });
        }

        if (expiresAt === "invalid") {
            return res.status(400).json({ error: "Invalid expiresAt value" });
        }

        if (publishAt && expiresAt && expiresAt <= publishAt) {
            return res.status(400).json({ error: "Expiry must be later than the scheduled publish time" });
        }

        const [announcement] = await db.insert(announcementsTable).values({
            title: data.title,
            content: data.content,
            audience: data.audience,
            classId: data.classId ?? null,
            priority: data.priority ?? "normal",
            authorId: me.id,
            publishAt,
            expiresAt,
            attachmentUrl: null,
            attachmentName: file ? file.originalname.slice(0, 200) : data.attachmentName ?? null,
            attachmentMimeType: file ? file.mimetype : null,
            attachmentData: file ? file.buffer : null,
            attachmentSize: file ? String(file.size) : null,
        }).returning();

        return res.status(201).json(normalizeAnnouncement(announcement, me.name));
    }
    catch (err) {
        req.log.error({ err }, "Create announcement error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/announcements/:id", requireRole(...ANNOUNCEMENT_READ), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });

        const me = req.user;
        const all = await db.select().from(announcementsTable).where(eq(announcementsTable.id, parseInt(String(req.params.id))));

        if (!all[0])
            return res.status(404).json({ error: "Not found" });

        const announcement = all[0];
        if (!(await canReadAnnouncementForUser(announcement, me))) {
            return res.status(404).json({ error: "Not found" });
        }

        const users = await db.select().from(usersTable).where(eq(usersTable.id, announcement.authorId));
        return res.json(normalizeAnnouncement(announcement, users[0]?.name ?? "Admin"));
    }
    catch (err) {
        req.log.error({ err }, "Get announcement error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/announcements/:id/attachment", requireRole(...ANNOUNCEMENT_READ), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });

        const id = parseInt(String(req.params.id));
        const rows = await db.select().from(announcementsTable).where(eq(announcementsTable.id, id));
        const announcement = rows[0];
        if (!announcement)
            return res.status(404).json({ error: "Not found" });

        if (!(await canReadAnnouncementForUser(announcement, req.user))) {
            return res.status(404).json({ error: "Not found" });
        }

        const disposition = req.query.disposition === "attachment" ? "attachment" : "inline";
        const dbFile = normalizeDbFileData(announcement.attachmentData);
        if (dbFile) {
            res.setHeader("Content-Type", announcement.attachmentMimeType || "application/octet-stream");
            res.setHeader("Content-Length", String(dbFile.length));
            res.setHeader("Cache-Control", "private, max-age=0");
            res.setHeader("Content-Disposition", `${disposition}; filename="${announcementAttachmentFileName(announcement)}"`);
            return res.end(dbFile);
        }

        if (!announcement.attachmentUrl) {
            return res.status(404).json({ error: "No attachment" });
        }

        if (!announcement.attachmentUrl.startsWith("/objects/")) {
            if (announcement.attachmentUrl.startsWith("/api/uploads/") || announcement.attachmentUrl.startsWith("http://") || announcement.attachmentUrl.startsWith("https://")) {
                return res.redirect(announcement.attachmentUrl);
            }
            return res.status(404).json({ error: "File missing" });
        }

        try {
            const file = await objectStorage.getObjectEntityFile(announcement.attachmentUrl);
            const response = await objectStorage.downloadObject(file, 0);
            const buffer = Buffer.from(await response.arrayBuffer());
            const contentType = response.headers.get("content-type") || announcement.attachmentMimeType || "application/octet-stream";
            await db.update(announcementsTable).set({
                attachmentData: buffer,
                attachmentMimeType: contentType,
                attachmentName: announcement.attachmentName ?? announcementAttachmentFileName(announcement),
                attachmentSize: String(buffer.length),
            }).where(eq(announcementsTable.id, id));
            res.status(response.status);
            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Length", String(buffer.length));
            res.setHeader("Content-Disposition", `${disposition}; filename="${announcementAttachmentFileName(announcement)}"`);
            return res.end(buffer);
        }
        catch (e) {
            if (e instanceof ObjectNotFoundError) {
                return res.status(404).json({ error: "File missing" });
            }
            throw e;
        }
    }
    catch (err) {
        req.log.error({ err }, "Serve announcement attachment error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.delete("/announcements/:id", requireRole("admin"), async (req, res) => {
    try {
        await db.delete(announcementsTable).where(eq(announcementsTable.id, parseInt(String(req.params.id))));
        return res.status(204).send();
    }
    catch (err) {
        req.log.error({ err }, "Delete announcement error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
