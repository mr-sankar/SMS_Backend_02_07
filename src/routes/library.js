import { Router } from "express";
import { db } from "@workspace/db";
import {
    libraryBookRequestsTable,
    libraryBooksTable,
    libraryIssuancesTable,
    staffTable,
    studentsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireRole } from "../middlewares/auth";
import { resolveChildrenForParent, resolveStudentForUser } from "../lib/scope";

const router = Router();

const READ_LIB = ["admin", "teacher", "student", "librarian", "parent"];
const LIBRARIAN_ONLY = ["librarian"];

function toIso(value) {
    return value && typeof value.toISOString === "function" ? value.toISOString() : value;
}

// ==================== FINE CALCULATION (₹10 per day) ====================
function calculateFine(issue, returnDateOverride = null) {
    if (!issue) return 0;

    const returnDate = returnDateOverride || issue.returnDate;
    const dueDate = issue.dueDate;

    if (!dueDate) return issue.fine || 0;

    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);

    let endDate;

    if (returnDate) {
        // Book has been returned → calculate fine till actual return date
        endDate = new Date(returnDate);
    } else if (issue.status === "issued" || issue.status === "return_pending" || issue.status === "return_requested") {
        // Still issued or return pending → calculate fine till today
        endDate = new Date();
    } else {
        return issue.fine || 0;
    }

    endDate.setHours(0, 0, 0, 0);

    const diffTime = endDate.getTime() - due.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 3600 * 24));

    return diffDays > 0 ? diffDays * 10 : 0;
}

async function buildLibraryLookups() {
    const books = await db.select().from(libraryBooksTable);
    const students = await db.select().from(studentsTable);
    const staff = await db.select().from(staffTable);

    return {
        books,
        students,
        staff,
        bookMap: Object.fromEntries(books.map((book) => [book.id, book])),
        studentMap: Object.fromEntries(students.map((student) => [student.id, student])),
        staffMap: Object.fromEntries(staff.map((member) => [member.id, member])),
    };
}

function serializeBook(book) {
    return { ...book, createdAt: toIso(book.createdAt) };
}

function serializeIssue(issue, lookups) {
    const book = lookups.bookMap[issue.bookId];
    const student = lookups.studentMap[issue.borrowerId];
    const staff = lookups.staffMap[issue.borrowerId];

    const currentFine = calculateFine(issue);   // Now works correctly

    return {
        ...issue,
        bookTitle: book?.title ?? `Book ${issue.bookId}`,
        borrowerName: issue.borrowerType === "student"
            ? (student?.name ?? `Student ${issue.borrowerId}`)
            : (staff?.name ?? `Staff ${issue.borrowerId}`),
        isOverdue: !issue.returnDate && issue.dueDate < new Date().toISOString().split("T")[0],
        fine: currentFine,
        createdAt: toIso(issue.createdAt),
    };
}

function serializeRequest(request, lookups) {
    const book = lookups.bookMap[request.bookId];
    const student = lookups.studentMap[request.studentId];
    return {
        ...request,
        bookTitle: book?.title ?? `Book ${request.bookId}`,
        bookAuthor: book?.author ?? "",
        bookCategory: book?.category ?? "",
        availableCopies: book?.availableCopies ?? 0,
        studentName: student?.name ?? `Student ${request.studentId}`,
        studentRollNumber: student?.rollNumber ?? "",
        requestedAt: toIso(request.requestedAt),
        handledAt: toIso(request.handledAt),
    };
}

async function scopeIssuesForUser(issues, me) {
    if (me.role === "student") {
        const student = await resolveStudentForUser(me);
        return student
            ? issues.filter((issue) => issue.borrowerType === "student" && issue.borrowerId === student.id)
            : [];
    }
    if (me.role === "parent") {
        const children = await resolveChildrenForParent(me);
        const childIds = new Set(children.map((child) => child.id));
        return issues.filter((issue) => issue.borrowerType === "student" && childIds.has(issue.borrowerId));
    }
    if (me.role === "teacher") {
        const staff = await db.select().from(staffTable);
        const teacher = staff.find((member) => member.userId === me.id);
        return issues.filter((issue) => 
            issue.borrowerType === "student" || 
            (teacher && issue.borrowerType === "staff" && issue.borrowerId === teacher.id)
        );
    }
    return issues;
}

async function scopeRequestsForUser(requests, me) {
    if (me.role === "student") {
        const student = await resolveStudentForUser(me);
        return student ? requests.filter((request) => request.studentId === student.id) : [];
    }
    if (me.role === "parent") {
        const children = await resolveChildrenForParent(me);
        const childIds = new Set(children.map((child) => child.id));
        return requests.filter((request) => childIds.has(request.studentId));
    }
    return requests;
}

// ====================== ROUTES ======================

