import { Router } from "express";
import { db } from "@workspace/db";
import { studyMaterialsTable, assignmentsTable, assignmentSubmissionsTable, lessonPlansTable, subjectsTable, classesTable, staffTable, studentsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import multer from "multer";
import { Readable } from "stream";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { requireRole } from "../middlewares/auth";
import { resolveStudentForUser as scopeResolveStudent, resolveChildrenForParent as scopeResolveChildren, resolveOwnClassIds } from "../lib/scope";
const router = Router();
const MAT_READ = ["admin", "teacher", "student", "parent", "store_manager", "librarian", "clerk"];
const MAT_WRITE = ["admin", "teacher", "store_manager"];
const ASSIGN_READ = ["admin", "teacher", "student", "parent", "clerk"];
const ASSIGN_WRITE = ["admin", "teacher"];
const LP_READ = ["admin", "teacher", "clerk"];
const LP_WRITE = ["admin", "teacher"];
const objectStorage = new ObjectStorageService();
function newestFirst(a, b) {
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    if (bTime !== aTime)
        return bTime - aTime;
    return (b.id ?? 0) - (a.id ?? 0);
}
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
// Local thin wrappers around the shared `scope.ts` helpers — preserve
// the existing call sites that pass a bare userId, while routing through
// the authoritative resolvers so parent-child linkage stays consistent.
async function resolveStudentForUser(userId) {
    // Load the user to get phone/email so the shared resolver can apply its
    // fallback rules. For internal callers we only need the user-id link.
    return scopeResolveStudent({ id: userId, role: "student" });
}
async function resolveChildrenForParent(userId) {
    // Need phone to resolve children — fetch the user row.
    const { usersTable } = await import("@workspace/db");
    const u = (await db.select().from(usersTable).where(eq(usersTable.id, userId)))[0];
    if (!u)
        return [];
    return scopeResolveChildren({ id: u.id, role: "parent", email: u.email, phone: u.phone });
}
// Teacher class scoping: which class IDs does this teacher own?
// A teacher owns a class either (a) by being the teacherId on classesTable,
// or (b) by having created an assignment for that class previously. Admin always passes.
async function teacherCanAccessAssignmentClass(userId, classId, role) {
    if (role === "admin")
        return true;
    if (role !== "teacher")
        return false;
    const cls = await db.select().from(classesTable).where(eq(classesTable.id, classId));
    const classTeacherId = cls[0]?.teacherId ?? null;
    if (classTeacherId != null) {
        // staff row -> userId mapping
        const staffRows = await db.select().from(staffTable).where(eq(staffTable.id, classTeacherId));
        const staffUserId = staffRows[0]?.userId ?? null;
        if (staffUserId === userId)
            return true;
    }
    // fallback: teacher previously created an assignment for this class
    const prior = await db.select().from(assignmentsTable).where(eq(assignmentsTable.classId, classId));
    return prior.some((a) => a.createdById === userId);
}
async function resolveStaffForUser(user) {
    if (!user)
        return null;
    const rows = await db.select().from(staffTable).where(eq(staffTable.userId, user.id));
    if (rows[0])
        return rows[0];
    const byEmail = user.email
        ? await db.select().from(staffTable).where(eq(staffTable.email, user.email))
        : [];
    return byEmail[0] ?? null;
}
async function resolveUploaderStaffId(user) {
    const staff = await resolveStaffForUser(user);
    if (staff?.id)
        return { id: staff.id, name: staff.name };
    const [fallbackStaff] = await db.select().from(staffTable);
    return { id: fallbackStaff?.id ?? 1, name: fallbackStaff?.name ?? "Teacher" };
}
function materialFileName(material) {
    if (material.fileName) {
        return String(material.fileName).replace(/["\r\n]/g, "").slice(0, 180) || `material-${material.id}`;
    }
    const safeTitle = String(material.title ?? "material").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "material";
    return `${safeTitle}-${material.id}`;
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
function lessonPlanFileName(plan) {
    if (plan.fileName) {
        return String(plan.fileName).replace(/["\r\n]/g, "").slice(0, 180) || `lesson-plan-${plan.id}`;
    }
    const safeTitle = String(plan.title ?? "lesson-plan").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "lesson-plan";
    return `${safeTitle}-${plan.id}`;
}
function assignmentAttachmentFileName(assignment) {
    if (assignment.attachmentName) {
        return String(assignment.attachmentName).replace(/["\r\n]/g, "").slice(0, 180) || `assignment-${assignment.id}`;
    }
    const safeTitle = String(assignment.title ?? "assignment").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "assignment";
    return `${safeTitle}-${assignment.id}`;
}
function submissionAttachmentFileName(submission) {
    if (submission.attachmentName) {
        return String(submission.attachmentName).replace(/["\r\n]/g, "").slice(0, 180) || `submission-${submission.id}`;
    }
    return `assignment-submission-${submission.id}`;
}
function validateAssignmentFile(file, res, label = "Attachment") {
    const allowed = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "text/plain",
    ];
    if (!allowed.includes(file.mimetype)) {
        res.status(400).json({ error: `${label} must be PDF, Word, PPT, image, or text` });
        return false;
    }
    return true;
}
async function ensureAssignmentReadable(req, res, assignment) {
    if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return false;
    }
    if (req.user.role === "admin")
        return true;
    if (req.user.role === "teacher") {
        const owns = await teacherCanAccessAssignmentClass(req.user.id, assignment.classId, "teacher");
        if (owns || assignment.createdById === req.user.id)
            return true;
    }
    if (req.user.role === "student") {
        const me = await resolveStudentForUser(req.user.id);
        if (me && me.classId === assignment.classId)
            return true;
    }
    if (req.user.role === "parent") {
        const kids = await resolveChildrenForParent(req.user.id);
        if (kids.some((k) => k.classId === assignment.classId))
            return true;
    }
    res.status(403).json({ error: "Forbidden" });
    return false;
}
async function ensureLessonPlanWritable(req, res, plan) {
    if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return false;
    }
    if (req.user.role === "admin")
        return true;
    if (req.user.role === "teacher") {
        const staff = await resolveStaffForUser(req.user);
        if (staff && plan.teacherId === staff.id)
            return true;
    }
    res.status(403).json({ error: "Forbidden" });
    return false;
}
async function ensureMaterialReadable(req, res, material) {
    if (!req.user) {
        res.status(401).json({ error: "Not authenticated" });
        return false;
    }
    if (req.user.role === "admin") {
        return true;
    }
    if (req.user.role === "teacher") {
        const owns = await teacherCanAccessAssignmentClass(req.user.id, material.classId, "teacher");
        if (owns) {
            return true;
        }
        const staff = await resolveStaffForUser(req.user);
        if (staff && material.uploadedById === staff.id) {
            return true;
        }
        res.status(403).json({ error: "Forbidden" });
        return false;
    }
    if (req.user.role === "student" || req.user.role === "parent") {
        const ownClassIds = new Set(await resolveOwnClassIds(req.user));
        if (!ownClassIds.has(material.classId)) {
            res.status(403).json({ error: "Forbidden" });
            return false;
        }
        return true;
    }
    if (MAT_READ.includes(req.user.role)) {
        return true;
    }
    res.status(403).json({ error: "Forbidden" });
    return false;
}
router.get("/materials", requireRole(...MAT_READ), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { subjectId, classId } = req.query;
        const subjects = await db.select().from(subjectsTable);
        const classes = await db.select().from(classesTable);
        const staff = await db.select().from(staffTable);
        const subjectMap = Object.fromEntries(subjects.map((s) => [s.id, s.name]));
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        const staffMap = Object.fromEntries(staff.map((s) => [s.id, s.name]));
        let all = await db.select().from(studyMaterialsTable);
        // Teacher view: only show materials uploaded by the current teacher.
        // This keeps one teacher's uploads out of other teachers' panels while
        // still allowing students in the matching class to see/download them.
        if (me.role === "teacher") {
            const myStaff = staff.find((s) => s.userId === me.id);
            const allowedUploaderIds = new Set([me.id]);
            if (myStaff?.id)
                allowedUploaderIds.add(myStaff.id);
            all = all.filter((m) => allowedUploaderIds.has(m.uploadedById));
        }
        // Student/parent: scope to own/children class(es)
        if (me.role === "student" || me.role === "parent") {
            const ownClassIds = new Set(await resolveOwnClassIds(me));
            if (classId) {
                const cid = parseInt(String(classId));
                if (!ownClassIds.has(cid))
                    return res.status(403).json({ error: "Forbidden" });
            }
            all = all.filter((m) => ownClassIds.has(m.classId));
        }
        if (subjectId)
            all = all.filter((m) => m.subjectId === parseInt(String(subjectId)));
        if (classId)
            all = all.filter((m) => m.classId === parseInt(String(classId)));
        all.sort(newestFirst);
        return res.json(all.map((m) => ({
            ...m,
            fileData: undefined,
            fileUrl: (m.fileData || m.fileUrl) ? `/api/materials/${m.id}/file` : null,
            subjectName: subjectMap[m.subjectId] ?? `Subject ${m.subjectId}`,
            className: classMap[m.classId] ?? `Class ${m.classId}`,
            uploadedBy: staffMap[m.uploadedById] ?? "Teacher",
            uploadedAt: m.createdAt.toISOString(),
        })));
    }
    catch (err) {
        req.log.error({ err }, "List materials error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/materials", requireRole(...MAT_WRITE), async (req, res) => {
    try {
        const data = req.body;
        if (req.user?.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = await resolveTeacherClassIds(req.user.id);
            if (!classIds.includes(Number(data.classId))) {
                return res.status(403).json({ error: "Forbidden", details: "Teachers can only upload materials for their assigned classes" });
            }
        }
        const uploader = await resolveUploaderStaffId(req.user);
        const [material] = await db.insert(studyMaterialsTable).values({
            title: data.title,
            description: data.description ?? null,
            type: data.type,
            fileUrl: data.fileUrl ?? null,
            subjectId: data.subjectId,
            classId: data.classId,
            uploadedById: uploader.id,
        }).returning();
        const subjects = await db.select().from(subjectsTable).where(eq(subjectsTable.id, data.subjectId));
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, data.classId));
        return res.status(201).json({
            ...material,
            fileData: undefined,
            fileUrl: (material.fileData || material.fileUrl) ? `/api/materials/${material.id}/file` : null,
            subjectName: subjects[0]?.name ?? `Subject ${data.subjectId}`,
            className: classes[0] ? `${classes[0].grade}-${classes[0].section}` : `Class ${data.classId}`,
            uploadedBy: "Teacher",
            uploadedAt: material.createdAt.toISOString(),
        });
    }
    catch (err) {
        req.log.error({ err }, "Create material error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/materials/upload", requireRole(...MAT_WRITE), attachmentUploadMw, async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: "File required (multipart field 'file')" });
        }
        const title = String(req.body.title ?? "").trim();
        const type = String(req.body.type ?? "other").trim() || "other";
        const subjectId = Number(req.body.subjectId);
        const classId = Number(req.body.classId);
        if (!title || !Number.isInteger(subjectId) || !Number.isInteger(classId)) {
            return res.status(400).json({ error: "Title, subjectId and classId are required" });
        }
        if (req.user.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = await resolveTeacherClassIds(req.user.id);
            if (!classIds.includes(classId)) {
                return res.status(403).json({ error: "Forbidden", details: "Teachers can only upload materials for their assigned classes" });
            }
        }
        const allowed = [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "image/png",
            "image/jpeg",
            "image/jpg",
            "image/webp",
            "image/gif",
            "video/mp4",
            "video/webm",
            "video/ogg",
            "text/plain",
        ];
        if (!allowed.includes(file.mimetype)) {
            return res.status(400).json({ error: "Material must be PDF, Word, PPT, image, video, or text" });
        }
        const uploader = await resolveUploaderStaffId(req.user);
        const [material] = await db.insert(studyMaterialsTable).values({
            title,
            description: req.body.description ? String(req.body.description) : null,
            type,
            fileUrl: null,
            fileName: file.originalname.slice(0, 200),
            mimeType: file.mimetype,
            fileData: file.buffer,
            fileSize: String(file.size),
            subjectId,
            classId,
            uploadedById: uploader.id,
        }).returning();
        const subjects = await db.select().from(subjectsTable).where(eq(subjectsTable.id, subjectId));
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, classId));
        return res.status(201).json({
            ...material,
            fileData: undefined,
            fileUrl: `/api/materials/${material.id}/file`,
            subjectName: subjects[0]?.name ?? `Subject ${subjectId}`,
            className: classes[0] ? `${classes[0].grade}-${classes[0].section}` : `Class ${classId}`,
            uploadedBy: uploader.name,
            uploadedAt: material.createdAt.toISOString(),
        });
    }
    catch (err) {
        req.log.error({ err }, "Upload material file error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/materials/:id", requireRole(...MAT_WRITE), async (req, res) => {
    try {
        if (req.user?.role === "teacher") {
            const staff = await resolveStaffForUser(req.user);
            const [material] = await db.select().from(studyMaterialsTable).where(eq(studyMaterialsTable.id, parseInt(String(req.params.id))));
            if (!material || !staff || material.uploadedById !== staff.id) {
                return res.status(403).json({ error: "Forbidden", details: "You can only delete your own study materials" });
            }
        }
        await db.delete(studyMaterialsTable).where(eq(studyMaterialsTable.id, parseInt(String(req.params.id))));
        return res.status(204).send();
    }
    catch (err) {
        req.log.error({ err }, "Delete material error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/materials/:id/file", requireRole(...MAT_READ), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const [material] = await db.select().from(studyMaterialsTable).where(eq(studyMaterialsTable.id, id));
        if (!material) {
            return res.status(404).json({ error: "Material not found" });
        }
        const dbFile = normalizeDbFileData(material.fileData);
        if (!dbFile && !material.fileUrl) {
            return res.status(404).json({ error: "No file attached" });
        }
        if (!(await ensureMaterialReadable(req, res, material))) {
            return;
        }
        const disposition = req.query.disposition === "attachment" ? "attachment" : "inline";
        if (disposition === "attachment") {
            await db.update(studyMaterialsTable).set({ downloadCount: (material.downloadCount ?? 0) + 1 }).where(eq(studyMaterialsTable.id, id));
        }
        else {
            await db.update(studyMaterialsTable).set({ viewCount: (material.viewCount ?? 0) + 1 }).where(eq(studyMaterialsTable.id, id));
        }
        if (dbFile) {
            res.setHeader("Content-Type", material.mimeType || "application/octet-stream");
            res.setHeader("Content-Length", String(dbFile.length));
            res.setHeader("Cache-Control", "private, max-age=0");
            res.setHeader("Content-Disposition", `${disposition}; filename="${materialFileName(material)}"`);
            return res.end(dbFile);
        }
        if (!material.fileUrl.startsWith("/objects/")) {
            if (material.fileUrl.startsWith("/api/uploads/") || material.fileUrl.startsWith("http://") || material.fileUrl.startsWith("https://")) {
                return res.redirect(material.fileUrl);
            }
            return res.status(404).json({ error: "File missing" });
        }
        try {
            const file = await objectStorage.getObjectEntityFile(material.fileUrl);
            const response = await objectStorage.downloadObject(file, 0);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const contentType = response.headers.get("content-type") || material.mimeType || "application/octet-stream";
            await db.update(studyMaterialsTable).set({
                fileData: buffer,
                mimeType: contentType,
                fileName: material.fileName ?? materialFileName(material),
                fileSize: String(buffer.length),
            }).where(eq(studyMaterialsTable.id, id));
            res.status(response.status);
            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Length", String(buffer.length));
            res.setHeader("Cache-Control", "private, max-age=0");
            res.setHeader("Content-Disposition", `${disposition}; filename="${materialFileName(material)}"`);
            res.end(buffer);
        }
        catch (e) {
            if (e instanceof ObjectNotFoundError) {
                return res.status(404).json({ error: "File missing" });
            }
            throw e;
        }
    }
    catch (err) {
        req.log.error({ err }, "Download material file error");
        if (!res.headersSent)
            res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/assignments", requireRole(...ASSIGN_READ), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const { classId, subjectId } = req.query;
        const subjects = await db.select().from(subjectsTable);
        const classes = await db.select().from(classesTable);
        const subjectMap = Object.fromEntries(subjects.map((s) => [s.id, s.name]));
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        let all = await db.select().from(assignmentsTable);
        // Student/parent: only assignments for own/children's class
        if (me.role === "student" || me.role === "parent") {
            const ownClassIds = new Set(await resolveOwnClassIds(me));
            if (classId) {
                const cid = parseInt(String(classId));
                if (!ownClassIds.has(cid))
                    return res.status(403).json({ error: "Forbidden" });
            }
            all = all.filter((a) => ownClassIds.has(a.classId));
        } else if (me.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = new Set(await resolveTeacherClassIds(me.id));
            if (classId && !classIds.has(parseInt(String(classId))))
                return res.status(403).json({ error: "Forbidden", details: "Teacher not associated with this class" });
            all = all.filter((a) => classIds.has(a.classId));
        }
        if (classId)
            all = all.filter((a) => a.classId === parseInt(String(classId)));
        if (subjectId)
            all = all.filter((a) => a.subjectId === parseInt(String(subjectId)));
        all.sort(newestFirst);
        return res.json(all.map((a) => ({
            ...a,
            attachmentData: undefined,
            attachmentUrl: (a.attachmentData || a.attachmentUrl) ? `/api/assignments/${a.id}/attachment` : null,
            subjectName: subjectMap[a.subjectId] ?? `Subject ${a.subjectId}`,
            className: classMap[a.classId] ?? `Class ${a.classId}`,
            createdAt: a.createdAt.toISOString(),
        })));
    }
    catch (err) {
        req.log.error({ err }, "List assignments error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/assignments", requireRole(...ASSIGN_WRITE), attachmentUploadMw, async (req, res) => {
    try {
        const data = req.body;
        if (req.user?.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = await resolveTeacherClassIds(req.user.id);
            if (!classIds.includes(Number(data.classId))) {
                return res.status(403).json({ error: "Forbidden", details: "Teachers can only create assignments for their assigned classes" });
            }
        }
        const file = req.file;
        const fileValues = {};
        if (file) {
            if (!validateAssignmentFile(file, res))
                return;
            fileValues.attachmentName = file.originalname.slice(0, 200);
            fileValues.attachmentMimeType = file.mimetype;
            fileValues.attachmentData = file.buffer;
            fileValues.attachmentSize = String(file.size);
        }
        const [assignment] = await db.insert(assignmentsTable).values({
            title: data.title,
            description: data.description ?? null,
            subjectId: Number(data.subjectId),
            classId: Number(data.classId),
            dueDate: data.dueDate,
            maxMarks: Number(data.maxMarks),
            attachmentUrl: data.attachmentUrl ?? null,
            status: "published",
            createdById: req.user?.id ?? 1,
            ...fileValues,
        }).returning();
        const subjects = await db.select().from(subjectsTable).where(eq(subjectsTable.id, data.subjectId));
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, data.classId));
        return res.status(201).json({
            ...assignment,
            attachmentData: undefined,
            attachmentUrl: (assignment.attachmentData || assignment.attachmentUrl) ? `/api/assignments/${assignment.id}/attachment` : null,
            subjectName: subjects[0]?.name ?? `Subject ${data.subjectId}`,
            className: classes[0] ? `${classes[0].grade}-${classes[0].section}` : `Class ${data.classId}`,
            createdAt: assignment.createdAt.toISOString(),
        });
    }
    catch (err) {
        req.log.error({ err }, "Create assignment error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Must be registered BEFORE /assignments/:id so the param matcher doesn't swallow it.
router.get("/assignments/my-submissions", requireRole("student"), async (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        if (req.user.role !== "student") {
            res.status(403).json({ error: "Forbidden", details: "Only students have submissions" });
            return;
        }
        const me = await resolveStudentForUser(req.user.id);
        if (!me) {
            res.status(404).json({ error: "Student profile not found" });
            return;
        }
        const subs = await db.select().from(assignmentSubmissionsTable).where(eq(assignmentSubmissionsTable.studentId, me.id));
        res.json(subs.map((s) => ({
            ...s,
            attachmentData: undefined,
            fileUrl: (s.attachmentData || s.attachmentUrl) ? `/api/assignment-submissions/${s.id}/file` : null,
            submittedAt: s.submittedAt.toISOString()
        })));
    }
    catch (err) {
        req.log.error({ err }, "My submissions error");
        res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/assignments/:id", requireRole(...ASSIGN_READ), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const all = await db.select().from(assignmentsTable).where(eq(assignmentsTable.id, parseInt(String(req.params.id))));
        if (!all[0])
            return res.status(404).json({ error: "Not found" });
        const a = all[0];
        // Student/parent must be in the assignment's class
        if (me.role === "student") {
            const s = await resolveStudentForUser(me.id);
            if (!s || s.classId !== a.classId)
                return res.status(403).json({ error: "Forbidden" });
        }
        else if (me.role === "parent") {
            const kids = await resolveChildrenForParent(me.id);
            if (!kids.some((k) => k.classId === a.classId))
                return res.status(403).json({ error: "Forbidden" });
        }
        const subjects = await db.select().from(subjectsTable).where(eq(subjectsTable.id, a.subjectId));
        const classes = await db.select().from(classesTable).where(eq(classesTable.id, a.classId));
        return res.json({
            ...a,
            subjectName: subjects[0]?.name ?? `Subject ${a.subjectId}`,
            className: classes[0] ? `${classes[0].grade}-${classes[0].section}` : `Class ${a.classId}`,
            createdAt: a.createdAt.toISOString(),
        });
    }
    catch (err) {
        req.log.error({ err }, "Get assignment error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/assignments/:id", requireRole(...ASSIGN_WRITE), async (req, res) => {
    try {
        const assignmentId = parseInt(String(req.params.id));
        const [existing] = await db.select().from(assignmentsTable).where(eq(assignmentsTable.id, assignmentId));
        if (!existing) {
            return res.status(404).json({ error: "Not found" });
        }
        if (req.user?.role === "teacher") {
            const isCreator = existing.createdById === req.user.id;
            const canAccessClass = await teacherCanAccessAssignmentClass(req.user.id, existing.classId, "teacher");
            if (!isCreator && !canAccessClass) {
                return res.status(403).json({ error: "Forbidden", details: "You are not authorized to modify this assignment" });
            }
        }
        const data = req.body;
        const upd = {};
        if (data.title !== undefined)
            upd.title = data.title;
        if (data.description !== undefined)
            upd.description = data.description;
        if (data.dueDate !== undefined)
            upd.dueDate = data.dueDate;
        if (data.status !== undefined)
            upd.status = data.status;
        const [updated] = await db.update(assignmentsTable).set(upd).where(eq(assignmentsTable.id, assignmentId)).returning();
        return res.json({ ...updated, subjectName: `Subject ${updated.subjectId}`, className: `Class ${updated.classId}`, createdAt: updated.createdAt.toISOString() });
    }
    catch (err) {
        req.log.error({ err }, "Update assignment error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/assignments/:id", requireRole(...ASSIGN_WRITE), async (req, res) => {
    try {
        const assignmentId = parseInt(String(req.params.id));
        const [existing] = await db.select().from(assignmentsTable).where(eq(assignmentsTable.id, assignmentId));
        if (!existing) {
            return res.status(404).json({ error: "Not found" });
        }
        if (req.user?.role === "teacher") {
            const isCreator = existing.createdById === req.user.id;
            const canAccessClass = await teacherCanAccessAssignmentClass(req.user.id, existing.classId, "teacher");
            if (!isCreator && !canAccessClass) {
                return res.status(403).json({ error: "Forbidden", details: "You are not authorized to delete this assignment" });
            }
        }
        await db.delete(assignmentsTable).where(eq(assignmentsTable.id, assignmentId));
        return res.status(204).send();
    }
    catch (err) {
        req.log.error({ err }, "Delete assignment error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
// Teacher / admin uploads an attachment PDF/doc for an assignment.
// Server ingests file directly and writes to GCS; vendor pattern.
router.post("/assignments/:id/attachment", requireRole(...ASSIGN_WRITE), attachmentUploadMw, async (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        if (!["admin", "teacher"].includes(req.user.role)) {
            res.status(403).json({ error: "Only teachers or admins can upload attachments" });
            return;
        }
        const id = parseInt(String(req.params.id));
        const existing = await db.select().from(assignmentsTable).where(eq(assignmentsTable.id, id));
        if (!existing[0]) {
            res.status(404).json({ error: "Not found" });
            return;
        }
        // Teacher must own the assignment (creator) OR teach the class. Admin bypasses.
        if (req.user.role === "teacher" && existing[0].createdById !== req.user.id) {
            const owns = await teacherCanAccessAssignmentClass(req.user.id, existing[0].classId, "teacher");
            if (!owns) {
                res.status(403).json({ error: "Not your assignment / class" });
                return;
            }
        }
        const file = req.file;
        if (!file) {
            res.status(400).json({ error: "File required (multipart field 'file')" });
            return;
        }
        if (!validateAssignmentFile(file, res)) {
            return;
        }
        const [updated] = await db.update(assignmentsTable)
            .set({
                attachmentUrl: null,
                attachmentName: file.originalname.slice(0, 200),
                attachmentMimeType: file.mimetype,
                attachmentData: file.buffer,
                attachmentSize: String(file.size),
            })
            .where(eq(assignmentsTable.id, id))
            .returning();
        res.json({
            ...updated,
            attachmentData: undefined,
            attachmentUrl: `/api/assignments/${updated.id}/attachment`,
            createdAt: updated.createdAt.toISOString()
        });
    }
    catch (err) {
        req.log.error({ err }, "Upload assignment attachment error");
        res.status(500).json({ error: "Internal server error" });
    }
});
// Download attachment — any authenticated user in the same class, plus teacher/admin.
router.get("/assignments/:id/attachment", requireRole(...ASSIGN_READ), async (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        const id = parseInt(String(req.params.id));
        const existing = await db.select().from(assignmentsTable).where(eq(assignmentsTable.id, id));
        const a = existing[0];
        if (!a) {
            res.status(404).json({ error: "Not found" });
            return;
        }
        const dbFile = normalizeDbFileData(a.attachmentData);
        if (!dbFile && !a.attachmentUrl) {
            res.status(404).json({ error: "No attachment" });
            return;
        }
        if (!(await ensureAssignmentReadable(req, res, a))) {
            return;
        }
        const disposition = req.query.disposition === "attachment" ? "attachment" : "inline";
        if (dbFile) {
            res.setHeader("Content-Type", a.attachmentMimeType || "application/octet-stream");
            res.setHeader("Content-Length", String(dbFile.length));
            res.setHeader("Cache-Control", "private, max-age=0");
            res.setHeader("Content-Disposition", `${disposition}; filename="${assignmentAttachmentFileName(a)}"`);
            return res.end(dbFile);
        }
        if (!a.attachmentUrl.startsWith("/objects/")) {
            if (a.attachmentUrl.startsWith("/api/uploads/") || a.attachmentUrl.startsWith("http://") || a.attachmentUrl.startsWith("https://")) {
                return res.redirect(a.attachmentUrl);
            }
            return res.status(404).json({ error: "File missing" });
        }
        try {
            const file = await objectStorage.getObjectEntityFile(a.attachmentUrl);
            const response = await objectStorage.downloadObject(file, 0);
            const buffer = Buffer.from(await response.arrayBuffer());
            const contentType = response.headers.get("content-type") || a.attachmentMimeType || "application/octet-stream";
            await db.update(assignmentsTable).set({
                attachmentData: buffer,
                attachmentMimeType: contentType,
                attachmentName: a.attachmentName ?? assignmentAttachmentFileName(a),
                attachmentSize: String(buffer.length),
            }).where(eq(assignmentsTable.id, id));
            res.status(response.status);
            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Length", String(buffer.length));
            res.setHeader("Content-Disposition", `${disposition}; filename="${assignmentAttachmentFileName(a)}"`);
            res.end(buffer);
        }
        catch (e) {
            if (e instanceof ObjectNotFoundError) {
                res.status(404).json({ error: "File missing" });
                return;
            }
            throw e;
        }
    }
    catch (err) {
        req.log.error({ err }, "Download assignment attachment error");
        if (!res.headersSent)
            res.status(500).json({ error: "Internal server error" });
    }
});
// Student submits / marks an assignment complete.
router.post("/assignments/:id/submit", requireRole("student"), attachmentUploadMw, async (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        if (req.user.role !== "student") {
            res.status(403).json({ error: "Only students can submit" });
            return;
        }
        const id = parseInt(String(req.params.id));
        const existing = await db.select().from(assignmentsTable).where(eq(assignmentsTable.id, id));
        const a = existing[0];
        if (!a) {
            res.status(404).json({ error: "Not found" });
            return;
        }
        const me = await resolveStudentForUser(req.user.id);
        if (!me || me.classId !== a.classId) {
            res.status(403).json({ error: "Not your class" });
            return;
        }
        const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 1000) : null;
        const attachmentUrl = typeof req.body?.attachmentUrl === "string" ? req.body.attachmentUrl : null;
        const file = req.file;
        const fileValues = {};
        if (file) {
            if (!validateAssignmentFile(file, res, "Submission"))
                return;
            fileValues.attachmentName = file.originalname.slice(0, 200);
            fileValues.attachmentMimeType = file.mimetype;
            fileValues.attachmentData = file.buffer;
            fileValues.attachmentSize = String(file.size);
        }
        // Idempotent under concurrency: ON CONFLICT DO NOTHING on the unique
        // (assignment_id, student_id) index, then read back the row.
        await db.insert(assignmentSubmissionsTable).values({
            assignmentId: id, studentId: me.id, notes, attachmentUrl, status: "submitted", ...fileValues,
        }).onConflictDoNothing({ target: [assignmentSubmissionsTable.assignmentId, assignmentSubmissionsTable.studentId] });
        const rows = await db.select().from(assignmentSubmissionsTable)
            .where(and(eq(assignmentSubmissionsTable.assignmentId, id), eq(assignmentSubmissionsTable.studentId, me.id)));
        const row = rows[0];
        res.status(201).json({ ...row, attachmentData: undefined, fileUrl: row.attachmentData ? `/api/assignments/submissions/${row.id}/file` : null, submittedAt: row.submittedAt.toISOString() });
    }
    catch (err) {
        req.log.error({ err }, "Submit assignment error");
        res.status(500).json({ error: "Internal server error" });
    }
});
// Student withdraws their submission.
router.delete("/assignments/:id/submit", requireRole("student"), async (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        if (req.user.role !== "student") {
            res.status(403).json({ error: "Only students can withdraw" });
            return;
        }
        const id = parseInt(String(req.params.id));
        const me = await resolveStudentForUser(req.user.id);
        if (!me) {
            res.status(404).json({ error: "Student profile missing" });
            return;
        }
        await db.delete(assignmentSubmissionsTable)
            .where(and(eq(assignmentSubmissionsTable.assignmentId, id), eq(assignmentSubmissionsTable.studentId, me.id)));
        res.status(204).send();
    }
    catch (err) {
        req.log.error({ err }, "Withdraw assignment error");
        res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/assignment-submissions", requireRole(...ASSIGN_WRITE), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        let assignments = await db.select().from(assignmentsTable);
        if (req.user.role === "teacher") {
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = new Set(await resolveTeacherClassIds(req.user.id));
            assignments = assignments.filter((a) => classIds.has(a.classId));
        }
        const assignmentMap = Object.fromEntries(assignments.map((a) => [a.id, a]));
        const assignmentIds = new Set(assignments.map((a) => a.id));
        const subs = (await db.select().from(assignmentSubmissionsTable)).filter((s) => assignmentIds.has(s.assignmentId));
        const students = await db.select().from(studentsTable);
        const classes = await db.select().from(classesTable);
        const subjects = await db.select().from(subjectsTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s]));
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        const subjectMap = Object.fromEntries(subjects.map((s) => [s.id, s.name]));
        return res.json(subs.map((s) => {
            const assignment = assignmentMap[s.assignmentId];
            const student = studentMap[s.studentId];
            return {
                ...s,
                attachmentData: undefined,
                fileUrl: (s.attachmentData || s.attachmentUrl) ? `/api/assignment-submissions/${s.id}/file` : null,
                assignmentTitle: assignment?.title ?? `Assignment ${s.assignmentId}`,
                className: assignment ? classMap[assignment.classId] ?? `Class ${assignment.classId}` : "",
                subjectName: assignment ? subjectMap[assignment.subjectId] ?? `Subject ${assignment.subjectId}` : "",
                studentName: student?.name ?? `Student ${s.studentId}`,
                studentAdmissionNo: student?.admissionNo ?? student?.rollNumber ?? "",
                submittedAt: s.submittedAt.toISOString(),
            };
        }));
    }
    catch (err) {
        req.log.error({ err }, "List all submissions error");
        res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/assignment-submissions/:submissionId/file", requireRole("admin", "teacher", "student"), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const submissionId = parseInt(String(req.params.submissionId));
        const [submission] = await db.select().from(assignmentSubmissionsTable).where(eq(assignmentSubmissionsTable.id, submissionId));
        if (!submission)
            return res.status(404).json({ error: "Submission not found" });
        const [assignment] = await db.select().from(assignmentsTable).where(eq(assignmentsTable.id, submission.assignmentId));
        if (!assignment)
            return res.status(404).json({ error: "Assignment not found" });
        if (req.user.role === "student") {
            const me = await resolveStudentForUser(req.user.id);
            if (!me || me.id !== submission.studentId)
                return res.status(403).json({ error: "Forbidden" });
        }
        else if (!(await ensureAssignmentReadable(req, res, assignment))) {
            return;
        }
        const dbFile = normalizeDbFileData(submission.attachmentData);
        if (!dbFile)
            return res.status(404).json({ error: "No file attached" });
        const disposition = req.query.disposition === "attachment" ? "attachment" : "inline";
        res.setHeader("Content-Type", submission.attachmentMimeType || "application/octet-stream");
        res.setHeader("Content-Length", String(dbFile.length));
        res.setHeader("Cache-Control", "private, max-age=0");
        res.setHeader("Content-Disposition", `${disposition}; filename="${submissionAttachmentFileName(submission)}"`);
        return res.end(dbFile);
    }
    catch (err) {
        req.log.error({ err }, "Download submission file error");
        res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/assignment-submissions/:submissionId", requireRole(...ASSIGN_WRITE), async (req, res) => {
    try {
        const submissionId = parseInt(String(req.params.submissionId));
        const [submission] = await db.select().from(assignmentSubmissionsTable).where(eq(assignmentSubmissionsTable.id, submissionId));
        if (!submission)
            return res.status(404).json({ error: "Submission not found" });
        const [assignment] = await db.select().from(assignmentsTable).where(eq(assignmentsTable.id, submission.assignmentId));
        if (!assignment)
            return res.status(404).json({ error: "Assignment not found" });
        if (!(await ensureAssignmentReadable(req, res, assignment)))
            return;
        const status = String(req.body?.status ?? "");
        if (!["approved", "rejected", "submitted"].includes(status))
            return res.status(400).json({ error: "Invalid status" });
        const [updated] = await db.update(assignmentSubmissionsTable).set({ status }).where(eq(assignmentSubmissionsTable.id, submissionId)).returning();
        res.json({ ...updated, attachmentData: undefined, fileUrl: updated.attachmentData ? `/api/assignment-submissions/${updated.id}/file` : null, submittedAt: updated.submittedAt.toISOString() });
    }
    catch (err) {
        req.log.error({ err }, "Update submission error");
        res.status(500).json({ error: "Internal server error" });
    }
});
// Teacher / admin views all submissions for an assignment.
router.get("/assignments/:id/submissions", requireRole(...ASSIGN_WRITE), async (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: "Not authenticated" });
            return;
        }
        if (!["admin", "teacher"].includes(req.user.role)) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        const id = parseInt(String(req.params.id));
        const a = (await db.select().from(assignmentsTable).where(eq(assignmentsTable.id, id)))[0];
        if (!a) {
            res.status(404).json({ error: "Not found" });
            return;
        }
        if (req.user.role === "teacher" && a.createdById !== req.user.id) {
            const owns = await teacherCanAccessAssignmentClass(req.user.id, a.classId, "teacher");
            if (!owns) {
                res.status(403).json({ error: "Not your assignment / class" });
                return;
            }
        }
        const subs = await db.select().from(assignmentSubmissionsTable).where(eq(assignmentSubmissionsTable.assignmentId, id));
        const students = await db.select().from(studentsTable);
        const studentMap = Object.fromEntries(students.map((s) => [s.id, s.name]));
        res.json(subs.map((s) => ({
            ...s,
            attachmentData: undefined,
            fileUrl: (s.attachmentData || s.attachmentUrl) ? `/api/assignment-submissions/${s.id}/file` : null,
            studentName: studentMap[s.studentId] ?? `Student ${s.studentId}`,
            submittedAt: s.submittedAt.toISOString(),
        })));
    }
    catch (err) {
        req.log.error({ err }, "List submissions error");
        res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/lesson-plans", requireRole(...LP_READ), async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const { teacherId, classId } = req.query;
        const subjects = await db.select().from(subjectsTable);
        const classes = await db.select().from(classesTable);
        const staff = await db.select().from(staffTable);
        const subjectMap = Object.fromEntries(subjects.map((s) => [s.id, s.name]));
        const classMap = Object.fromEntries(classes.map((c) => [c.id, `${c.grade}-${c.section}`]));
        const staffMap = Object.fromEntries(staff.map((s) => [s.id, s.name]));
        let all = await db.select().from(lessonPlansTable);
        if (req.user.role === "teacher") {
            const me = await resolveStaffForUser(req.user);
            all = me ? all.filter((l) => l.teacherId === me.id) : [];
        }
        if (teacherId)
            all = all.filter((l) => l.teacherId === parseInt(String(teacherId)));
        if (classId)
            all = all.filter((l) => l.classId === parseInt(String(classId)));
        all.sort(newestFirst);
        return res.json(all.map((l) => ({
            ...l,
            fileData: undefined,
            fileUrl: l.fileData ? `/api/lesson-plans/${l.id}/file` : null,
            subjectName: subjectMap[l.subjectId] ?? `Subject ${l.subjectId}`,
            className: classMap[l.classId] ?? `Class ${l.classId}`,
            teacherName: staffMap[l.teacherId] ?? "Teacher",
        })));
    }
    catch (err) {
        req.log.error({ err }, "List lesson plans error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.post("/lesson-plans", requireRole(...LP_WRITE), attachmentUploadMw, async (req, res) => {
    try {
        const data = req.body;
        const staff = await resolveStaffForUser(req.user);
        const [subject] = data.subjectId ? await db.select().from(subjectsTable).where(eq(subjectsTable.id, Number(data.subjectId))) : [];
        const [cls] = data.classId ? await db.select().from(classesTable).where(eq(classesTable.id, Number(data.classId))) : [];
        const requestedTeacherId = Number(data.teacherId);
        const teacherId = req.user?.role === "admin"
            ? (Number.isInteger(requestedTeacherId) && requestedTeacherId > 0 ? requestedTeacherId : Number(subject?.teacherId ?? cls?.teacherId ?? staff?.id ?? 1))
            : staff?.id ?? 1;
        if (req.user?.role === "teacher") {
            if (!staff)
                return res.status(403).json({ error: "Teacher staff profile not found" });
            const { resolveTeacherClassIds } = await import("../lib/scope");
            const classIds = await resolveTeacherClassIds(req.user.id);
            if (!classIds.includes(Number(data.classId))) {
                return res.status(403).json({ error: "Forbidden", details: "Teachers can only create lesson plans for their assigned classes" });
            }
        }
        const file = req.file;
        const fileValues = {};
        if (file) {
            const allowed = [
                "application/pdf",
                "application/msword",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/vnd.ms-powerpoint",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "image/png",
                "image/jpeg",
                "image/jpg",
                "image/webp",
                "text/plain",
                "text/csv",
                "application/vnd.ms-excel",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ];
            if (!allowed.includes(file.mimetype)) {
                return res.status(400).json({ error: "Lesson plan attachment must be PDF, Word, PPT, image, or text" });
            }
            fileValues.fileName = file.originalname.slice(0, 200);
            fileValues.mimeType = file.mimetype;
            fileValues.fileData = file.buffer;
            fileValues.fileSize = String(file.size);
        }
        const [plan] = await db.insert(lessonPlansTable).values({
            title: data.title,
            objectives: data.objectives ?? null,
            content: data.content ?? null,
            subjectId: Number(data.subjectId),
            classId: Number(data.classId),
            teacherId,
            weekDate: data.weekDate,
            duration: data.duration ? Number(data.duration) : null,
            lessonOrder: data.lessonOrder ? Number(data.lessonOrder) : null,
            status: "draft",
            ...fileValues,
        }).returning();
        return res.status(201).json({
            ...plan,
            fileData: undefined,
            fileUrl: plan.fileData ? `/api/lesson-plans/${plan.id}/file` : null,
            subjectName: subject?.name ?? `Subject ${plan.subjectId}`,
            className: cls ? `${cls.grade}-${cls.section}` : `Class ${plan.classId}`,
            teacherName: staff?.name ?? "Teacher",
        });
    }
    catch (err) {
        req.log.error({ err }, "Create lesson plan error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.get("/lesson-plans/:id/file", requireRole(...LP_READ), async (req, res) => {
    try {
        const planId = parseInt(String(req.params.id));
        const [plan] = await db.select().from(lessonPlansTable).where(eq(lessonPlansTable.id, planId));
        if (!plan) {
            return res.status(404).json({ error: "Lesson plan not found" });
        }
        if (!(await ensureLessonPlanWritable(req, res, plan))) {
            return;
        }
        const dbFile = normalizeDbFileData(plan.fileData);
        if (!dbFile) {
            return res.status(404).json({ error: "No file attached" });
        }
        const disposition = req.query.disposition === "attachment" ? "attachment" : "inline";
        res.setHeader("Content-Type", plan.mimeType || "application/octet-stream");
        res.setHeader("Content-Length", String(dbFile.length));
        res.setHeader("Cache-Control", "private, max-age=0");
        res.setHeader("Content-Disposition", `${disposition}; filename="${lessonPlanFileName(plan)}"`);
        return res.end(dbFile);
    }
    catch (err) {
        req.log.error({ err }, "Download lesson plan file error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.patch("/lesson-plans/:id", requireRole(...LP_WRITE), async (req, res) => {
    try {
        const planId = parseInt(String(req.params.id));
        const [existing] = await db.select().from(lessonPlansTable).where(eq(lessonPlansTable.id, planId));
        if (!existing) {
            return res.status(404).json({ error: "Not found" });
        }
        if (req.user?.role === "teacher") {
            const staff = await resolveStaffForUser(req.user);
            if (!staff || existing.teacherId !== staff.id) {
                return res.status(403).json({ error: "Forbidden", details: "You are not authorized to modify this lesson plan" });
            }
        }
        const data = req.body;
        const upd = {};
        if (data.title !== undefined)
            upd.title = data.title;
        if (data.objectives !== undefined)
            upd.objectives = data.objectives;
        if (data.content !== undefined)
            upd.content = data.content;
        if (data.status !== undefined)
            upd.status = data.status;
        const [updated] = await db.update(lessonPlansTable).set(upd).where(eq(lessonPlansTable.id, planId)).returning();
        return res.json({ ...updated, subjectName: `Subject ${updated.subjectId}`, className: `Class ${updated.classId}`, teacherName: "Teacher" });
    }
    catch (err) {
        req.log.error({ err }, "Update lesson plan error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
router.delete("/lesson-plans/:id", requireRole(...LP_WRITE), async (req, res) => {
    try {
        const planId = parseInt(String(req.params.id));
        const [existing] = await db.select().from(lessonPlansTable).where(eq(lessonPlansTable.id, planId));
        if (!existing) {
            return res.status(404).json({ error: "Not found" });
        }
        if (req.user?.role === "teacher") {
            const staff = await resolveStaffForUser(req.user);
            if (!staff || existing.teacherId !== staff.id) {
                return res.status(403).json({ error: "Forbidden", details: "You are not authorized to delete this lesson plan" });
            }
        }
        await db.delete(lessonPlansTable).where(eq(lessonPlansTable.id, planId));
        return res.status(204).send();
    }
    catch (err) {
        req.log.error({ err }, "Delete lesson plan error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/materials/:id/view", requireRole(...MAT_READ), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const [existing] = await db.select().from(studyMaterialsTable).where(eq(studyMaterialsTable.id, id));
        if (!existing) {
            return res.status(404).json({ error: "Material not found" });
        }
        await db.update(studyMaterialsTable).set({ viewCount: (existing.viewCount ?? 0) + 1 }).where(eq(studyMaterialsTable.id, id));
        return res.json({ success: true, viewCount: (existing.viewCount ?? 0) + 1 });
    } catch (err) {
        req.log.error({ err }, "Increment view count error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/materials/:id/download", requireRole(...MAT_READ), async (req, res) => {
    try {
        const id = parseInt(String(req.params.id));
        const [existing] = await db.select().from(studyMaterialsTable).where(eq(studyMaterialsTable.id, id));
        if (!existing) {
            return res.status(404).json({ error: "Material not found" });
        }
        await db.update(studyMaterialsTable).set({ downloadCount: (existing.downloadCount ?? 0) + 1 }).where(eq(studyMaterialsTable.id, id));
        return res.json({ success: true, downloadCount: (existing.downloadCount ?? 0) + 1 });
    } catch (err) {
        req.log.error({ err }, "Increment download count error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
