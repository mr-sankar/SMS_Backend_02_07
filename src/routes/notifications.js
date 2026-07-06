import { Router } from "express";
import { db } from "@workspace/db";
import { leaveRequestsTable, admissionsTable, complaintsTable, hostelApplicationsTable, feeRecordsTable, announcementsTable, staffTable, salaryNotificationsTable} from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { resolveStudentForUser, resolveChildrenForParent, resolveOwnClassIds } from "../lib/scope";
const router = Router();
function isActiveAnnouncement(announcement, now = new Date()) {
    const publishAt = announcement.publishAt ? new Date(announcement.publishAt) : null;
    const expiresAt = announcement.expiresAt ? new Date(announcement.expiresAt) : null;
    if (publishAt && publishAt > now)
        return false;
    if (expiresAt && expiresAt <= now)
        return false;
    return true;
}

function announcementAudiencesFor(role) {
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

function compactAnnouncementText(text, maxLength = 120) {
    const compact = String(text ?? "").replace(/\s+/g, " ").trim();
    if (compact.length <= maxLength)
        return compact;
    return `${compact.slice(0, maxLength - 3)}...`;
}

async function canNotifyAnnouncement(announcement, me, now = new Date()) {
    if (!isActiveAnnouncement(announcement, now))
        return false;
    const allowed = announcementAudiencesFor(me.role);
    if (allowed.length > 0 && !allowed.includes(announcement.audience))
        return false;
    if ((me.role === "student" || me.role === "parent") && announcement.classId != null) {
        const ownClassIds = new Set(await resolveOwnClassIds(me));
        if (!ownClassIds.has(announcement.classId))
            return false;
    }
    return true;
}

router.get("/notifications", async (req, res) => {
    try {
        if (!req.user)
            return res.status(401).json({ error: "Not authenticated" });
        const me = req.user;
        const role = me.role;
        const items = [];
        const now = new Date();
        // ── LEAVES ──────────────────────────────────────────────
        if (["admin", "clerk", "teacher", "hostel_warden", "accountant", "transport_manager"].includes(role)) {
            const pendingLeaves = await db
                .select()
                .from(leaveRequestsTable)
                .where(eq(leaveRequestsTable.status, "pending"));
            if (pendingLeaves.length > 0) {
                items.push({
                    id: "leaves-pending",
                    type: "leaves",
                    title: `${pendingLeaves.length} Leave Request${pendingLeaves.length > 1 ? "s" : ""} Pending`,
                    body: "Awaiting your review and approval.",
                    href: "/leaves",
                    severity: "warning",
                    createdAt: pendingLeaves[0].createdAt.toISOString(),
                });
            }
        }
        if (["student", "parent"].includes(role)) {
            let studentIds = [];
            if (role === "student") {
                const s = await resolveStudentForUser(me);
                if (s)
                    studentIds = [s.id];
            }
            else {
                const kids = await resolveChildrenForParent(me);
                studentIds = kids.map(k => k.id);
            }
            if (studentIds.length > 0) {
                const myLeaves = await db
                    .select()
                    .from(leaveRequestsTable)
                    .where(eq(leaveRequestsTable.applicantId, studentIds[0]));
                const approved = myLeaves.filter(l => l.status === "approved");
                const rejected = myLeaves.filter(l => l.status === "rejected");
                if (approved.length > 0) {
                    items.push({
                        id: "leave-approved",
                        type: "leaves",
                        title: "Leave Request Approved",
                        body: `Your ${approved[0].leaveType} leave has been approved.`,
                        href: "/leaves",
                        severity: "info",
                        createdAt: approved[0].createdAt.toISOString(),
                    });
                }
                if (rejected.length > 0) {
                    items.push({
                        id: "leave-rejected",
                        type: "leaves",
                        title: "Leave Request Declined",
                        body: `Your ${rejected[0].leaveType} leave was not approved.`,
                        href: "/leaves",
                        severity: "warning",
                        createdAt: rejected[0].createdAt.toISOString(),
                    });
                }
            }
        }
        // ── ADMISSIONS ──────────────────────────────────────────
        if (["admin", "clerk"].includes(role)) {
            const pendingAdmissions = await db
                .select()
                .from(admissionsTable)
                .where(eq(admissionsTable.status, "pending"));
            if (pendingAdmissions.length > 0) {
                items.push({
                    id: "admissions-pending",
                    type: "admissions",
                    title: `${pendingAdmissions.length} New Admission${pendingAdmissions.length > 1 ? "s" : ""} Pending`,
                    body: "New applications awaiting review.",
                    href: "/admissions",
                    severity: "warning",
                    createdAt: pendingAdmissions[0].appliedAt.toISOString(),
                });
            }
        }
        // ── COMPLAINTS ──────────────────────────────────────────
        if (["admin", "clerk", "hostel_warden"].includes(role)) {
            const openComplaints = await db
                .select()
                .from(complaintsTable)
                .where(eq(complaintsTable.status, "open"));
            if (openComplaints.length > 0) {
                items.push({
                    id: "complaints-open",
                    type: "complaints",
                    title: `${openComplaints.length} Open Complaint${openComplaints.length > 1 ? "s" : ""}`,
                    body: "Unresolved complaints require attention.",
                    href: "/complaints",
                    severity: openComplaints.some(c => c.priority === "high") ? "urgent" : "warning",
                    createdAt: openComplaints[0].createdAt.toISOString(),
                });
            }
        }
        if (["student", "parent", "teacher"].includes(role)) {
            const myComplaints = await db
                .select()
                .from(complaintsTable)
                .where(eq(complaintsTable.submittedById, me.id));
            const resolved = myComplaints.filter(c => c.status === "resolved");
            if (resolved.length > 0) {
                items.push({
                    id: "complaint-resolved",
                    type: "complaints",
                    title: "Complaint Resolved",
                    body: `"${resolved[0].title}" has been resolved.`,
                    href: "/complaints",
                    severity: "info",
                    createdAt: (resolved[0].resolvedAt ?? resolved[0].createdAt).toISOString(),
                });
            }
        }
        // ── HOSTEL APPLICATIONS ─────────────────────────────────
        if (["admin", "hostel_warden"].includes(role)) {
            const pendingHostel = await db
                .select()
                .from(hostelApplicationsTable)
                .where(eq(hostelApplicationsTable.status, "pending"));
            if (pendingHostel.length > 0) {
                items.push({
                    id: "hostel-pending",
                    type: "hostel",
                    title: `${pendingHostel.length} Hostel Application${pendingHostel.length > 1 ? "s" : ""} Pending`,
                    body: "Students awaiting hostel room assignment.",
                    href: "/hostel",
                    severity: "warning",
                    createdAt: pendingHostel[0].appliedAt.toISOString(),
                });
            }
        }
        if (role === "student") {
            const s = await resolveStudentForUser(me);
            if (s) {
                const myApp = await db
                    .select()
                    .from(hostelApplicationsTable)
                    .where(eq(hostelApplicationsTable.studentId, s.id));
                if (myApp.length > 0 && myApp[0].status !== "pending") {
                    items.push({
                        id: "hostel-app-status",
                        type: "hostel",
                        title: `Hostel Application ${myApp[0].status === "approved" ? "Approved" : "Update"}`,
                        body: myApp[0].status === "approved"
                            ? "Your hostel application has been approved!"
                            : `Your hostel application status: ${myApp[0].status}.`,
                        href: "/hostel",
                        severity: myApp[0].status === "approved" ? "info" : "warning",
                        createdAt: myApp[0].appliedAt.toISOString(),
                    });
                }
            }
        }
        // ── OVERDUE FEES ────────────────────────────────────────
        if (["admin", "accountant"].includes(role)) {
            const overdueCount = await db
                .select()
                .from(feeRecordsTable)
                .where(and(eq(feeRecordsTable.status, "overdue")));
            if (overdueCount.length > 0) {
                items.push({
                    id: "fees-overdue",
                    type: "fees",
                    title: `${overdueCount.length} Overdue Fee Record${overdueCount.length > 1 ? "s" : ""}`,
                    body: "Students with overdue payments need follow-up.",
                    href: "/fees",
                    severity: "urgent",
                    createdAt: now.toISOString(),
                });
            }
        }
        if (["student", "parent"].includes(role)) {
            let studentIds = [];
            if (role === "student") {
                const s = await resolveStudentForUser(me);
                if (s)
                    studentIds = [s.id];
            }
            else {
                const kids = await resolveChildrenForParent(me);
                studentIds = kids.map(k => k.id);
            }
            if (studentIds.length > 0) {
                const pendingFees = await db
                    .select()
                    .from(feeRecordsTable)
                    .where(and(eq(feeRecordsTable.studentId, studentIds[0]), eq(feeRecordsTable.status, "pending")));
                if (pendingFees.length > 0) {
                    items.push({
                        id: "fees-due",
                        type: "fees",
                        title: `${pendingFees.length} Fee Payment${pendingFees.length > 1 ? "s" : ""} Due`,
                        body: "You have pending fee payments.",
                        href: "/fees",
                        severity: "warning",
                        createdAt: now.toISOString(),
                    });
                }
            }
        }
        // ── RECENT ANNOUNCEMENTS ────────────────────────────────
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentAnnouncements = await db
            .select()
            .from(announcementsTable)
            .orderBy(desc(announcementsTable.createdAt))
            .limit(10);
        const fresh = [];
        for (const announcement of recentAnnouncements) {
            if (announcement.createdAt > cutoff && await canNotifyAnnouncement(announcement, me, now)) {
                fresh.push(announcement);
            }
        }
        if (fresh.length > 0) {
            const latest = fresh[0];
            const detail = compactAnnouncementText(latest.content);
            items.push({
                id: `announcement-${latest.id}`,
                type: "announcements",
                title: latest.title,
                body: detail || `${fresh.length} new announcement${fresh.length > 1 ? "s" : ""}`,
                href: "/announcements",
                severity: fresh.some(a => a.priority === "urgent") ? "urgent" : "info",
                announcementId: latest.id,
                createdAt: latest.createdAt.toISOString(),
            });
        }
        // ── SALARY NOTIFICATIONS ────────────────────────────────
        const staffRow = await db
            .select()
            .from(staffTable)
            .where(eq(staffTable.userId, me.id));
        if (staffRow[0]) {
            const salNotifications = await db
                .select()
                .from(salaryNotificationsTable)
                .where(and(
                    eq(salaryNotificationsTable.staffId, staffRow[0].id),
                    eq(salaryNotificationsTable.isRead, false)
                ));
            
            for (const n of salNotifications) {
                items.push({
                    id: `salary-notification-${n.id}`,
                    type: "fees",
                    title: n.title,
                    body: n.message,
                    href: "/my-salary",
                    severity: "info",
                    createdAt: n.createdAt.toISOString(),
                });
            }
        }
        items.sort((a, b) => {
            const sev = { urgent: 0, warning: 1, info: 2 };
            return sev[a.severity] - sev[b.severity];
        });
        return res.json({ items, total: items.length });
    }
    catch (err) {
        req.log.error({ err }, "Notifications error");
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