router.get("/library/books", requireRole(...READ_LIB), async (req, res) => {
    try {
        const { category, status } = req.query;
        let books = await db.select().from(libraryBooksTable);
        if (category) books = books.filter((book) => book.category === String(category));
        if (status) books = books.filter((book) => book.status === String(status));
        return res.json(books.map(serializeBook));
    } catch (err) {
        req.log.error({ err }, "List books error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/library/books", requireRole(...LIBRARIAN_ONLY), async (req, res) => {
    try {
        const data = req.body;
        const [book] = await db.insert(libraryBooksTable).values({
            title: data.title,
            author: data.author,
            isbn: data.isbn ?? null,
            category: data.category,
            totalCopies: data.totalCopies ?? 1,
            availableCopies: data.totalCopies ?? 1,
            publisher: data.publisher ?? null,
            publishYear: data.publishYear ?? null,
            shelfLocation: data.shelfLocation ?? null,
            status: "available",
        }).returning();
        return res.status(201).json(serializeBook(book));
    } catch (err) {
        req.log.error({ err }, "Add book error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.patch("/library/books/:id", requireRole(...LIBRARIAN_ONLY), async (req, res) => {
    try {
        const data = req.body;
        const updateData = {};
        if (data.status !== undefined) updateData.status = data.status;
        if (data.shelfLocation !== undefined) updateData.shelfLocation = data.shelfLocation;
        if (data.availableCopies !== undefined) updateData.availableCopies = data.availableCopies;

        const [updated] = await db.update(libraryBooksTable)
            .set(updateData)
            .where(eq(libraryBooksTable.id, parseInt(String(req.params.id))))
            .returning();

        if (!updated) return res.status(404).json({ error: "Not found" });
        return res.json(serializeBook(updated));
    } catch (err) {
        req.log.error({ err }, "Update book error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/library/books/:id/request", requireRole("student"), async (req, res) => {
    try {
        const bookId = parseInt(String(req.params.id));
        if (Number.isNaN(bookId)) return res.status(400).json({ error: "Invalid book id" });

        const me = req.user;
        const student = await resolveStudentForUser(me);
        if (!student) return res.status(403).json({ error: "Student profile not linked to this account" });

        const [book] = await db.select().from(libraryBooksTable).where(eq(libraryBooksTable.id, bookId));
        if (!book) return res.status(404).json({ error: "Book not found" });

        const existingRequests = await db.select().from(libraryBookRequestsTable);
        const hasPendingRequest = existingRequests.some((r) => 
            r.bookId === bookId && r.studentId === student.id && r.status === "pending"
        );
        if (hasPendingRequest) return res.status(409).json({ error: "You already requested this book" });

        const existingIssues = await db.select().from(libraryIssuancesTable);
        const hasActiveIssue = existingIssues.some((i) => 
            i.bookId === bookId && i.borrowerType === "student" && 
            i.borrowerId === student.id && i.status === "issued"
        );
        if (hasActiveIssue) return res.status(409).json({ error: "This book is already borrowed by you" });

        const [request] = await db.insert(libraryBookRequestsTable).values({
            bookId,
            studentId: student.id,
            status: "pending",
        }).returning();

        const lookups = await buildLibraryLookups();
        return res.status(201).json(serializeRequest(request, lookups));
    } catch (err) {
        req.log.error({ err }, "Request book error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/library/requests", requireRole(...READ_LIB), async (req, res) => {
    try {
        const { status } = req.query;
        const me = req.user;
        if (!me) return res.status(401).json({ error: "Not authenticated" });

        let requests = await db.select().from(libraryBookRequestsTable);
        requests = await scopeRequestsForUser(requests, me);

        if (status) requests = requests.filter((r) => r.status === String(status));

        const lookups = await buildLibraryLookups();
        return res.json(requests.map((request) => serializeRequest(request, lookups)));
    } catch (err) {
        req.log.error({ err }, "List book requests error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/library/requests/:id/issue", requireRole(...LIBRARIAN_ONLY), async (req, res) => {
    try {
        const requestId = parseInt(String(req.params.id));
        if (Number.isNaN(requestId)) return res.status(400).json({ error: "Invalid request id" });

        const issueDate = req.body?.issueDate ?? new Date().toISOString().split("T")[0];
        const dueDate = req.body?.dueDate;
        if (!dueDate) return res.status(400).json({ error: "Due date is required" });

        const [request] = await db.select().from(libraryBookRequestsTable).where(eq(libraryBookRequestsTable.id, requestId));
        if (!request) return res.status(404).json({ error: "Request not found" });
        if (request.status !== "pending") return res.status(400).json({ error: "Only pending requests can be issued" });

        const [book] = await db.select().from(libraryBooksTable).where(eq(libraryBooksTable.id, request.bookId));
        if (!book) return res.status(404).json({ error: "Book not found" });
        if (book.availableCopies <= 0) return res.status(400).json({ error: "No copies available" });

        const result = await db.transaction(async (tx) => {
            const [issuance] = await tx.insert(libraryIssuancesTable).values({
                bookId: request.bookId,
                borrowerId: request.studentId,
                borrowerType: "student",
                issueDate,
                dueDate,
                status: "issued",
                issuedById: req.user.id,
            }).returning();

            await tx.update(libraryBooksTable).set({
                availableCopies: book.availableCopies - 1,
                status: book.availableCopies - 1 === 0 ? "unavailable" : "available",
            }).where(eq(libraryBooksTable.id, request.bookId));

            const [updatedRequest] = await tx.update(libraryBookRequestsTable).set({
                status: "issued",
                handledAt: new Date(),
                handledById: req.user.id,
                issuanceId: issuance.id,
            }).where(eq(libraryBookRequestsTable.id, requestId)).returning();

            return { issuance, request: updatedRequest };
        });

        const lookups = await buildLibraryLookups();
        return res.status(201).json({
            request: serializeRequest(result.request, lookups),
            issuance: serializeIssue(result.issuance, lookups),
        });
    } catch (err) {
        req.log.error({ err }, "Issue requested book error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get("/library/issues", requireRole(...READ_LIB), async (req, res) => {
    try {
        const { status, borrowerType } = req.query;
        const me = req.user;
        if (!me) return res.status(401).json({ error: "Not authenticated" });

        let issues = await db.select().from(libraryIssuancesTable);
        issues = await scopeIssuesForUser(issues, me);

        if (status) issues = issues.filter((issue) => issue.status === String(status));
        if (borrowerType) issues = issues.filter((issue) => issue.borrowerType === String(borrowerType));

        const lookups = await buildLibraryLookups();
        return res.json(issues.map((issue) => serializeIssue(issue, lookups)));
    } catch (err) {
        req.log.error({ err }, "List issuances error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.post("/library/issues", requireRole(...LIBRARIAN_ONLY), async (_req, res) => {
    return res.status(400).json({ error: "Issue books from pending student requests" });
});

router.patch("/library/issues/:id", requireRole("librarian", "student"), async (req, res) => {
    try {
        const issueId = parseInt(String(req.params.id));
        if (Number.isNaN(issueId)) return res.status(400).json({ error: "Invalid issue id" });

        const [issue] = await db.select().from(libraryIssuancesTable)
            .where(eq(libraryIssuancesTable.id, issueId));

        if (!issue) return res.status(404).json({ error: "Issue not found" });

        // Authorization check
        if (req.user.role === "student") {
            const student = await resolveStudentForUser(req.user);
            if (!student || issue.borrowerType !== "student" || issue.borrowerId !== student.id) {
                return res.status(403).json({ error: "Forbidden" });
            }
        }

        const userRole = req.user.role;

        // If student is attempting to return (which is a request for approval)
        if (userRole === "student") {
            if (issue.status !== "issued") {
                return res.status(400).json({ error: `Book is in '${issue.status}' status, cannot request return` });
            }

            const returnDate = req.body?.returnDate 
                ? new Date(req.body.returnDate).toISOString().split("T")[0]
                : new Date().toISOString().split("T")[0];

            const calculatedFine = calculateFine(issue, returnDate);

            // Transition to return_pending
            const [updatedIssue] = await db.update(libraryIssuancesTable)
                .set({
                    returnDate,
                    status: "return_pending",
                    fine: calculatedFine,
                })
                .where(eq(libraryIssuancesTable.id, issueId))
                .returning();

            const lookups = await buildLibraryLookups();
            return res.json(serializeIssue(updatedIssue, lookups));
        }

        // If librarian is attempting to approve a return or return directly
        if (userRole === "librarian") {
            if (issue.status === "returned") {
                return res.status(400).json({ error: "Book is already returned" });
            }

            const returnDate = req.body?.returnDate 
                ? new Date(req.body.returnDate).toISOString().split("T")[0]
                : (issue.returnDate || new Date().toISOString().split("T")[0]);

            const calculatedFine = calculateFine(issue, returnDate);

            const [book] = await db.select().from(libraryBooksTable)
                .where(eq(libraryBooksTable.id, issue.bookId));

            const updated = await db.transaction(async (tx) => {
                // Return the book copy
                if (book) {
                    await tx.update(libraryBooksTable)
                        .set({
                            availableCopies: book.availableCopies + 1,
                            status: "available",
                        })
                        .where(eq(libraryBooksTable.id, issue.bookId));
                }

                // Update issuance with final status and fine
                const [returnedIssue] = await tx.update(libraryIssuancesTable)
                    .set({
                        returnDate,
                        status: "returned",
                        fine: calculatedFine,
                    })
                    .where(eq(libraryIssuancesTable.id, issueId))
                    .returning();

                // Update linked request if exists
                const requests = await tx.select().from(libraryBookRequestsTable);
                const matchingRequest = requests.find((r) => r.issuanceId === issueId);

                if (matchingRequest) {
                    await tx.update(libraryBookRequestsTable)
                        .set({
                            status: "returned",
                            handledAt: new Date(),
                        })
                        .where(eq(libraryBookRequestsTable.id, matchingRequest.id));
                }

                return returnedIssue;
            });

            const lookups = await buildLibraryLookups();
            return res.json(serializeIssue(updated, lookups));
        }

        return res.status(403).json({ error: "Forbidden" });

    } catch (err) {
        req.log.error({ err }, "Return book error");
        return res.status(500).json({ error: "Internal server error" });
    }
});

export default router;