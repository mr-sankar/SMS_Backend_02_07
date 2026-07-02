import { db } from "@workspace/db";
import { studentsTable, staffTable, classesTable, subjectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
// AUTHORITATIVE student linkage. The students table has:
//   - userId  → primary link from auth user → student
//   - email   → student's own email; only used as fallback when it matches
//               the user's email (still a self→self match, never cross-user)
// We intentionally do NOT cross-reference fields between unrelated users.
export async function resolveStudentForUser(me) {
    const rows = await db.select().from(studentsTable);
    const byUserId = rows.find((s) => s.userId === me.id);
    if (byUserId)
        return byUserId;
    // Fallback: student.email === user.email (own email → own student). Only
    // safe when both sides are non-empty.
    if (me.email) {
        const byEmail = rows.find((s) => s.email && s.email === me.email);
        if (byEmail)
            return byEmail;
    }
    return null;
}
// AUTHORITATIVE parent → children linkage. The only schema-level field linking
// a parent user to student rows is `students.parentPhone`. We deliberately do
// NOT match against `students.email` (that is the student's own email and
// cross-referencing it to the parent user's email can authorize unrelated
// students whose own email happens to collide with the parent's).
export async function resolveChildrenForParent(me) {
    if (!me.phone)
        return [];
    const rows = await db.select().from(studentsTable);
    return rows.filter((s) => s.parentPhone && s.parentPhone === me.phone);
}
export async function resolveOwnStudentIds(me) {
    if (me.role === "student") {
        const s = await resolveStudentForUser(me);
        return s ? [s.id] : [];
    }
    if (me.role === "parent") {
        const kids = await resolveChildrenForParent(me);
        return kids.map((k) => k.id);
    }
    return [];
}
export async function resolveOwnClassIds(me) {
    if (me.role === "student") {
        const s = await resolveStudentForUser(me);
        return s?.classId ? [s.classId] : [];
    }
    if (me.role === "parent") {
        const kids = await resolveChildrenForParent(me);
        return [...new Set(kids.map((k) => k.classId).filter((c) => !!c))];
    }
    return [];
}
export async function resolveTeacherClassIds(userId) {
    const staff = await db.select().from(staffTable).where(eq(staffTable.userId, userId));
    const myStaff = staff[0];
    if (!myStaff)
        return [];
    const ownClasses = await db.select().from(classesTable).where(eq(classesTable.teacherId, myStaff.id));
    const ids = new Set(ownClasses.map((c) => c.id));
    const subjectClasses = await db.select().from(subjectsTable).where(eq(subjectsTable.teacherId, myStaff.id));
    for (const s of subjectClasses) {
        if (s.classId)
            ids.add(s.classId);
    }
    return Array.from(ids);
}
